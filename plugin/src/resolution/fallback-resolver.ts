// fallback-resolver: picks the highest eligible model in a chain given the
// current model, fallback depth, and per-model health.
//
// Pure function — depends only on FallbackStore.health for health reads.

import type { ModelHealthMap } from "../state/model-health.ts";
import type { ModelKey } from "../types.ts";

/**
 * The one admission test every selection shares: a model is admissible when
 * it is not blocked for the agent, not in cooldown, not vetoed by the
 * availability snapshot, and not vetoed by the family constraint. The
 * resolver scan and the resume return both call this predicate, so a
 * resumed session can never land on a model any redirect would refuse.
 */
export function isModelAdmissible(
  model: ModelKey,
  health: ModelHealthMap,
  blocked?: ReadonlySet<ModelKey>,
  unavailable?: (key: ModelKey) => boolean,
  familyVeto?: (key: ModelKey) => boolean,
): boolean {
  if (blocked?.has(model)) return false;
  if (health.isInCooldown(model)) return false;
  if (unavailable?.(model)) return false;
  if (familyVeto?.(model)) return false;
  return true;
}

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
 *   - familyVeto: optional family-disjointness veto for agents opted into
 *     family_disjoint_from_parent. Rejects a candidate that shares the
 *     requesting parent's model family or has no family-map entry. Undefined
 *     for every non-opted-in agent, leaving the scan byte-identical to before.
 *
 * Algorithm:
 *   - If depth >= maxDepth → null (exhausted).
 *   - Scan from the highest-priority rung, excluding currentModel explicitly
 *     even when its cooldown is zero. A null currentModel excludes nothing.
 *   - Skip models in cooldown, blocked, or vetoed as unavailable.
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
  familyVeto?: (key: ModelKey) => boolean,
): ModelKey | null {
  if (depth >= maxDepth) return null;
  if (chain.length === 0) return null;

  for (const m of chain) {
    if (!m || m === currentModel) continue;
    if (!isModelAdmissible(m, health, blocked, unavailable, familyVeto)) {
      continue;
    }
    return m;
  }
  return null;
}
