# Contract Traceability

**Change ID:** fixOmrUsageCapFallbackGap
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 2026-05-23T19:16:31.285Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | test/detection.test.ts:8 'APIError data.statusCode 429 → rate_limit' passes; classifier.ts:50-55 returns rate_limit on data.statusCode === 429 |
| AC2 | acceptance_criterion | pass | test | test/detection.test.ts:73 'APIError data.responseBody insufficient_quota JSON → quota_exhausted' passes via responseBody scan fallback in classifier.ts:71-77 |
| AC3 | acceptance_criterion | pass | test | test/plugin.test.ts:271 'account_rate_limit → fallback fires (rate_limit)' passes; plugin-internal.ts handleEvent reads status.action.reason structurally first |
| AC4 | acceptance_criterion | pass | test | test/plugin.test.ts:298 'free_tier_limit → fallback fires (quota_exhausted)' passes; same code path as AC3 |
| AC5 | acceptance_criterion | pass | test | test/detection.test.ts:140 'OpenCode Go usage-limit retry → quota_exhausted' passes; matches via patterns.ts 'usage[ _-]?(limit|cap|maxed|exceeded)s?(?![a-z])' |
| AC6 | acceptance_criterion | pass | test | test/detection.test.ts:149 'Free usage exceeded (Go upsell) → quota_exhausted' passes; matches via patterns.ts 'free[_ ]?usage[_ ]?(exceeded|exhausted)' |
| AC7 | acceptance_criterion | pass | test | Full suite 110/110 pass; all 11 pre-existing flat-shape fixtures migrated to nested {name, data:{}} in detection.test.ts + plugin.test.ts with original classifications preserved |
| AC8 | acceptance_criterion | pass | test | bun run build success (22.9KB dist/index.js); copied to ~/.local/share/opencode-model-routing/plugin/dist/; diff -q clean; deployed bundle contains new regex (grep-verified) + DRY refactor |
| C1 | constraint | respected | static_check | git diff main..HEAD shows zero changes outside plugin/ subtree; no OpenCode core files touched |
| C2 | constraint | respected | static_check | No new chat-text scanning added; classifier only scans event payloads (session.error.data, session.status retry text) — not chat message parts |
| C3 | constraint | respected | static_check | No retry/backoff logic added; only classification + attemptFallback dispatch, both pre-existing |
| C4 | constraint | respected | static_check | All new patterns use \b prefix; usage[ _-]?(...) uses (?![a-z]) suffix instead of \b — explicit deviation documented in patterns.ts:33-35 with rationale (\b would fail on snake_case usage_limit_reached because '_' is a word char). All other patterns retain \b on both ends. |
| C5 | constraint | respected | static_check | plugin-internal.ts handleEvent session.status case: structural status.action.reason mapping runs BEFORE classifyRetryStatusText text fallback (lines verified by test/plugin.test.ts:271-356 four tests) |
| C6 | constraint | respected | static_check | All 4 new quota patterns inserted under '// Quota exhaustion' section at patterns.ts lines 29-37; \bretrying\b last-resort remains as final entry |
| OOS1 | out_of_scope | not_applicable | not_applicable | Out-of-scope: no OpenCode upstream changes; respected |
| OOS2 | out_of_scope | not_applicable | not_applicable | Out-of-scope: no retry/backoff added; respected |
| OOS3 | out_of_scope | not_applicable | not_applicable | Out-of-scope: no agent config changes; respected |
| OOS4 | out_of_scope | not_applicable | not_applicable | Out-of-scope: no new providers; respected |
| OOS5 | out_of_scope | not_applicable | not_applicable | Out-of-scope: ContextOverflowError handling deliberately untouched |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-6816e656a477 | AC1, AC2 | AC1, AC2 | C1, C5 |  |
| tk-96d0a0976ea1 | AC5, AC6 | AC5, AC6 | C4, C6 |  |
| tk-d9d3e0c33774 | AC3, AC4 | AC3, AC4 | C5 |  |
| tk-dc98d6338289 |  | AC7 | C5 |  |
| tk-975c9ad85d8b |  | AC8 |  | Build/deploy task; no TDD applicable. Verification is dist file equality + full test suite green. |
