# Contract Traceability

**Change ID:** wireCooldownStoreActivation
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 2026-07-22T20:30:00.000Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | package-contract.test.ts. tr_mrwibo6t. |
| AC2 | acceptance_criterion | pass | test | production-wiring.test.ts. tr_mrwi62yo. |
| AC3 | acceptance_criterion | pass | test | subagent-fallover-flow.test.ts. tr_mrwip3ze. |
| AC4 | acceptance_criterion | pass | test | Outcome B + fix. tr_mrwip3ze. |
| AC5 | acceptance_criterion | pass | test | Fail-open preserved. 385/0. |
| AC6 | acceptance_criterion | pass | test | 385 pass 0 fail. |
| AC7 | acceptance_criterion | pass | test | Build + markers + deploy. |
| C1 | constraint | respected | static_check | No probes. |
| C2 | constraint | respected | static_check | Reused. Fail-open. |
| C3 | constraint | respected | static_check | Protocol reused. |
| C4 | constraint | respected | static_check | Detection reused. |
| C5 | constraint | respected | static_check | No trace shipped. |
| C6 | constraint | respected | static_check | Deploy from main. |
| DONT1 | avoidance | respected | review | Wired. |
| DONT2 | avoidance | respected | review | Not rewritten. |
| DONT3 | avoidance | respected | review | TTFT unchanged. |
| DONT4 | avoidance | respected | review | No routing changes. |
| DONT5 | avoidance | respected | review | No in-place recovery. |
| OOS1 | out_of_scope | missing | not_applicable |  |
| OOS2 | out_of_scope | missing | not_applicable |  |
| OOS3 | out_of_scope | missing | not_applicable |  |
| OOS4 | out_of_scope | missing | not_applicable |  |
| OOS5 | out_of_scope | missing | not_applicable |  |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-933434a0060a | C2, C3, C4 |  | C1, DONT1, DONT2 |  |
| tk-1490fd2ee0ad | AC1, AC2 |  | C5 |  |
| tk-50e7adf01084 | AC3 |  | C1, C5 |  |
| tk-9902696deca3 | AC4 |  | DONT5 |  |
| tk-ce73dc110891 | AC3, AC5, AC6, AC7 |  | C5, C6, DONT1 |  |
| tk-3cacf89c8f8b | AC4 |  | C1, C2 |  |
