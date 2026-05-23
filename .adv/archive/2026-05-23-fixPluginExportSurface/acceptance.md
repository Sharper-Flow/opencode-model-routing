# Acceptance

Reviewed at: 

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| AC1 | acceptance_criterion | Built runtime import of `plugin/dist/index.js` exposes exactly one module export: `default`. | pass | Export-surface contract test imports built plugin/dist/index.js and asserts Object.keys(module) === ["default"]. `bun test test/package-contract.test.ts` and `make test` passed. |
| AC2 | acceptance_criterion | `default` is an object-shaped OpenCode V1 plugin module with stable `id` and function-valued `server`. | pass | Export-surface test asserts default object keys are exactly ["id","server"], id is @sharper-flow/opencode-model-routing-plugin, and server is a function. Passed in package contract test. |
| AC3 | acceptance_criterion | No helper functions (`createPluginContext`, `handleChatMessage`, `handleEvent`, normalizers, or test seams) are exported from `plugin/dist/index.js`. | pass | Export-surface test asserts module keys exactly ["default"]. Built export inspection returned {keys:["default"], defaultKeys:["id","server"]}. |
| AC4 | acceptance_criterion | Existing plugin behavior remains covered through an internal/testable source module. | pass | plugin.test imports createPluginContext/handleChatMessage/handleEvent from plugin-internal.ts and runtime tests through pluginModule.server. `bun test test/plugin.test.ts` passed 19 tests. |
| AC5 | acceptance_criterion | Runtime export-surface test fails on the current multi-function export shape and passes after the fix. | pass | RED: package contract test failed on current multi-function export shape. GREEN: same test passed after runtime/internal split. |
| AC6 | acceptance_criterion | Existing plugin behavior tests pass after imports are updated to the internal module. | pass | Existing plugin behavior tests passed: `bun test test/plugin.test.ts` 19 pass; full `make test` passed with 92 plugin tests. |
| AC7 | acceptance_criterion | `make build-plugin`, `make test`, `make lint`, and `./scripts/deploy-local.sh --dry-run` pass. | pass | `make build-plugin`, `make test`, `make lint`, and `./scripts/deploy-local.sh --dry-run` all passed. |
| AC8 | acceptance_criterion | Live proof passes with OMR enabled in `~/.config/opencode/opencode.jsonc`: fresh `opencode models` exits 0 and does not log `O.config` or `r.provider` startup failures. | pass | With OMR enabled in ~/.config/opencode/opencode.jsonc, fresh `opencode models` exited 0. Log /home/jon/.local/share/opencode/log/2026-05-23T045626.log loads file:///home/jon/.local/share/opencode-model-routing/plugin and contains no ERROR lines or O.config/r.provider failures. |
| AC9 | acceptance_criterion | OMR remains enabled after live proof; if proof fails, OMR is re-disabled and failure evidence is preserved. | pass | OMR plugin path remains enabled in opencode.jsonc after live proof; deploy-local --check reports plugin registered. |
| C1 | constraint | Do not remove OMP compatibility in this change. | respected | cmd/omp and build-omp were not touched; OMP compatibility unchanged. |
| C2 | constraint | Do not change user-facing fallback config schema (`agent.<name>.options.fallback_models`). | respected | No changes to schema/fallback-schema.json or fallback_models config path; schema-contract-check passed in make lint. |
| C3 | constraint | Do not rewrite fallback routing behavior, cooldown behavior, TTFT policy, or replay orchestration except for mechanical imports required by the export-surface fix. | respected | Changes limited to runtime export surface, internal module split, and tests; no routing/cooldown/TTFT/replay logic rewrite beyond imports. |
| C4 | constraint | Do not patch OpenCode core. | respected | No OpenCode core repository files patched; only this plugin repo and global config enablement for live proof. |
| C5 | constraint | Keep the plugin `id` stable once chosen: `@sharper-flow/opencode-model-routing-plugin`. | respected | Runtime id is @sharper-flow/opencode-model-routing-plugin in plugin.ts and asserted by export-surface test. |
| C6 | constraint | Prefer structural source/package/export tests over heuristic log matching for correctness; log checks are live-proof evidence only. | respected | Export-surface package test structurally checks module/object keys; logs used only for live proof absence of prior startup failures. |
| C7 | constraint | Keep local deploy package-shaped and bundled; do not revert to raw TypeScript loading. | respected | make deploy-local and deploy-local --dry-run verify bundled package-shaped runtime dist/index.js; package.json still points at dist/index.js. |
| DONT1 | avoidance | Do not leave function-valued helper exports on the runtime package entry. | respected | Built runtime exports only default; helper functions moved to plugin-internal.ts and are not exported from dist/index.js. |
| DONT2 | avoidance | Do not make `default` a plugin function; that still triggers legacy fallback. It must be an object-shaped V1 module. | respected | Default export is object-shaped {id, server}; export-surface test asserts typeof default is object and server is function. |
| DONT3 | avoidance | Do not rely on tsup-specific export hiding without a source-level runtime/internal split unless proven structurally by tests. | respected | Source-level split implemented; no tsup export hiding relied on. plugin.ts imports internals and only export default V1 object. |
| DONT4 | avoidance | Do not leave OpenCode config broken if live proof fails. | respected | Live proof passed; OMR remains enabled. No broken config left behind. |
| DONT5 | avoidance | Do not proceed to OMP removal before this change passes live proof. | respected | No OMP removal tasks or file changes were performed; OMP removal remains a follow-up after proof. |

