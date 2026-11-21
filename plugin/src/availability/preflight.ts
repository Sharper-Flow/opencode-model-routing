// availability/preflight.ts — chat.message availability redirect.
//
// Consumes one validated snapshot per user turn. Unavailable vetoes Anthropic
// for every agent; degraded does so only for agents that opt in. Invalid or
// absent snapshots and non-Anthropic selections leave routing unchanged.

import type { Logger } from "../logging/logger.ts";
import type { FallbackStore } from "../state/store.ts";
import type { ModelKey } from "../types.ts";
import { resolveFallbackModel } from "../resolution/fallback-resolver.ts";
import type { AvailabilitySnapshotV1 } from "./snapshot.ts";

// Canonical OpenCode provider id for Anthropic/Claude models. The Claude Max
// exhaustion snapshot only authorizes redirecting selections on this provider;
// Claude-shaped models served by other providers (gateways, bedrock, etc.)
// are outside the protocol and keep their routing.
export const ANTHROPIC_PROVIDER_ID = "anthropic";

export interface AvailabilityPreflightInput {
  sessionId: string;
  agentName: string | null;
  output: { message: { model?: { providerID: string; modelID: string } } };
  snapshot: AvailabilitySnapshotV1 | null;
  fallbackOnClaudeDegraded?: boolean;
}

function providerOf(key: ModelKey): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

function modelIdOf(key: ModelKey): string {
  const slash = key.indexOf("/");
  return slash === -1 ? "" : key.slice(slash + 1);
}

// Builds the provider-level availability veto shared by every rotation scan.
// The veto rejects exactly the provider namespace the snapshot governs.
export function claudeUnavailableVeto(
  snapshot: AvailabilitySnapshotV1 | null,
  fallbackOnClaudeDegraded = false,
): ((key: ModelKey) => boolean) | null {
  if (
    !snapshot ||
    (snapshot.state !== "unavailable" &&
      !(fallbackOnClaudeDegraded && snapshot.state === "degraded"))
  )
    return null;
  return (key: ModelKey) => providerOf(key) === ANTHROPIC_PROVIDER_ID;
}

export function applyAvailabilityPreflight(
  input: AvailabilityPreflightInput,
  store: FallbackStore,
  chains: Map<string, ModelKey[]>,
  logger: Logger,
  familyVeto?: (key: ModelKey) => boolean,
  blocked?: ReadonlySet<ModelKey>,
  maxDepth = Number.POSITIVE_INFINITY,
): void {
  const snapshot = input.snapshot;
  const veto = claudeUnavailableVeto(snapshot, input.fallbackOnClaudeDegraded);
  if (!snapshot || !veto) return;

  const current = input.output.message.model;
  if (!current || current.providerID !== ANTHROPIC_PROVIDER_ID) return;
  if (!input.agentName) return;
  const chain = chains.get(input.agentName);
  if (!chain || chain.length === 0) return;

  const target = resolveFallbackModel(
    `${current.providerID}/${current.modelID}`,
    chain,
    0,
    store.health,
    maxDepth,
    blocked,
    veto,
    familyVeto,
  );
  if (!target) {
    logger.debug("availability.preflight_no_fallback", {
      sessionId: input.sessionId,
      availability: snapshot.state,
    });
    return;
  }

  input.output.message.model = {
    providerID: providerOf(target),
    modelID: modelIdOf(target),
  };
  const state = store.sessions.get(input.sessionId);
  state.currentModel = target;
  // AC7: availability logs carry only the fixed event, correlation id,
  // availability kind, and the optional retry timestamp. No paths, account
  // identities, or model internals beyond the routing outcome.
  logger.info("availability.preflight_redirected", {
    sessionId: input.sessionId,
    availability: snapshot.state,
    retryAt: snapshot.retry_at,
  });
}
