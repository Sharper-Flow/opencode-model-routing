// availability/guard.ts — centralized Claude-exhaustion replay guard.
//
// ONE synchronous guard invoked before every await at each detached replay
// entrance (session.error handler, session.status retry handler, TTFT
// timeout handler). On a fresh, structurally valid `unavailable` V1 snapshot
// plus a confirmed Anthropic/Claude current selection, it clears the TTFT
// timer, records a per-turn suppression guard, and suppresses the replay —
// confirmed mid-task exhaustion starts zero `session.messages`,
// `session.abort`, `session.revert`, or fallback `session.prompt` calls
// (SC2/AC4, DONT1).
//
// Authority rules:
//   - The snapshot is the ONLY authority. Error text never authorizes
//     suppression (C3/DONT3); the guard never inspects error payloads.
//   - Missing, stale, malformed, wrong-permission, or unknown-version
//     snapshot → null from the descriptor-bound reader → no-op (C4).
//   - Non-Anthropic current selections are never suppressed: unmarked
//     non-Claude (Sol→GLM) fallback behavior is unchanged (SC4/AC6), and a
//     turn already redirected by the availability preflight keeps normal
//     fallback semantics.
//   - The recorded per-turn guard is authoritative for the rest of the
//     turn: once suppressed, later retry-status/TTFT entrances in the same
//     turn stay suppressed even if the snapshot flips back to available
//     (AC5). chat.message clears the guard so the next valid user turn
//     proceeds normally.
//
// No timing, no polling, no process-global state (C5): the registry lives in
// the plugin-closure PluginContext, and each entrance performs one
// synchronous descriptor-bound snapshot revalidation.

import { ANTHROPIC_PROVIDER_ID } from "./preflight.ts";
import { readAvailabilitySnapshot } from "./snapshot.ts";
import type { Logger } from "../logging/logger.ts";
import type { FallbackStore } from "../state/store.ts";
import type { TtftRegistry } from "../ttft.ts";

/**
 * Per-turn suppression registry. A session id present here means confirmed
 * Claude Max exhaustion already suppressed one detached replay entrance this
 * turn; every later entrance in the same turn is suppressed without
 * re-reading the snapshot. Cleared on the next chat.message.
 */
export class ExhaustionGuardRegistry {
  private suppressed = new Set<string>();

  clearTurn(sessionId: string): void {
    this.suppressed.delete(sessionId);
  }

  isSuppressed(sessionId: string): boolean {
    return this.suppressed.has(sessionId);
  }

  record(sessionId: string): void {
    this.suppressed.add(sessionId);
  }
}

// Narrow structural context so this module does not import plugin-internal
// (which would create a cycle); PluginContext satisfies it structurally.
export interface ExhaustionGuardContext {
  store: FallbackStore;
  ttft: TtftRegistry;
  guard: ExhaustionGuardRegistry;
  logger: Logger;
}

function providerOf(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

/**
 * shouldSuppressReplay is the single centralized guard. It is fully
 * synchronous and MUST be invoked before the first await of every detached
 * replay entrance. Returns true when the entrance must suppress the replay.
 *
 * Idempotent: an already-recorded per-turn guard suppresses immediately.
 * Otherwise it revalidates the snapshot, confirms the current selection is
 * Anthropic/Claude, clears TTFT state, records the guard, logs the fixed
 * availability event, and suppresses.
 */
export function shouldSuppressReplay(
  sessionId: string,
  ctx: ExhaustionGuardContext,
): boolean {
  if (ctx.guard.isSuppressed(sessionId)) return true;

  const snapshot = readAvailabilitySnapshot();
  if (!snapshot || snapshot.state !== "unavailable") return false;

  const current = ctx.store.sessions.get(sessionId).currentModel;
  if (!current || providerOf(current) !== ANTHROPIC_PROVIDER_ID) return false;

  ctx.ttft.clear(sessionId);
  ctx.guard.record(sessionId);
  // AC7: fixed event, correlation id, availability kind, optional retry
  // timestamp only — no paths, account identities, or error payloads.
  ctx.logger.info("availability.replay_suppressed", {
    sessionId,
    availability: snapshot.state,
    retryAt: snapshot.retry_at,
  });
  return true;
}
