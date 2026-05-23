# Acceptance

Reviewed at: 2026-05-23T19:16:31.285Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| AC1 | acceptance_criterion | `classifySessionError({ name: "APIError", data: { statusCode: 429, message: "Quota exceeded..." } })` returns `"rate_limit"`. | pass | test/detection.test.ts:8 'APIError data.statusCode 429 → rate_limit' passes; classifier.ts:50-55 returns rate_limit on data.statusCode === 429 |
| AC2 | acceptance_criterion | `classifySessionError({ name: "APIError", data: { message: "Quota exceeded.", isRetryable: false, responseBody: '{"error":{"code":"insufficient_quota"}}' } })` returns `"quota_exhausted"`. | pass | test/detection.test.ts:73 'APIError data.responseBody insufficient_quota JSON → quota_exhausted' passes via responseBody scan fallback in classifier.ts:71-77 |
| AC3 | acceptance_criterion | `handleEvent` on `session.status` retry with `action.reason: "account_rate_limit"` triggers fallback with `reason: "rate_limit"` — no reliance on message text. | pass | test/plugin.test.ts:271 'account_rate_limit → fallback fires (rate_limit)' passes; plugin-internal.ts handleEvent reads status.action.reason structurally first |
| AC4 | acceptance_criterion | `handleEvent` on `session.status` retry with `action.reason: "free_tier_limit"` triggers fallback with `reason: "quota_exhausted"`. | pass | test/plugin.test.ts:298 'free_tier_limit → fallback fires (quota_exhausted)' passes; same code path as AC3 |
| AC5 | acceptance_criterion | `classifyRetryStatusText("5 hour usage limit reached. It will reset in 5 hours 23 minutes...")` returns `"quota_exhausted"` (pattern fallback). | pass | test/detection.test.ts:140 'OpenCode Go usage-limit retry → quota_exhausted' passes; matches via patterns.ts 'usage[ _-]?(limit|cap|maxed|exceeded)s?(?![a-z])' |
| AC6 | acceptance_criterion | `classifyRetryStatusText("Free usage exceeded, subscribe to Go")` returns `"quota_exhausted"`. | pass | test/detection.test.ts:149 'Free usage exceeded (Go upsell) → quota_exhausted' passes; matches via patterns.ts 'free[_ ]?usage[_ ]?(exceeded|exhausted)' |
| AC7 | acceptance_criterion | All other existing classifications in `plugin/test/detection.test.ts` still pass after fixture migration to real shapes. | pass | Full suite 110/110 pass; all 11 pre-existing flat-shape fixtures migrated to nested {name, data:{}} in detection.test.ts + plugin.test.ts with original classifications preserved |
| AC8 | acceptance_criterion | Plugin rebuilt (`bun run build`) + full test suite green; deployed plugin at `~/.local/share/opencode-model-routing/plugin/dist/` updated to match. | pass | bun run build success (22.9KB dist/index.js); copied to ~/.local/share/opencode-model-routing/plugin/dist/; diff -q clean; deployed bundle contains new regex (grep-verified) + DRY refactor |
| C1 | constraint | Do NOT modify OpenCode core / upstream event emission. | respected | git diff main..HEAD shows zero changes outside plugin/ subtree; no OpenCode core files touched |
| C2 | constraint | Do NOT add streaming chat-text scanning — confirmed unnecessary. | respected | No new chat-text scanning added; classifier only scans event payloads (session.error.data, session.status retry text) — not chat message parts |
| C3 | constraint | Do NOT add retry/backoff logic to OMR. | respected | No retry/backoff logic added; only classification + attemptFallback dispatch, both pre-existing |
| C4 | constraint | Keep patterns anchored (use `\b` word boundaries) to avoid false positives. | respected | All new patterns use \b prefix; usage[ _-]?(...) uses (?![a-z]) suffix instead of \b — explicit deviation documented in patterns.ts:33-35 with rationale (\b would fail on snake_case usage_limit_reached because '_' is a word char). All other patterns retain \b on both ends. |
| C5 | constraint | Structural classification (action.reason) MUST take precedence over text patterns (P33). | respected | plugin-internal.ts handleEvent session.status case: structural status.action.reason mapping runs BEFORE classifyRetryStatusText text fallback (lines verified by test/plugin.test.ts:271-356 four tests) |
| C6 | constraint | New patterns inserted before the `\bretrying\b` last-resort entry in retryPatterns[]. | respected | All 4 new quota patterns inserted under '// Quota exhaustion' section at patterns.ts lines 29-37; \bretrying\b last-resort remains as final entry |
| OOS1 | out_of_scope | Fixing OpenCode upstream event emission. | not_applicable | Out-of-scope: no OpenCode upstream changes; respected |
| OOS2 | out_of_scope | Adding retry/backoff to OMR. | not_applicable | Out-of-scope: no retry/backoff added; respected |
| OOS3 | out_of_scope | Changing agent model configurations. | not_applicable | Out-of-scope: no agent config changes; respected |
| OOS4 | out_of_scope | Adding new providers or chain features. | not_applicable | Out-of-scope: no new providers; respected |
| OOS5 | out_of_scope | ContextOverflowError handling (OpenCode marks it non-retryable; fallback doesn't help). | not_applicable | Out-of-scope: ContextOverflowError handling deliberately untouched |

