// fallback-resolver: picks the next healthy model in a chain given the
// current model, fallback depth, and per-model health.
//
// Pure function — depends only on FallbackStore.health for health reads.

import type { ModelHealthMap } from "../state/model-health.ts";
import type { ModelKey } from "../types.ts";

/**
 * Given:
 *   - currentModel: the model that just failed (or was preemptively skipped)
 *   - chain: the fallback chain configured for this agent (full chain
 *     including primary first, or just fallback entries — caller decides
 *     by passing the chain alone)
 *   - depth: how many fallback steps have already happened this session
 *   - health: per-model health map
 *   - maxDepth: cap on total fallback steps
 *   - blocked: optional per-agent blocked-model set (agents.<name>.blocked_models).
 *     Every rotation scan — fallback recovery and preemptive redirect alike —
 *     skips blocked entries, so a blocked key inside a configured chain is
 *     never rotated onto.
 *   - unavailable: optional provider-level availability veto (e.g. the Claude
 *     Max snapshot reporting `unavailable`). A model the veto rejects is
 *     skipped exactly like a cooldown-cooled one, at every rotation scan, so
 *     no redirect lands on a provider another component already knows is dead.
 *
 * Algorithm:
 *   - If depth >= maxDepth → null (exhausted).
 *   - Find currentModel's index in chain. If not found, start at -1
 *     (treat as "primary outside chain"); next candidate is chain[0].
 *     A null currentModel also starts at -1 — callers use this to scan for
 *     the first allowed entry from the top of the chain.
 *   - Scan forward from the next index, skipping any model that is
 *     currently in cooldown, blocked, or vetoed as unavailable.
 *     First healthy hit wins; null if none.
 */
export function resolveFallbackModel(
  currentModel: ModelKey | null,
  chain: ModelKey[],
  depth: number,
  health: ModelHealthMap,
  maxDepth: number,
  blocked?: ReadonlySet<ModelKey>,
  unavailable?: (key: ModelKey) => boolean,
): ModelKey | null {
  if (depth >= maxDepth) return null;
  if (chain.length === 0) return null;

  let startIdx = -1;
  if (currentModel) {
    startIdx = chain.findIndex((m) => m === currentModel);
  }
  for (let i = startIdx + 1; i < chain.length; i++) {
    const m = chain[i];
    if (!m) continue;
    if (blocked?.has(m)) continue;
    if (health.isInCooldown(m)) continue;
    if (unavailable?.(m)) continue;
    return m;
  }
  return null;
}
