// orchestrator.ts — runs the canonical abort → wait → revert → prompt
// replay sequence when a fallback is triggered.
//
// Acquire lock → dedup check → resolve chain → pick next healthy model →
// mark previous unhealthy → abort → sleep abortWaitMs → revert →
// prompt(next). Always releases the lock in `finally`.

import type { Logger } from "../logging/logger.ts";
import { resolveFallbackModel } from "../resolution/fallback-resolver.ts";
import type { FallbackStore } from "../state/store.ts";
import type { ErrorCategory, ModelKey, PluginConfig, ReplayResult } from "../types.ts";
import { isRecord, messageInfo, messageParts, unwrapSdkData } from "../utils/type-guards.ts";
import { extractContextSummary } from "./context-summary.ts";
import { convertPartsForPrompt, type Part } from "./message-converter.ts";

// Narrow client surface used here. Tests stub via MockClient.
export interface OrchestratorClient {
  session: {
    messages(args: unknown): Promise<unknown>;
    abort(args: unknown): Promise<unknown>;
    revert(args: unknown): Promise<unknown>;
    prompt(args: unknown): Promise<unknown>;
    // session.get is used to detect subagent sessions (presence of
    // parentID) so the orchestrator can short-circuit recovery for
    // sessions whose cancel events propagate terminally to the parent
    // Task tool. Returns the session info envelope; callers unwrap.
    get(args: unknown): Promise<unknown>;
  };
}

export interface AttemptFallbackArgs {
  sessionId: string;
  reason: ErrorCategory;
  chain: ModelKey[];
  client: OrchestratorClient;
  store: FallbackStore;
  config: PluginConfig;
  logger: Logger;
  // sleepMs is a test seam — production passes undefined and uses setTimeout.
  sleepMs?: (ms: number) => Promise<void>;
  // When true, the session is a subagent (child of another session via
  // parentID). Subagent sessions are observed by the parent's Task tool,
  // which treats any cancel event (including the auto-cancel OpenCode
  // emits on stream error) as terminal — so the abort→revert→prompt
  // recovery sequence is wasted work: the parent will already have
  // declared the task failed and spawned a replacement. Instead, just
  // mark the model unhealthy (so the replacement spawn gets preemptively
  // redirected to the next healthy chain entry via chat.message) and
  // return without recovering.
  isSubagent?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

interface LastUserMessage {
  messageID: string | null;
  parts: Part[];
  agent: string | null;
}

// Walk messages newest-first; the most recent role=user message is the one
// we need to revert past and re-prompt. Returns null if not found.
function findLastUserMessage(messages: unknown[]): LastUserMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messageInfo(messages[i]);
    if (!info) continue;
    const role = info.role;
    if (role !== "user") continue;
    const id = info.id ?? info.messageID;
    const parts = messageParts(messages[i]);
    const agent = info.agent;
    return {
      messageID: typeof id === "string" ? id : null,
      parts,
      agent: typeof agent === "string" ? agent : null,
    };
  }
  return null;
}

// Walks messages array AFTER lastUserMessageID and returns the latest
// assistant message ID with empty parts — i.e., the blank assistant shell
// OpenCode created before the LLM call failed. Used solely to enrich the
// fallback.success log so operators can correlate fallback events with
// `opencode-session-doctor`'s blank-row detection (SQL pattern: role=assistant
// AND finish IS NULL AND 0 parts).
//
// Defensive: any unexpected shape or throw degrades to `undefined` — the
// fallback flow must never block on log enrichment.
//
// Supports BOTH OpenCode message shapes:
//   - flat:    { id, role, parts }
//   - nested:  { info: { id, role }, parts }
function findOrphanCandidate(messages: unknown[], lastUserMessageID: string): string | undefined {
  try {
    let sawLastUser = false;
    let candidate: string | undefined;
    for (const item of messages) {
      if (!isRecord(item)) continue;
      const info = isRecord(item.info) ? item.info : item;
      const id = typeof info.id === "string" ? info.id : undefined;
      const role = typeof info.role === "string" ? info.role : undefined;
      const parts = Array.isArray(item.parts)
        ? item.parts
        : Array.isArray(info.parts)
          ? info.parts
          : [];
      if (!sawLastUser) {
        if (id === lastUserMessageID) sawLastUser = true;
        continue;
      }
      if (role === "assistant" && parts.length === 0 && id) {
        candidate = id; // latest wins (highest index after lastUser)
      }
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function parseModelKey(key: ModelKey): { providerID: string; modelID: string } {
  const i = key.indexOf("/");
  return {
    providerID: key.slice(0, i),
    modelID: key.slice(i + 1),
  };
}

/**
 * attemptFallback executes the abort→revert→prompt sequence. Returns
 * structured ReplayResult — never throws. All error paths log + release
 * the lock + return success:false with an error message.
 */
export async function attemptFallback(args: AttemptFallbackArgs): Promise<ReplayResult> {
  const { sessionId, reason, chain, client, store, config, logger } = args;
  const sleep = args.sleepMs ?? defaultSleep;

  if (!store.acquireLock(sessionId)) {
    logger.debug("fallback.skipped.locked", { sessionId, reason });
    return { success: false, error: "already processing" };
  }

  try {
    if (store.sessions.isInDedupWindow(sessionId, config.dedupWindowMs)) {
      logger.debug("fallback.skipped.dedup", { sessionId, reason });
      return { success: false, error: "dedup window" };
    }

    if (chain.length === 0) {
      logger.debug("fallback.skipped.empty_chain", { sessionId });
      return { success: false, error: "no chain" };
    }

    const state = store.sessions.get(sessionId);
    const current = state.currentModel;

    const next = resolveFallbackModel(current, chain, state.fallbackDepth, store.health, config.maxDepth);
    if (!next) {
      logger.warn("fallback.exhausted", {
        sessionId,
        depth: state.fallbackDepth,
        maxDepth: config.maxDepth,
        chain,
      });
      return { success: false, error: "exhausted" };
    }

    // Category-aware cooldown: prefer per-category override when configured,
    // otherwise fall through to the default cooldownMs. Applied uniformly
    // to both subagent-skip and full-recovery paths — a quota_exhausted
    // marker must outlast the default 5-minute window to break the thrash
    // cycle where cooldown expires, the model is retried, fails again
    // immediately (quota hasn't actually recovered), and re-triggers
    // fallback.
    const cooldownMs = config.cooldownMsByCategory?.[reason] ?? config.cooldownMs;
    if (current) {
      store.health.cooldown(current, cooldownMs, reason);
    }

    // Subagent short-circuit: mark unhealthy and exit without recovering.
    // The parent Task tool observes the stream-error cancel as terminal
    // regardless of what OMR does here, so abort→revert→prompt would be
    // orphaned work. Marking the model unhealthy with the category-aware
    // cooldown ensures the parent's replacement spawn hits preemptive
    // redirect on chat.message and starts cleanly on the fallback model.
    if (args.isSubagent) {
      logger.info("fallback.subagent_skip", {
        sessionId,
        from: current,
        reason,
        cooldownMs,
        nextHealthy: next,
      });
      // Still advance depth/original-model bookkeeping so a later
      // same-session event (rare but possible) doesn't re-enter recovery.
      state.currentModel = next;
      state.fallbackDepth += 1;
      state.lastFallbackAt = Date.now();
      if (!state.originalModel && current) state.originalModel = current;
      return { success: true, fallbackModel: next, fromModel: current, subagentSkipped: true };
    }

    let messages: unknown[];
    try {
      const response = await client.session.messages({ path: { id: sessionId } } as never);
      const data = unwrapSdkData(response);
      messages = Array.isArray(data) ? data : [];
    } catch (err) {
      logger.error("fallback.messages_failed", { sessionId, err: errorSummary(err) });
      return { success: false, error: "messages failed" };
    }
    const lastUser = findLastUserMessage(messages);
    if (!lastUser || !lastUser.messageID) {
      logger.warn("fallback.no_user_message", { sessionId });
      return { success: false, error: "no user message" };
    }

    // Capture orphan candidate BEFORE abort/revert — the messages snapshot
    // we already have reflects pre-revert state; subsequent fetches may show
    // different visibility/ordering after revert sets its pointer.
    const orphanMessageId = findOrphanCandidate(messages, lastUser.messageID);

    // Build the prompt parts. When preserveContext is enabled and the failed
    // turn left assistant work (tool calls / text) after the last user message,
    // prepend a recovery summary so the next model continues from where the
    // previous one stopped instead of restarting from the bare user prompt.
    // Computed from the same pre-revert snapshot as the orphan capture.
    // Graceful: empty summary (no work, or any extraction failure) → bare
    // prompt, identical to the pre-feature behaviour. Fallback must never block
    // on context enrichment.
    let promptParts: Part[] = convertPartsForPrompt(lastUser.parts);
    if (config.preserveContext === true) {
      const summary = extractContextSummary(messages, lastUser.messageID);
      if (summary.length > 0) {
        const failedModel = current ?? "unknown";
        const recoveryPart: Part = {
          type: "text",
          text:
            `[Context Recovery — auto-generated from failed turn, verify before acting] ` +
            `Previous model (${failedModel}) failed mid-turn. ` +
            `Assistant work already attempted in the failed turn:\n${summary}\n` +
            `Do not blindly re-execute; verify current state before continuing.`,
        };
        promptParts = [recoveryPart, ...promptParts];
      }
    }

    try {
      await client.session.abort({ path: { id: sessionId } } as never);
    } catch (err) {
      logger.error("fallback.abort_failed", { sessionId, err: errorSummary(err) });
      return { success: false, error: "abort failed" };
    }

    await sleep(config.abortWaitMs);

    try {
      await client.session.revert({ path: { id: sessionId }, body: { messageID: lastUser.messageID } } as never);
    } catch (err) {
      logger.error("fallback.revert_failed", { sessionId, err: errorSummary(err) });
      return { success: false, error: "revert failed" };
    }

    const { providerID, modelID } = parseModelKey(next);
    const agentName = lastUser.agent ?? state.agentName ?? undefined;

    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          parts: promptParts,
          agent: agentName,
        },
      } as never);
    } catch (err) {
      logger.error("fallback.prompt_failed", { sessionId, err: errorSummary(err) });
      return { success: false, error: "prompt failed" };
    }

    // Success — update session state.
    state.currentModel = next;
    state.fallbackDepth += 1;
    state.lastFallbackAt = Date.now();
    if (!state.originalModel && current) state.originalModel = current;

    const successPayload: Record<string, unknown> = {
      sessionId,
      from: current,
      to: next,
      reason,
      depth: state.fallbackDepth,
    };
    // Only attach orphanMessageId when actually detected — avoids fabricating
    // IDs and keeps the log payload clean for operators searching for orphans.
    // Field name uses camelCase to match existing fallback.success keys
    // (sessionId, from, to, reason, depth) per repo convention; doctor SQL
    // correlation uses message-row shape (role + parts) not the log field name.
    if (orphanMessageId !== undefined) {
      successPayload.orphanMessageId = orphanMessageId;
    }
    logger.info("fallback.success", successPayload);

    return { success: true, fallbackModel: next, fromModel: current };
  } finally {
    store.releaseLock(sessionId);
  }
}
