// availability/preflight.ts — chat.message availability redirect.
//
// Consumes ONE already-validated snapshot per user turn. Only a fresh,
// structurally valid `unavailable` snapshot carries routing authority: an
// Anthropic/Claude selection is redirected to the first healthy configured
// non-Anthropic chain entry BEFORE provider dispatch, so no Claude child
// attempt starts on confirmed exhaustion. Every other outcome (missing,
// stale, malformed, wrong-permission, unknown-version, non-unavailable, or
// absent snapshot) is a strict no-op. Non-Anthropic selections are never
// touched (SC4), and error text plays no part in the decision (DONT3).

import type { Logger } from "../logging/logger.ts";
import type { FallbackStore } from "../state/store.ts";
import type { ModelKey } from "../types.ts";
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
}

function providerOf(key: ModelKey): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

function modelIdOf(key: ModelKey): string {
  const slash = key.indexOf("/");
  return slash === -1 ? "" : key.slice(slash + 1);
}

export function applyAvailabilityPreflight(
  input: AvailabilityPreflightInput,
  store: FallbackStore,
  chains: Map<string, ModelKey[]>,
  logger: Logger,
): void {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.state !== "unavailable") return;

  const current = input.output.message.model;
  if (!current || current.providerID !== ANTHROPIC_PROVIDER_ID) return;
  if (!input.agentName) return;
  const chain = chains.get(input.agentName);
  if (!chain || chain.length === 0) return;

  const target = chain.find(
    (key) => providerOf(key) !== ANTHROPIC_PROVIDER_ID && !store.health.isInCooldown(key),
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
