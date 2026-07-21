// preemptive.ts — chat.message hook helper.
//
// Before each user round starts, check whether the model OpenCode is about to
// use is currently in cooldown. If so, mutate `output.message.model` to the
// next healthy entry in the agent's chain. No abort/revert needed — the user's
// first attempt simply starts on the healthy model.

import type { Logger } from "./logging/logger.ts";
import { resolveFallbackModel } from "./resolution/fallback-resolver.ts";
import type { FallbackStore } from "./state/store.ts";
import type { ModelKey, PluginConfig } from "./types.ts";

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
}

export function applyPreemptiveSkip(
  input: PreemptiveInput,
  store: FallbackStore,
  chains: Map<string, ModelKey[]>,
  config: PluginConfig,
  logger: Logger,
): void {
  if (!input.agentName) return;
  const chain = chains.get(input.agentName);
  if (!chain || chain.length === 0) return;

  const current = input.output.message.model;
  if (!current) return;
  const key = `${current.providerID}/${current.modelID}` as ModelKey;

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

  // Pick next healthy entry in the chain.
  const next = resolveFallbackModel(
    key,
    chain,
    0,
    store.health,
    config.maxDepth,
  );
  if (!next) {
    logger.debug("preemptive.no_healthy_alternative", {
      sessionId: input.sessionId,
      agent: input.agentName,
      current: key,
    });
    return;
  }

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
  });
}
