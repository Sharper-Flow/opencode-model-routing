# Contract Traceability

**Change ID:** fixOmrConfigHookChainLoading
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 2026-05-23T20:37:09.488Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | test/plugin.test.ts:468 'config hook is registered on returned hooks' passes; plugin-internal.ts createPluginHooks returns config callback typed (input: unknown) => Promise<void> |
| AC2 | acceptance_criterion | pass | test | test/plugin.test.ts:520 'config hook re-invocation updates chain in-place + new chain used' passes; verifies clear()+set() mutation preserves Map identity AND new chain is used |
| AC3 | acceptance_criterion | pass | test | grep confirms zero rawConfig references in plugin/ tree; createPluginContext signature only accepts {config?: Partial<PluginConfig>, logger?: Logger} |
| AC4 | acceptance_criterion | pass | test | plugin-internal.ts:31 PluginInput interface contains only {client, directory?, worktree?} — config field removed; documented match with @opencode-ai/plugin@1.15.5 SDK shape |
| AC5 | acceptance_criterion | pass | test | test/plugin.test.ts:473 'init → config → event triggers fallback with chain from cfg' passes with model-args assertion (providerID:anthropic, modelID:claude) |
| AC6 | acceptance_criterion | pass | test | test/plugin.test.ts:490 'ordering violation: event before config' passes — no crash, no fallback, recovers after config |
| AC7 | acceptance_criterion | pass | test | 117/117 tests pass; ctxWithChain helper migrated to direct chain mutation; createRuntimeHooks helper invokes config hook for legacy test call sites |
| AC8 | acceptance_criterion | pass | test | make deploy-local: bun typecheck pass, tsup build success (dist/index.js 23.92KB → latest also clean), 117/117 tests pass |
| AC9 | acceptance_criterion | pass | test | make deploy-local reports 'runtime bundle verified', 'deployed plugin', 'plugin registered'; diff -q on dist/index.js clean |
| C1 | constraint | respected | static_check | loadFallbackChains function signature unchanged: (cfg: ConfigShape | unknown, logger?: Logger) => LoaderResult |
| C2 | constraint | respected | static_check | No disk-read added; loadFallbackChains called only from createPluginHooks config callback |
| C3 | constraint | respected | static_check | No client.config.get() lazy hydration added (OOS6 deferred); fix uses only Hooks.config channel |
| C4 | constraint | respected | static_check | Map identity stability: config hook uses ctx.chains.clear() + ctx.chains.set() — verified by re-invocation test and Map identity test |
| C5 | constraint | respected | static_check | PluginInput / PluginHooks / SessionErrorData all typed structurally per OpenCode SDK shapes; no heuristic inference |
| C6 | constraint | respected | static_check | git diff main..HEAD shows zero changes outside plugin/ subtree; no OpenCode core files touched |
| OOS1 | out_of_scope | not_applicable | not_applicable | Out-of-scope: no OpenCode upstream PluginInput type fix attempted |
| OOS2 | out_of_scope | not_applicable | not_applicable | Out-of-scope: classifier work shipped in parent fixOmrUsageCapFallbackGap |
| OOS3 | out_of_scope | not_applicable | not_applicable | Out-of-scope: no new config-driven features added |
| OOS4 | out_of_scope | not_applicable | not_applicable | Out-of-scope: no multi-tier config merging added beyond what OpenCode delivers |
| OOS5 | out_of_scope | not_applicable | not_applicable | Out-of-scope: hot-reload not implemented (OpenCode-side behavior) |
| OOS6 | out_of_scope | not_applicable | not_applicable | Out-of-scope: lazy client.config.get() hydration deferred to future change if multi-version support becomes a concern |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-c89a60c5a0e6 | AC1, AC2, AC3, AC4 | AC1, AC2, AC3, AC4, AC5, AC6, AC7 | C1, C2, C3, C4, C5, C6 |  |
| tk-b2e0c4082fae |  | AC8, AC9 |  | Build/deploy task; no TDD applicable. Verification is dist file equality + deploy script success. |
