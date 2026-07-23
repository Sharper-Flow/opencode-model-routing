# Contract Traceability

**Change ID:** fixFreshSpawnCooldown
**Contract Version:** 1
**Rigor:** strict
**Reviewed:** 2026-07-23T05:15:30.000Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | Same-process empty-history redirect. |
| AC2 | acceptance_criterion | pass | test | createPluginContext coverage. |
| AC3 | acceptance_criterion | pass | test | Same-process cooldown. |
| AC4 | acceptance_criterion | pass | test | Persisted read-through. |
| AC5 | acceptance_criterion | pass | test | Hook and metadata identity coverage. |
| AC6 | acceptance_criterion | pass | test | Unique/zero/multiple chain coverage. |
| AC7 | acceptance_criterion | pass | test | Fallback order preserved. |
| AC8 | acceptance_criterion | pass | test | Fresh preemptive/availability coverage. |
| AC9 | acceptance_criterion | pass | test | TTFT abort coverage. |
| AC10 | acceptance_criterion | pass | test | 395/395 full suite tr_mrx236x0_d4d6b324. |
| AC11 | acceptance_criterion | pass | test | T6 review evidence. |
| AC12 | acceptance_criterion | pass | test | T6 scan evidence. |
| C1 | constraint | respected | static_check | No core changes. |
| C2 | constraint | respected | static_check | Structural-only identity. |
| C3 | constraint | respected | static_check | Fail-open handling. |
| C4 | constraint | respected | static_check | One session.get assertion. |
| C5 | constraint | respected | static_check | Worktree-only. |
| C6 | constraint | respected | static_check | Isolated Bun tests. |
| DONT1 | avoidance | respected | review | No message seed. |
| DONT2 | avoidance | respected | review | Regression suite green. |
| DONT3 | avoidance | respected | review | No ambiguity guessing. |
| DONT4 | avoidance | respected | review | Targeted diff. |
| DONT5 | avoidance | respected | review | Child abort coverage. |
| OOS1 | out_of_scope | missing | not_applicable |  |
| OOS2 | out_of_scope | missing | not_applicable |  |
| OOS3 | out_of_scope | missing | not_applicable |  |
| OOS4 | out_of_scope | missing | not_applicable |  |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-fc058ca3f7ac | AC5 |  | C2, C3, C4 |  |
| tk-90075044b57e | AC8 |  | AC7, DONT2 |  |
| tk-d86d17bb3bc4 | AC6 |  | DONT3, C2 |  |
| tk-380c02a1a53b | AC9 |  | DONT5, C1 |  |
| tk-d6703e6df743 |  | AC1, AC2, AC3, AC4 | DONT1, DONT2 |  |
| tk-816c2ec78f31 | AC11, AC12 |  |  |  |
| tk-ef2e0aaaba8d |  | AC10, AC7 | C6 |  |
| tk-4fafc36afe6c |  |  | C1, C5 |  |
