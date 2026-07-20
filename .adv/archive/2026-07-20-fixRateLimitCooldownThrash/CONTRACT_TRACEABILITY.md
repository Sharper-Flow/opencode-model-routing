# Contract Traceability

**Change ID:** fixRateLimitCooldownThrash
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 2026-07-20T04:59:52.878Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| C1 | constraint | respected | static_check | plugin/src/plugin-internal.ts:74-103 — createPluginContext signature gained additive cooldownOverrides?: Partial<Record<ErrorCategory, number>> param; PluginConfig type itself unchanged; 3-layer merge preserves all existing fields. No breaking shape change. |
| C2 | constraint | respected | static_check | plugin/src/types.ts:13-20 — ErrorCategory union unchanged (rate_limit, server_error, unknown_model, auth_error, ttft_timeout, quota_exhausted, unknown). |
| C3 | constraint | respected | static_check | git diff 47008c9..517491f -- plugin/src/detection/ → empty. classifier.ts + patterns.ts untouched. |
| C4 | constraint | respected | static_check | git diff 47008c9..517491f -- cmd/ internal/ → empty. Go-side writer (omr binary) untouched; field not yet emitted by writer (deferred follow-up). |
| C5 | constraint | respected | static_check | git diff 47008c9..517491f -- schema/ → empty. fallback-schema.json untouched; JSON schema extension deferred to follow-up ADV change. |
| C6 | constraint | pass | static_check | tr_mrsizqde_0a19cd23 — bun test full suite: 266 pass / 0 fail across 15 files. (pnpm wrapper fails on pre-existing esbuild/msgpackr-extract ignored-builds issue unrelated to this change; bypassed via bunx.) |
| C7 | constraint | pass | static_check | tr_mrsiznnh_ecbf202e — tsup build success via bunx tsup; dist/index.js 47.86KB, dist/index.d.ts 145B. (pnpm wrapper bypass same as C6.) |
| DONT1 | avoidance | respected | review | plugin/src/plugin-internal.ts:74-103 — extractCooldownOverrides + createPluginContext + createPluginHooks treat all ErrorCategory values uniformly via Partial<Record<ErrorCategory, number>>; no provider-keyed branches. |
| DONT2 | avoidance | respected | review | plugin/src/detection/classifier.ts untouched; no MiniMax-specific classifier branches added. |
| DONT3 | avoidance | respected | review | plugin/src/types.ts:79 — cooldownMs: 5 * 60_000 unchanged. Only cooldownMsByCategory extended with rate_limit:30min entry. |
| DONT4 | avoidance | respected | review | schema/ directory untouched. Confirmed by git diff --stat 47008c9..517491f. |
| DONT5 | avoidance | respected | review | Live ~/.config/opencode/opencode.jsonc — agent.explore.model remains 'openai/gpt-5.6-sol' (Path A mitigation). This change does NOT touch opencode.jsonc; explore re-swap deferred to separate small change once 30min cooldown proven in production. |
| DONT6 | avoidance | respected | review | plugin/src/types.ts:13-20 — ErrorCategory union unchanged. Same as C2 (constraint C2 = DONT6; both verified). |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-4dff33db1417 | C1 |  |  |  |
| tk-d449b5e1ecb3 |  | C1, C2, C3, C5 |  |  |
| tk-f16331122f6c | C2 |  |  |  |
| tk-7dbd8b39beb9 |  | C3, C4 |  |  |
| tk-0bccc3f135b3 | C2 | C5 |  |  |
| tk-aadb4ee0dc06 | C2 |  |  |  |
