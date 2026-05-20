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
 *
 * Returns the next ModelKey to try, or null if exhausted/all cooled.
 *
 * Algorithm:
 *   - If depth >= maxDepth → null (exhausted).
 *   - Find currentModel's index in chain. If not found, start at -1
 *     (treat as "primary outside chain"); next candidate is chain[0].
 *   - Scan forward from the next index, skipping any model that is
 *     currently in cooldown. First healthy hit wins; null if none.
 */
export function resolveFallbackModel(
  currentModel: ModelKey | null,
  chain: ModelKey[],
  depth: number,
  health: ModelHealthMap,
  maxDepth: number,
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
    if (health.isInCooldown(m)) continue;
    return m;
  }
  return null;
}
