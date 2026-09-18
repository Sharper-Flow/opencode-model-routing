// preemptive.ts — chat.message hook helper.
//
// Before each user round starts, check whether the model OpenCode is about to
// use is currently in cooldown or blocked for this agent. If cooled, mutate
// `output.message.model` to the next healthy entry in the agent's chain. If
// blocked (agents.<name>.blocked_models), redirect to the first chain entry
// that is healthy and not blocked, regardless of the current model's cooldown
// state. No abort/revert needed — the user's first attempt simply starts on
// the allowed model.

import type { Logger } from "./logging/logger.ts";
import { resolveFallbackModel } from "./resolution/fallback-resolver.ts";
import type { FallbackStore } from "./state/store.ts";
import type { ModelKey, PluginConfig } from "./types.ts";
import { claudeUnavailableVeto } from "./availability/preflight.ts";
import type { AvailabilitySnapshotV1 } from "./availability/snapshot.ts";

// What the chat.message hook gives us in `output.message.model`. OpenCode
// uses { providerID, modelID } as the canonical shape.
export interface OutputModel {
  providerID: string;
  modelID: string;
}

export interface PreemptiveInput {
  sessionId: string;
  agentName: string | null;
  output: { message: { model?: OutputModel } };
  // Availability snapshot for the current turn (the same descriptor-validated
  // read the preflight consumed). An `unavailable` snapshot vetoes Anthropic
  // candidates in the rotation scan below, so a cooldown-driven redirect
  // cannot land the session on a provider the snapshot already knows is dead.
  snapshot?: AvailabilitySnapshotV1 | null;
}

export function applyPreemptiveSkip(
  input: PreemptiveInput,
  store: FallbackStore,
  chains: Map<string, ModelKey[]>,
  config: PluginConfig,
  logger: Logger,
  blocked?: ReadonlyMap<string, ReadonlySet<ModelKey>>,
): void {
  const current = input.output.message.model;
  if (!current) return;
  const key = `${current.providerID}/${current.modelID}` as ModelKey;

  // Mutate output.message.model to the allowed target and record it as the
  // session-current model. Shared by the blocklist redirect and the cooldown
  // redirect so both leave identical bookkeeping.
  const redirect = (next: ModelKey, reason: "blocked" | "cooldown"): void => {
    const parsed = next.split("/");
    if (parsed.length < 2) return;
    input.output.message.model = {
      providerID: parsed[0]!,
      modelID: parsed.slice(1).join("/"),
    };
    const state = store.sessions.get(input.sessionId);
    state.currentModel = next;
    logger.info("preemptive.redirected", {
      sessionId: input.sessionId,
      from: key,
      to: next,
      agent: input.agentName,
      reason,
    });
  };

  let chain: ModelKey[] | undefined;
  if (input.agentName) {
    const blocklist = blocked?.get(input.agentName);
    if (blocklist?.has(key)) {
      // Blocked current model: redirect regardless of the current model's
      // cooldown state. Scan the whole chain from the top for the first
      // entry that is healthy AND not blocked (currentModel=null starts the
      // shared resolver at index 0).
      const next = resolveFallbackModel(
        null,
        chains.get(input.agentName) ?? [],
        0,
        store.health,
        config.maxDepth,
        blocklist,
        claudeUnavailableVeto(input.snapshot ?? null) ?? undefined,
      );
      if (!next) {
        // Every alternative is blocked or cooled (or no chain is configured).
        // Fail open: keep the user's selection and log the misconfiguration —
        // a hard failure would kill the session for want of a model.
        logger.warn("preemptive.no_allowed_model", {
          sessionId: input.sessionId,
          agent: input.agentName,
          current: key,
        });
        return;
      }
      redirect(next, "blocked");
      return;
    }
    chain = chains.get(input.agentName);
    if (!chain || chain.length === 0) return;
  } else {
    // A structurally resolved agent should always be available for production
    // child sessions. If every source is temporarily unavailable, only use a
    // chain when the cooled model belongs to exactly one configured chain.
    // Selecting among multiple matching agents would be heuristic routing.
    // The blocklist stays inactive here with the agent identity: applying a
    // guessed agent's blocklist would be the same heuristic this guard
    // refuses.
    if (!store.health.isInCooldown(key)) return;
    const matches = [...chains.values()].filter((candidate) =>
      candidate.includes(key),
    );
    if (matches.length !== 1) {
      logger.error("identity_unavailable.ambiguous_cooled_dispatch", {
        sessionId: input.sessionId,
        current: key,
        matchingChainCount: matches.length,
      });
      return;
    }
    chain = matches[0]!;
  }

  if (!store.health.isInCooldown(key)) {
    // Healthy — leave the user's selection alone.
    // Also remember this is our session-current.
    const state = store.sessions.get(input.sessionId);
    if (!state.currentModel) {
      state.currentModel = key;
      state.originalModel = key;
      return;
    }
    if (state.currentModel !== key) {
      state.currentModel = key;
      state.originalModel = key;
      state.fallbackDepth = 0;
      state.lastFallbackAt = 0;
      state.recoveryNotifiedForModel = null;
      state.fallbackActiveNotifiedKey = null;
      logger.info("manual_model_change.reset_depth", {
        sessionId: input.sessionId,
        agent: input.agentName,
        model: key,
      });
    }
    return;
  }

  // Pick next healthy entry in the chain. The blocklist still applies to the
  // scan: a blocked entry inside the chain is never rotated onto.
  const next = resolveFallbackModel(
    key,
    chain,
    0,
    store.health,
    config.maxDepth,
    input.agentName ? blocked?.get(input.agentName) : undefined,
    claudeUnavailableVeto(input.snapshot ?? null) ?? undefined,
  );
  if (!next) {
    logger.debug("preemptive.no_healthy_alternative", {
      sessionId: input.sessionId,
      agent: input.agentName,
      current: key,
    });
    return;
  }

  redirect(next, "cooldown");
}
