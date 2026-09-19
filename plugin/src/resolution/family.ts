// family.ts — model-family disjointness for opted-in agents.
//
// Provider ID is not model family: `opencode-go/glm-5.3-flash` and
// `zai-coding-plan/glm-5.3` are different providers and one GLM family, and
// both appear in live chains. Family therefore comes only from the explicit
// `model_families` config map (`plugin[N][1].model_families`); no provider
// string comparison and no model-ID heuristic decides it.

import type { ModelKey } from "../types.ts";

/**
 * Build the family veto for one parent model.
 *
 * Returns undefined when the parent's model has no entry in the family map:
 * the requester's family is a config gap the operator must see, and a veto
 * built without it would be arbitrary. The caller warns and leaves routing
 * unchanged.
 *
 * Otherwise returns a predicate rejecting a candidate when it shares the
 * parent's family OR has no family entry of its own. An unmapped candidate
 * is skipped because disjointness must be proven, not assumed: treating an
 * unmapped key as disjoint fails open in exactly the direction that is
 * undetectable downstream (a contaminated consult that looks independent).
 */
export function familyVetoFor(
  parentModel: ModelKey,
  families: ReadonlyMap<ModelKey, string>,
): ((key: ModelKey) => boolean) | undefined {
  const parentFamily = families.get(parentModel);
  if (parentFamily === undefined) return undefined;
  return (key: ModelKey) => {
    const family = families.get(key);
    return family === undefined || family === parentFamily;
  };
}
