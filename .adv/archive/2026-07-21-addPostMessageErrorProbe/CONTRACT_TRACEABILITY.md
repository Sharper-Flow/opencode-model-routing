# Contract Traceability

**Change ID:** addPostMessageErrorProbe
**Contract Version:** 1
**Rigor:** strict
**Reviewed:** 2026-07-21T17:36:47.974Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| SC1 | success_criterion | pass | review | Ordering integration tests prove exactly one fallback for error→message, message→error, status→error, status→message, duplicate, and concurrent delivery. |
| SC2 | success_criterion | pass | review | Assistant-error message.updated legacy+V2 tests trigger fallback independently of session.error. |
| SC3 | success_criterion | pass | review | Static review found no provider request, synthetic prompt, polling probe, fetch, or health call. |
| SC4 | success_criterion | pass | review | TTFT registry/default unchanged; malformed/unclassified signals leave TTFT armed; existing TTFT tests pass. |
| AC1 | acceptance_criterion | pass | test | Existing session.error tests and unified handler tests pass. |
| AC2 | acceptance_criterion | pass | test | Legacy and V2 assistant-error message.updated tests trigger fallback. |
| AC3 | acceptance_criterion | pass | test | Exactly-once ordering suite covers both orders, status transitions, duplicate and concurrent delivery. |
| AC4 | acceptance_criterion | pass | test | Installed legacy info.sessionID and V2 properties.sessionID shapes tested. |
| AC5 | acceptance_criterion | pass | test | MessageAbortedError session.error and message.updated tests produce no fallback. |
| AC6 | acceptance_criterion | pass | test | Malformed assistant error rejected by normalization; prompt not called; TTFT remains armed. |
| AC7 | acceptance_criterion | pass | test | Cooldown health record retains exact normalized rate_limit category. |
| AC8 | acceptance_criterion | pass | test | Full plugin suite 374/374; typecheck and build pass. |
| C1 | constraint | respected | static_check | No provider calls added; all signals use plugin events and local state. |
| C2 | constraint | respected | static_check | Event normalization validates typed roles, IDs, error object/data before handling. |
| C3 | constraint | respected | static_check | Existing plugin event hook retained; no direct SSE/EventSource client. |
| C4 | constraint | respected | static_check | Persistent cooldown module and cross-process projection behavior retained. |
| C5 | constraint | respected | static_check | FailureDeduplicator: 30s TTL, 512 cap, prune-on-begin, oldest eviction, session cleanup; tests pass. |
| C6 | constraint | respected | static_check | No OpenCode dependency downgrade or downgrade path added. |
| DONT1 | avoidance | respected | review | No delayed polling timer or probeDelayMs exists. |
| DONT2 | avoidance | respected | review | No /event SSE consumer or reconnect lifecycle added. |
| DONT3 | avoidance | respected | review | Exactly-one fallback proven across all required ordering permutations. |
| DONT4 | avoidance | respected | review | TTFT remains 60s/default unchanged. |
| DONT5 | avoidance | respected | review | No provider health prompt, synthetic completion, or API probe. |
| OOS1 | out_of_scope | missing | not_applicable |  |
| OOS2 | out_of_scope | missing | not_applicable |  |
| OOS3 | out_of_scope | missing | not_applicable |  |
| OOS4 | out_of_scope | missing | not_applicable |  |
| OOS5 | out_of_scope | missing | not_applicable |  |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-18eb35774e89 | AC3, C5 |  | C2, DONT3 |  |
| tk-015aba543d06 | AC1, AC2, AC4, AC5, AC6, AC7 |  | C1, C2, C3, C4, C6, DONT1, DONT2, DONT4, DONT5 |  |
| tk-6a586de36d8a |  | AC1, AC2, AC3, AC4, AC5, AC6, AC7 | DONT3 |  |
| tk-33ce438e109b |  | AC8 | C1, C3, C6, DONT1, DONT2, DONT4, DONT5 |  |
