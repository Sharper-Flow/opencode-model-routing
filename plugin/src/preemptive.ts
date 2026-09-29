// preemptive.ts — chat.message hook helper.
//
// Before each user round starts, check whether the model OpenCode is about to
// use is currently in cooldown or blocked for this agent. If cooled, mutate
// `output.message.model` to the next healthy entry in the agent's chain. If
// blocked (agents.<name>.blocked_models), redirect to the first chain entry
// that is healthy and not blocked, regardless of the current model's cooldown
// state. If the agent opted into family_disjoint_from_parent and the current
// model shares a family with the requesting parent's model, redirect to the
// first chain entry that is provably family-disjoint. No abort/revert needed
// — the user's first attempt simply starts on the allowed model.

import type { Logger } from "./logging/logger.ts";
import {
  isModelAdmissible,
  resolveFallbackModel,
} from "./resolution/fallback-resolver.ts";
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

// The redirect applyPreemptiveSkip made, returned to the caller. The routing
// step mutates output.message.model and session state but logs nothing about
// the redirect itself: handleChatMessage owns the event and logs it once the
// redirect is applied — at once on the OpenCode 1 chat.message hook (the
// mutated output model is the apply), and only after the OpenCode 2
// switchModel resolves, so a rejected switch never leaves a redirect or
// recovery event for a model that never served.
export interface AppliedRedirect {
  from: ModelKey;
  to: ModelKey;
  reason: "blocked" | "cooldown" | "family" | "recovered";
}

export function applyPreemptiveSkip(
  input: PreemptiveInput,
  store: FallbackStore,
  chains: Map<string, ModelKey[]>,
  config: PluginConfig,
  logger: Logger,
  blocked?: ReadonlyMap<string, ReadonlySet<ModelKey>>,
  familyVeto?: (key: ModelKey) => boolean,
): AppliedRedirect | null {
  const current = input.output.message.model;
  if (!current) return null;
  const key = `${current.providerID}/${current.modelID}` as ModelKey;

  // Mutate output.message.model to the allowed target and record it as the
  // session-current model. Shared by the blocklist redirect, the family
  // redirect, the cooldown redirect, and the return-to-original redirect so
  // all four leave identical bookkeeping, and each returns its descriptor for
  // the caller to log post-apply. The return-to-original case is a recovery,
  // not a redirect off a dead selection, and logs its own distinct event.
  const redirect = (
    next: ModelKey,
    reason: AppliedRedirect["reason"],
  ): AppliedRedirect | null => {
    const parsed = next.split("/");
    if (parsed.length < 2) return null;
    input.output.message.model = {
      providerID: parsed[0]!,
      modelID: parsed.slice(1).join("/"),
    };
    const state = store.sessions.get(input.sessionId);
    state.currentModel = next;
    return { from: key, to: next, reason };
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
        familyVeto,
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
        return null;
      }
      return redirect(next, "blocked");
    }
    if (familyVeto?.(key)) {
      // Same family as the requesting parent (or no family entry): the
      // healthy same-family primary is the normal case this constraint
      // exists to redirect, so this fires before the healthy-path early
      // return below. Same scan shape as the blocklist redirect — from the
      // top of the chain, honoring cooldown, blocklist, availability veto,
      // and the family veto itself.
      const next = resolveFallbackModel(
        null,
        chains.get(input.agentName) ?? [],
        0,
        store.health,
        config.maxDepth,
        blocklist,
        claudeUnavailableVeto(input.snapshot ?? null) ?? undefined,
        familyVeto,
      );
      if (!next) {
        // Unsatisfiable: no rung is provably family-disjoint from the
        // requester. Serve the selection and signal — a consult that is
        // same-family is worse than ideal, but refusing it is a hard failure
        // OMR has nowhere else, and the advisor self-reports its model so a
        // contaminated consult can be discounted downstream.
        logger.warn("family.no_disjoint_model", {
          sessionId: input.sessionId,
          agent: input.agentName,
          current: key,
        });
        return null;
      }
      return redirect(next, "family");
    }
    chain = chains.get(input.agentName);
    if (!chain || chain.length === 0) return null;

    // Return-to-original rule: OMR moved this session off its original
    // model (the arriving model equals currentModel and differs from
    // originalModel), and the original has recovered. Serve the next
    // request on the original again. Admission is the same predicate every
    // redirect scan uses — while the original is cooled, blocked, or vetoed
    // the session stays on its current rung. No maxDepth cap: a return
    // reduces depth instead of adding a fallback step.
    const state = store.sessions.get(input.sessionId);
    if (
      state.originalModel &&
      state.currentModel === key &&
      key !== state.originalModel &&
      isModelAdmissible(
        state.originalModel,
        store.health,
        blocked?.get(input.agentName),
        claudeUnavailableVeto(input.snapshot ?? null) ?? undefined,
        familyVeto,
      )
    ) {
      const original = state.originalModel;
      const applied = redirect(original, "recovered");
      state.fallbackDepth = 0;
      state.lastFallbackAt = 0;
      return applied;
    }
  } else {
    // A structurally resolved agent should always be available for production
    // child sessions. If every source is temporarily unavailable, only use a
    // chain when the cooled model belongs to exactly one configured chain.
    // Selecting among multiple matching agents would be heuristic routing.
    // The blocklist stays inactive here with the agent identity: applying a
    // guessed agent's blocklist would be the same heuristic this guard
    // refuses.
    if (!store.health.isInCooldown(key)) return null;
    const matches = [...chains.values()].filter((candidate) =>
      candidate.includes(key),
    );
    if (matches.length !== 1) {
      logger.error("identity_unavailable.ambiguous_cooled_dispatch", {
        sessionId: input.sessionId,
        current: key,
        matchingChainCount: matches.length,
      });
      return null;
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
      return null;
    }
    if (state.currentModel !== key) {
      // The session arrives on a different model than OMR last routed for
      // it. When the arriving model is the session's original, the original
      // has recovered and the host came back to it on its own (the
      // OpenCode 1 TUI keeps the user's selection across turns), so log the
      // return as a recovery. An arriving model that equals neither field
      // is the user's own choice.
      const returning = state.originalModel === key;
      const from = state.currentModel;
      state.currentModel = key;
      state.originalModel = key;
      state.fallbackDepth = 0;
      state.lastFallbackAt = 0;
      if (returning) {
        logger.info("fallback.recovered", {
          sessionId: input.sessionId,
          agent: input.agentName,
          from,
          to: key,
        });
      } else {
        logger.info("manual_model_change.reset_depth", {
          sessionId: input.sessionId,
          agent: input.agentName,
          model: key,
        });
      }
      return null;
    }
    // Healthy and already this session's current model: no redirect, and the
    // cooldown scan below must not run — it would "rotate" a healthy model.
    return null;
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
    familyVeto,
  );
  if (!next) {
    logger.debug("preemptive.no_healthy_alternative", {
      sessionId: input.sessionId,
      agent: input.agentName,
      current: key,
    });
    return null;
  }

  return redirect(next, "cooldown");
}
