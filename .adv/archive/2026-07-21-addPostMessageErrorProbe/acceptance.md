# Acceptance

Reviewed at: 2026-07-21T17:36:47.974Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| SC1 | success_criterion | Every typed provider failure triggers at most one fallback, regardless of EventV2 ordering or duplicate delivery. | pass | Ordering integration tests prove exactly one fallback for error→message, message→error, status→error, status→message, duplicate, and concurrent delivery. |
| SC2 | success_criterion | A missed transient `session.error` is recovered through assistant-error `message.updated`. | pass | Assistant-error message.updated legacy+V2 tests trigger fallback independently of session.error. |
| SC3 | success_criterion | No synthetic provider request or token/usage consumption is introduced. | pass | Static review found no provider request, synthetic prompt, polling probe, fetch, or health call. |
| SC4 | success_criterion | True silence still falls back through TTFT unchanged. | pass | TTFT registry/default unchanged; malformed/unclassified signals leave TTFT armed; existing TTFT tests pass. |
| AC1 | acceptance_criterion | `session.error` with a classifiable typed error triggers fallback through the normalized failure handler. | pass | Existing session.error tests and unified handler tests pass. |
| AC2 | acceptance_criterion | Assistant-error `message.updated` triggers fallback when no matching `session.error` was handled. | pass | Legacy and V2 assistant-error message.updated tests trigger fallback. |
| AC3 | acceptance_criterion | When `session.error` and assistant-error `message.updated` describe the same failure in either order, exactly one fallback dispatch occurs. | pass | Exactly-once ordering suite covers both orders, status transitions, duplicate and concurrent delivery. |
| AC4 | acceptance_criterion | Legacy and V2 `message.updated` shapes normalize correctly (`properties.info.sessionID` and optional `properties.sessionID`). | pass | Installed legacy info.sessionID and V2 properties.sessionID shapes tested. |
| AC5 | acceptance_criterion | `MessageAbortedError` remains a non-fallback signal. | pass | MessageAbortedError session.error and message.updated tests produce no fallback. |
| AC6 | acceptance_criterion | Malformed or unsupported errors are ignored safely and TTFT remains armed. | pass | Malformed assistant error rejected by normalization; prompt not called; TTFT remains armed. |
| AC7 | acceptance_criterion | Persistent cooldown receives the normalized error category unchanged. | pass | Cooldown health record retains exact normalized rate_limit category. |
| AC8 | acceptance_criterion | All existing plugin tests pass unchanged. | pass | Full plugin suite 374/374; typecheck and build pass. |
| C1 | constraint | Zero provider-token or provider-rate-limit usage; event handling and any reconciliation read remain local to OpenCode. | respected | No provider calls added; all signals use plugin events and local state. |
| C2 | constraint | Typed structural parsing owns correctness; prose/text heuristics are fallback-only when typed fields are absent. | respected | Event normalization validates typed roles, IDs, error object/data before handling. |
| C3 | constraint | Existing plugin `event` hook remains the EventV2 integration surface; no parallel SSE subscription. | respected | Existing plugin event hook retained; no direct SSE/EventSource client. |
| C4 | constraint | Persistent cooldown file remains the cross-process durable projection. | respected | Persistent cooldown module and cross-process projection behavior retained. |
| C5 | constraint | Handled-failure registry is bounded by size/time and cleaned deterministically. | respected | FailureDeduplicator: 30s TTL, 512 cap, prune-on-begin, oldest eviction, session cleanup; tests pass. |
| C6 | constraint | Support current/latest OpenCode; no downgrade. | respected | No OpenCode dependency downgrade or downgrade path added. |
| DONT1 | avoidance | No per-message delayed polling timer or `probeDelayMs` configuration. | respected | No delayed polling timer or probeDelayMs exists. |
| DONT2 | avoidance | No direct `/event` SSE consumer, reconnect loop, or second EventV2 lifecycle inside OMR. | respected | No /event SSE consumer or reconnect lifecycle added. |
| DONT3 | avoidance | No duplicate fallback dispatch for one assistant failure. | respected | Exactly-one fallback proven across all required ordering permutations. |
| DONT4 | avoidance | No removal or shortening of TTFT protection. | respected | TTFT remains 60s/default unchanged. |
| DONT5 | avoidance | No provider health prompt, synthetic completion, or provider API probe. | respected | No provider health prompt, synthetic completion, or API probe. |
| OOS1 | out_of_scope | Replacing the persistent cooldown file with EventV2 event sourcing. | missing |  |
| OOS2 | out_of_scope | Adding OpenCode plugin-level replay/cursor support. | missing |  |
| OOS3 | out_of_scope | Lowering global TTFT or adding adaptive provider timeouts. | missing |  |
| OOS4 | out_of_scope | Downgrading OpenCode. | missing |  |
| OOS5 | out_of_scope | Filing or implementing an upstream OpenCode fix. | missing |  |

