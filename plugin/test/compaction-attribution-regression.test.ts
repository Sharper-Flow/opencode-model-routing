// Compaction-attribution regression tests (2026-10-07 incident,
// obs:878ff4a981284b5e / obs:8fb6da563f758e5f).
//
// Incident shape: a session serving openai/gpt-6.1-sol auto-compacted with
// agent.compaction pinned to minimax-coding-plan/MiniMax-M3. M3 hit its
// Token Plan quota and the failure surfaced as model-less session.status
// retry signals. OMR attributed them to the session's serving model
// (orchestrator cooldownTarget = failedModel ?? lastServedModel ?? current),
// benching the healthy sol and rotating the parent session.
//
// Post-fix contract:
//   - Open assistant message rows (persisted by the host before the request
//     is processed, compaction included) are tracked as in-flight calls.
//   - A model-less signal attributes to the unique open call whose provider
//     matches action.provider, or to the single open call when no provider
//     token is present. No unique call → unattributed: no cooldown, no
//     rotation, ever.
//   - When the attributed call's agent differs from the session's tracked
//     agent (compaction vs conversation), only the failing model is cooled.
//     Parent currentModel/lastServedModel/fallbackDepth, the TTFT timer,
//     and the replay tail (abort/revert/prompt) stay untouched.
//   - Unpinned compaction follows the session model: the failure cools the
//     session model without rotating the parent; the next chat.message is
//     preemptively redirected to a healthy rung.

import { describe, test, expect } from "bun:test";
import {
  confirmOpenCallFromChatParams,
  createPluginContext,
  handleEvent,
  handleChatMessage,
  type EventInputShape,
} from "../src/plugin-internal.ts";
import { createLogger, type Logger } from "../src/logging/logger.ts";
import { MockClient } from "./helpers/mock-client.ts";
import type { ModelKey } from "../src/types.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

const SESSION_AGENT = "build";
const COMPACTION_AGENT = "compaction";
// Y — the healthy model serving the parent session's conversation.
const SOL = "openai/gpt-6.1-sol" as ModelKey;
// X — the model pinned onto agent.compaction that actually failed.
const M3 = "minimax-coding-plan/MiniMax-M3" as ModelKey;
// Next healthy rung of the session agent's chain.
const LUNA = "openai/gpt-6-luna" as ModelKey;
const CHAIN: ModelKey[] = [SOL, LUNA];

function modelOf(key: ModelKey): { providerID: string; modelID: string } {
  const slash = key.indexOf("/");
  return { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) };
}

function makeCtx(logger: Logger = silentLogger) {
  const ctx = createPluginContext({
    logger,
    // Keep TTFT armed through the test without risking a real 60s timer
    // firing into the timeout path after assertions complete.
    config: { ttftMs: 3_600_000 },
  });
  ctx.chains.set(SESSION_AGENT, CHAIN);
  return ctx;
}

function makeClient(sessionId: string) {
  return new MockClient({
    messages: [
      {
        info: { id: "msg-1", role: "user", agent: SESSION_AGENT },
        parts: [{ type: "text", text: "ship the fix" }],
      },
    ],
    sessionInfo: { id: sessionId },
  });
}

// The assistant row the host persists BEFORE processing a request — the
// authoritative in-flight marker (message.updated arrival).
function assistantRowEvent(
  sessionId: string,
  messageId: string,
  agent: string,
  model: ModelKey,
): EventInputShape {
  const { providerID, modelID } = modelOf(model);
  return {
    type: "message.updated",
    properties: {
      sessionID: sessionId,
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant",
        agent,
        providerID,
        modelID,
      },
    },
  };
}

// Model-less retry status — the incident's only signal class. Carries the
// typed reason plus (optionally) the action.provider token.
function modelLessRetryStatus(
  sessionId: string,
  provider?: string,
): EventInputShape {
  return {
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: {
        type: "retry",
        message: "AI_APICallError: Token Plan usage limit reached (2056)",
        action: provider
          ? { reason: "free_tier_limit", provider }
          : { reason: "free_tier_limit" },
      },
    },
  };
}

// The persisted terminal copy of the same failure — carries identity.
function quotaErrorCopyEvent(
  sessionId: string,
  messageId: string,
  agent: string,
  model: ModelKey,
): EventInputShape {
  const { providerID, modelID } = modelOf(model);
  return {
    type: "message.updated",
    properties: {
      sessionID: sessionId,
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant",
        agent,
        providerID,
        modelID,
        error: {
          name: "AI_APICallError",
          data: {
            message:
              "Token Plan usage limit reached: Upgrade your Token Plan (2056)",
            statusCode: 429,
            isRetryable: false,
          },
        },
      },
    },
  };
}

// Model-less session.error equivalent (no provider token).
function modelLessSessionError(sessionId: string): EventInputShape {
  return {
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: {
        name: "AI_APICallError",
        data: {
          message: "Token Plan usage limit reached (2056)",
          statusCode: 429,
          isRetryable: true,
        },
      },
    },
  };
}

async function serveOn(
  ctx: ReturnType<typeof makeCtx>,
  client: MockClient,
  sessionId: string,
  model: ModelKey,
): Promise<void> {
  const { providerID, modelID } = modelOf(model);
  await handleChatMessage(
    ctx,
    client,
    { sessionID: sessionId, agent: SESSION_AGENT },
    {
      message: { model: { providerID, modelID } },
    },
  );
}

interface ParentStateSnapshot {
  currentModel: ModelKey | null;
  lastServedModel: ModelKey | null;
  originalModel: ModelKey | null;
  fallbackDepth: number;
  lastFallbackAt: number;
}

function parentState(
  ctx: ReturnType<typeof makeCtx>,
  sessionId: string,
): ParentStateSnapshot {
  const s = ctx.store.sessions.get(sessionId);
  return {
    currentModel: s.currentModel,
    lastServedModel: s.lastServedModel,
    originalModel: s.originalModel,
    fallbackDepth: s.fallbackDepth,
    lastFallbackAt: s.lastFallbackAt,
  };
}

function expectParentUntouched(
  ctx: ReturnType<typeof makeCtx>,
  sessionId: string,
): void {
  expect(parentState(ctx, sessionId)).toEqual({
    currentModel: SOL,
    lastServedModel: SOL,
    originalModel: SOL,
    fallbackDepth: 0,
    lastFallbackAt: 0,
  });
}

describe("compaction attribution regression (2026-10-07 incident)", () => {
  test("pinned compaction quota failure via model-less retry cools M3 only; parent untouched", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      minLevel: "debug",
      write: (l) => lines.push(l),
    });
    const ctx = makeCtx(logger);
    const sessionId = "ses_incident_1";
    const client = makeClient(sessionId);

    // Conversation serving sol on the session agent.
    await serveOn(ctx, client, sessionId, SOL);
    expect(ctx.ttft.has(sessionId)).toBe(true);

    // Auto-compaction begins: the host persists the compaction assistant
    // row (agent=compaction, pinned model M3) before processing it.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_compact_1", COMPACTION_AGENT, M3),
    );

    // M3 quota failure surfaces as a model-less retry status whose only
    // identity token is action.provider.
    await handleEvent(
      ctx,
      client,
      modelLessRetryStatus(sessionId, "minimax-coding-plan"),
    );

    // X (M3) gets the cooldown; Y (sol) and the rest get none.
    expect(ctx.store.health.isInCooldown(M3)).toBe(true);
    expect(ctx.store.health.isInCooldown(SOL)).toBe(false);
    expect(ctx.store.health.isInCooldown(LUNA)).toBe(false);
    // No replay tail: the parent session is not aborted/reverted/re-prompted.
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    // Parent bookkeeping untouched, TTFT timer still armed for the
    // conversation's own call.
    expectParentUntouched(ctx, sessionId);
    expect(ctx.ttft.has(sessionId)).toBe(true);
    // The isolated cooldown is observable in the log.
    expect(lines.some((l) => l.includes('"failure.isolated_cooldown"'))).toBe(
      true,
    );
  });

  test("status-then-message.updated pair attributes both copies to the compaction model", async () => {
    const ctx = makeCtx();
    const sessionId = "ses_incident_2";
    const client = makeClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_compact_2", COMPACTION_AGENT, M3),
    );

    // First copy: model-less retry status (attributed through the open row).
    await handleEvent(
      ctx,
      client,
      modelLessRetryStatus(sessionId, "minimax-coding-plan"),
    );
    // Second copy: the persisted identity-carrying terminal error.
    await handleEvent(
      ctx,
      client,
      quotaErrorCopyEvent(sessionId, "msg_compact_2", COMPACTION_AGENT, M3),
    );

    // Both copies net-attribute to M3 — one cooldown, no second dispatch,
    // no rotation of the parent.
    expect(ctx.store.health.isInCooldown(M3)).toBe(true);
    expect(ctx.store.health.isInCooldown(SOL)).toBe(false);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expectParentUntouched(ctx, sessionId);
  });

  test("message.updated-first then model-less retry status: same single attribution", async () => {
    const ctx = makeCtx();
    const sessionId = "ses_incident_3";
    const client = makeClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_compact_3", COMPACTION_AGENT, M3),
    );

    // Identity-carrying terminal copy arrives first.
    await handleEvent(
      ctx,
      client,
      quotaErrorCopyEvent(sessionId, "msg_compact_3", COMPACTION_AGENT, M3),
    );
    expect(ctx.store.health.isInCooldown(M3)).toBe(true);
    expect(ctx.store.health.isInCooldown(SOL)).toBe(false);

    // The later model-less retry copy (a host retry of the same call) is
    // deduped: no second dispatch, no rotation.
    await handleEvent(
      ctx,
      client,
      modelLessRetryStatus(sessionId, "minimax-coding-plan"),
    );
    expect(ctx.store.health.isInCooldown(SOL)).toBe(false);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expectParentUntouched(ctx, sessionId);
  });

  test("ambiguous multi-open-call signal attributes nothing", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      minLevel: "debug",
      write: (l) => lines.push(l),
    });
    const ctx = makeCtx(logger);
    const sessionId = "ses_incident_4";
    const client = makeClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);

    // Two open calls: the conversation's own row and a compaction row.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_main_4", SESSION_AGENT, SOL),
    );
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_compact_4", COMPACTION_AGENT, M3),
    );

    // No provider token → cannot disambiguate → unattributed.
    await handleEvent(ctx, client, modelLessRetryStatus(sessionId));
    // Provider token matching no open call → unattributed.
    await handleEvent(
      ctx,
      client,
      modelLessRetryStatus(sessionId, "anthropic"),
    );

    // NO cooldown on any model, no rotation, parent untouched.
    expect(ctx.store.health.isInCooldown(M3)).toBe(false);
    expect(ctx.store.health.isInCooldown(SOL)).toBe(false);
    expect(ctx.store.health.isInCooldown(LUNA)).toBe(false);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expectParentUntouched(ctx, sessionId);
    // The unattributed signals are logged, not silently dropped.
    const unattributed = lines.filter((l) =>
      l.includes('"failure.unattributed"'),
    );
    expect(unattributed.length).toBe(2);
  });

  test("single-open-call main-conversation failure still attributes and rotates as before", async () => {
    const ctx = makeCtx();
    const sessionId = "ses_incident_5";
    const client = makeClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);
    // The conversation's own assistant row is the only open call.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_main_5", SESSION_AGENT, SOL),
    );

    // Model-less session.error (no provider token): the single open call is
    // the session's own call → existing recovery runs unchanged.
    await handleEvent(ctx, client, modelLessSessionError(sessionId));

    expect(ctx.store.health.isInCooldown(SOL)).toBe(true);
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.revert")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    const state = ctx.store.sessions.get(sessionId);
    expect(state.currentModel).toBe(LUNA);
    expect(state.fallbackDepth).toBe(1);
    // The failed model got the cooldown, not the replacement.
    expect(ctx.store.health.isInCooldown(LUNA)).toBe(false);
    ctx.ttft.clear(sessionId);
  });

  test("unpinned compaction failure on the session model cools it without parent rotation", async () => {
    const ctx = makeCtx();
    const sessionId = "ses_incident_6";
    const client = makeClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);
    // Unpinned compaction follows the session model; its row still belongs
    // to the compaction agent.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_compact_6", COMPACTION_AGENT, SOL),
    );

    await handleEvent(ctx, client, modelLessRetryStatus(sessionId));

    // The session model is cooled (it really failed)…
    expect(ctx.store.health.isInCooldown(SOL)).toBe(true);
    expect(ctx.store.health.isInCooldown(LUNA)).toBe(false);
    // …but the parent is not rotated and its state stays untouched.
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expectParentUntouched(ctx, sessionId);

    // The next use is covered by the existing preemptive redirect.
    const { providerID, modelID } = modelOf(LUNA);
    const output = {
      message: { model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
    };
    await handleChatMessage(
      ctx,
      client,
      { sessionID: sessionId, agent: SESSION_AGENT },
      output,
    );
    expect(output.message.model).toEqual({ providerID, modelID });
    ctx.ttft.clear(sessionId);
  });

  test("chat.params confirm lets an agent-less compaction row adopt its agent and isolate", async () => {
    const ctx = makeCtx();
    const sessionId = "ses_incident_7";
    const client = makeClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);

    // An older host may persist the row without an agent field.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_compact_7", "", M3),
    );

    // chat.params fires per request (compaction included) and carries the
    // request's agent + model — the record adopts the agent.
    confirmOpenCallFromChatParams(ctx, {
      sessionID: sessionId,
      agent: COMPACTION_AGENT,
      model: { providerID: "minimax-coding-plan", id: "MiniMax-M3" },
    });

    await handleEvent(ctx, client, modelLessRetryStatus(sessionId));

    expect(ctx.store.health.isInCooldown(M3)).toBe(true);
    expect(ctx.store.health.isInCooldown(SOL)).toBe(false);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expectParentUntouched(ctx, sessionId);
  });

  test("in-flight records close on completion, compaction end, idle, and removal", async () => {
    const ctx = makeCtx();
    const sessionId = "ses_incident_8";
    const client = makeClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);

    // A completed row (time.completed set) never opens a record.
    await handleEvent(ctx, client, {
      type: "message.updated",
      properties: {
        sessionID: sessionId,
        info: {
          id: "msg_done_8",
          sessionID: sessionId,
          role: "assistant",
          agent: COMPACTION_AGENT,
          providerID: "minimax-coding-plan",
          modelID: "MiniMax-M3",
          time: { created: Date.now() - 1000, completed: Date.now() },
        },
      },
    });
    expect(ctx.calls.openCalls(sessionId)).toHaveLength(0);

    // Open row → session.compacted closes the compaction agent's records.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_compact_8", COMPACTION_AGENT, M3),
    );
    expect(ctx.calls.openCalls(sessionId)).toHaveLength(1);
    await handleEvent(ctx, client, {
      type: "session.compacted",
      properties: { sessionID: sessionId },
    });
    expect(ctx.calls.openCalls(sessionId)).toHaveLength(0);

    // Open row → message.removed closes that row's record.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_removed_8", COMPACTION_AGENT, M3),
    );
    await handleEvent(ctx, client, {
      type: "message.removed",
      properties: { sessionID: sessionId, messageID: "msg_removed_8" },
    });
    expect(ctx.calls.openCalls(sessionId)).toHaveLength(0);

    // Open row → session.idle drains every open record for the session.
    await handleEvent(
      ctx,
      client,
      assistantRowEvent(sessionId, "msg_idle_8", COMPACTION_AGENT, M3),
    );
    await handleEvent(ctx, client, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
    expect(ctx.calls.openCalls(sessionId)).toHaveLength(0);
    ctx.ttft.clear(sessionId);
  });
});
