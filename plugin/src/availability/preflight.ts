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

// Builds the provider-level availability veto shared by every rotation scan.
// Only a `unavailable` snapshot carries veto authority; every other state
// (available, degraded, disabled, unconfigured, or no snapshot at all)
// yields null and leaves chain resolution untouched. The veto rejects
// exactly the ANTHROPIC_PROVIDER_ID namespace the snapshot governs.
export function claudeUnavailableVeto(
  snapshot: AvailabilitySnapshotV1 | null,
): ((key: ModelKey) => boolean) | null {
  if (!snapshot || snapshot.state !== "unavailable") return null;
  return (key: ModelKey) => providerOf(key) === ANTHROPIC_PROVIDER_ID;
}

// What applyAvailabilityPreflight returns: the redirect it applied. The
// routing step mutates output.message.model and session state but logs
// nothing about the redirect itself: handleChatMessage owns the
// availability.preflight_redirected event and logs it once the redirect is
// applied — at once on the OpenCode 1 chat.message hook, and only after the
// OpenCode 2 switchModel resolves, so a rejected switch never leaves an
// event for a redirect that never landed. The event payload keeps the AC7
// surface: fixed event, correlation id, availability kind, optional retry
// timestamp — no paths, account identities, or model internals beyond the
// routing outcome.
export interface AppliedAvailabilityRedirect {
  from: ModelKey;
  to: ModelKey;
  availability: "unavailable";
  retryAt: number | null;
}

export function applyAvailabilityPreflight(
  input: AvailabilityPreflightInput,
  store: FallbackStore,
  chains: Map<string, ModelKey[]>,
  logger: Logger,
  familyVeto?: (key: ModelKey) => boolean,
): AppliedAvailabilityRedirect | null {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.state !== "unavailable") return null;

  const current = input.output.message.model;
  if (!current || current.providerID !== ANTHROPIC_PROVIDER_ID) return null;
  if (!input.agentName) return null;
  const chain = chains.get(input.agentName);
  if (!chain || chain.length === 0) return null;

  const target = chain.find(
    (key) =>
      providerOf(key) !== ANTHROPIC_PROVIDER_ID &&
      !store.health.isInCooldown(key) &&
      !familyVeto?.(key),
  );
  if (!target) {
    logger.debug("availability.preflight_no_fallback", {
      sessionId: input.sessionId,
      availability: snapshot.state,
    });
    return null;
  }

  input.output.message.model = {
    providerID: providerOf(target),
    modelID: modelIdOf(target),
  };
  const state = store.sessions.get(input.sessionId);
  state.currentModel = target;
  return {
    from: `${current.providerID}/${current.modelID}` as ModelKey,
    to: target,
    availability: "unavailable",
    retryAt: snapshot.retry_at,
  };
}
