# Acceptance

Reviewed at: 2026-07-20T04:59:52.878Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| C1 | constraint | No breaking changes to `PluginConfig` type shape (additive only). | respected | plugin/src/plugin-internal.ts:74-103 — createPluginContext signature gained additive cooldownOverrides?: Partial<Record<ErrorCategory, number>> param; PluginConfig type itself unchanged; 3-layer merge preserves all existing fields. No breaking shape change. |
| C2 | constraint | No changes to `ErrorCategory` union (`types.ts:13-20`). | respected | plugin/src/types.ts:13-20 — ErrorCategory union unchanged (rate_limit, server_error, unknown_model, auth_error, ttft_timeout, quota_exhausted, unknown). |
| C3 | constraint | No changes to detection patterns or classifier categories. | respected | git diff 47008c9..517491f -- plugin/src/detection/ → empty. classifier.ts + patterns.ts untouched. |
| C4 | constraint | No Go-side writer changes in this change. | respected | git diff 47008c9..517491f -- cmd/ internal/ → empty. Go-side writer (omr binary) untouched; field not yet emitted by writer (deferred follow-up). |
| C5 | constraint | No JSON schema changes in this change (deferred to follow-up). | respected | git diff 47008c9..517491f -- schema/ → empty. fallback-schema.json untouched; JSON schema extension deferred to follow-up ADV change. |
| C6 | constraint | All changes validated via `pnpm test` (Bun test runner). | pass | tr_mrsizqde_0a19cd23 — bun test full suite: 266 pass / 0 fail across 15 files. (pnpm wrapper fails on pre-existing esbuild/msgpackr-extract ignored-builds issue unrelated to this change; bypassed via bunx.) |
| C7 | constraint | Build via `pnpm run build` (tsup). | pass | tr_mrsiznnh_ecbf202e — tsup build success via bunx tsup; dist/index.js 47.86KB, dist/index.d.ts 145B. (pnpm wrapper bypass same as C6.) |
| DONT1 | avoidance | Do NOT add provider-specific cooldown logic (Approach D in LBP analysis) — over-engineered for one-provider edge. | respected | plugin/src/plugin-internal.ts:74-103 — extractCooldownOverrides + createPluginContext + createPluginHooks treat all ErrorCategory values uniformly via Partial<Record<ErrorCategory, number>>; no provider-keyed branches. |
| DONT2 | avoidance | Do NOT add MiniMax-specific classifier branches (Approach E in LBP analysis) — heuristic anti-pattern P33 warns against; brittle on error-body drift. | respected | plugin/src/detection/classifier.ts untouched; no MiniMax-specific classifier branches added. |
| DONT3 | avoidance | Do NOT bump global `cooldownMs` default (Approach F) — over-corrects; trades one wrong assumption for another. | respected | plugin/src/types.ts:79 — cooldownMs: 5 * 60_000 unchanged. Only cooldownMsByCategory extended with rate_limit:30min entry. |
| DONT4 | avoidance | Do NOT include JSON schema extension — separable follow-up; schema design (enum enforcement, `Infinity` JSON representation, schema file location) deserves its own change. | respected | schema/ directory untouched. Confirmed by git diff --stat 47008c9..517491f. |
| DONT5 | avoidance | Do NOT bundle `explore` primary re-swap — separate change once 30min cooldown proven in production. | respected | Live ~/.config/opencode/opencode.jsonc — agent.explore.model remains 'openai/gpt-5.6-sol' (Path A mitigation). This change does NOT touch opencode.jsonc; explore re-swap deferred to separate small change once 30min cooldown proven in production. |
| DONT6 | avoidance | Do NOT change `ErrorCategory` union membership — out of scope for this fix. | respected | plugin/src/types.ts:13-20 — ErrorCategory union unchanged. Same as C2 (constraint C2 = DONT6; both verified). |

