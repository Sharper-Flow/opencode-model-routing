# Archive Briefing Digest

**Change ID:** wireCooldownStoreActivation
**Title:** Wire cooldown store activation
**Status:** archived
**Generated:** 2026-07-22T20:32:50.246Z

## Identity Anchors

- CHANGE
- STATUS
- TERMINAL_GATE_SUMMARY

## Archive Digest

**Status:** archived

| Gate | Status |
| --- | --- |
| proposal | done |
| discovery | done |
| design | done |
| planning | done |
| execution | done |
| acceptance | done |
| release | pending |

## Epic Context

No Epic membership

## Durable Facts

Showing 6 of 6 durable facts.

- **[report_follow_up]** follow_ups: Packet omitted TASK_SCOPE/IN_SCOPE/OUT_OF_SCOPE/DONE_WHEN/STOP_WHEN/VERIFICATION anchors; research proceeded under the supplied TASK and validation questions.
- **[research_citation]** sources: CooldownStore source: Defines logger/options/path resolution, lazy constructor, fail-open descriptor-bound reads, and fail-open locked persistence. (file:///home/jon/dev/opencode-model-routing/plugin/src/state/cooldown-store.ts#L84-L445)
- **[research_citation]** sources: Production context and failure path: Shows current unwired FallbackStore construction and failure routing through suppression, dedup, agent resolution, subagent detection, and attemptFallback. (file:///home/jon/dev/opencode-model-routing/plugin/src/plugin-internal.ts#L150-L545)
- **[research_citation]** sources: State wiring and fallback behavior: Defines CooldownStoreLike, persistence/read-through integration, and fail-open caller behavior. (file:///home/jon/dev/opencode-model-routing/plugin/src/state/model-health.ts#L38-L142)
- **[research_citation]** sources.omitted: 3 additional sources omitted (bounded to first 3)
- **[archive_only_evidence]** architecture_assessment: The proposed production construction is mechanically type-compatible and activates the established FallbackStore → ModelHealthMap → CooldownStore seam without changing file protocol or detection behavior. Construction is lazy and fail-open. CAUTION: the proposed integration test must prove observable persistence from createPluginContext rather than inspect an unexposed private backend, and diagnostic records need enough correlation fields to discriminate all five runtime hypotheses.

## Contract / AC Coverage

| ID | Kind | Status |
| --- | --- | --- |
| AC1 | acceptance_criterion | pass |
| AC2 | acceptance_criterion | pass |
| AC3 | acceptance_criterion | pass |
| AC4 | acceptance_criterion | pass |
| AC5 | acceptance_criterion | pass |
| AC6 | acceptance_criterion | pass |
| AC7 | acceptance_criterion | pass |
| C1 | constraint | respected |
| C2 | constraint | respected |
| C3 | constraint | respected |
| C4 | constraint | respected |
| C5 | constraint | respected |
| C6 | constraint | respected |
| DONT1 | avoidance | respected |
| DONT2 | avoidance | respected |
| DONT3 | avoidance | respected |
| DONT4 | avoidance | respected |
| DONT5 | avoidance | respected |
| OOS1 | out_of_scope | missing |
| OOS2 | out_of_scope | missing |
| OOS3 | out_of_scope | missing |
| OOS4 | out_of_scope | missing |
| OOS5 | out_of_scope | missing |

## Unresolved Actions

None
