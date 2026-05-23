# Contract Traceability

**Change ID:** fixPluginExportSurface
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | Export-surface contract test imports built plugin/dist/index.js and asserts Object.keys(module) === ["default"]. `bun test test/package-contract.test.ts` and `make test` passed. |
| AC2 | acceptance_criterion | pass | test | Export-surface test asserts default object keys are exactly ["id","server"], id is @sharper-flow/opencode-model-routing-plugin, and server is a function. Passed in package contract test. |
| AC3 | acceptance_criterion | pass | test | Export-surface test asserts module keys exactly ["default"]. Built export inspection returned {keys:["default"], defaultKeys:["id","server"]}. |
| AC4 | acceptance_criterion | pass | test | plugin.test imports createPluginContext/handleChatMessage/handleEvent from plugin-internal.ts and runtime tests through pluginModule.server. `bun test test/plugin.test.ts` passed 19 tests. |
| AC5 | acceptance_criterion | pass | test | RED: package contract test failed on current multi-function export shape. GREEN: same test passed after runtime/internal split. |
| AC6 | acceptance_criterion | pass | test | Existing plugin behavior tests passed: `bun test test/plugin.test.ts` 19 pass; full `make test` passed with 92 plugin tests. |
| AC7 | acceptance_criterion | pass | test | `make build-plugin`, `make test`, `make lint`, and `./scripts/deploy-local.sh --dry-run` all passed. |
| AC8 | acceptance_criterion | pass | test | With OMR enabled in ~/.config/opencode/opencode.jsonc, fresh `opencode models` exited 0. Log /home/jon/.local/share/opencode/log/2026-05-23T045626.log loads file:///home/jon/.local/share/opencode-model-routing/plugin and contains no ERROR lines or O.config/r.provider failures. |
| AC9 | acceptance_criterion | pass | test | OMR plugin path remains enabled in opencode.jsonc after live proof; deploy-local --check reports plugin registered. |
| C1 | constraint | respected | static_check | cmd/omp and build-omp were not touched; OMP compatibility unchanged. |
| C2 | constraint | respected | static_check | No changes to schema/fallback-schema.json or fallback_models config path; schema-contract-check passed in make lint. |
| C3 | constraint | respected | static_check | Changes limited to runtime export surface, internal module split, and tests; no routing/cooldown/TTFT/replay logic rewrite beyond imports. |
| C4 | constraint | respected | static_check | No OpenCode core repository files patched; only this plugin repo and global config enablement for live proof. |
| C5 | constraint | respected | static_check | Runtime id is @sharper-flow/opencode-model-routing-plugin in plugin.ts and asserted by export-surface test. |
| C6 | constraint | respected | static_check | Export-surface package test structurally checks module/object keys; logs used only for live proof absence of prior startup failures. |
| C7 | constraint | respected | static_check | make deploy-local and deploy-local --dry-run verify bundled package-shaped runtime dist/index.js; package.json still points at dist/index.js. |
| DONT1 | avoidance | respected | review | Built runtime exports only default; helper functions moved to plugin-internal.ts and are not exported from dist/index.js. |
| DONT2 | avoidance | respected | review | Default export is object-shaped {id, server}; export-surface test asserts typeof default is object and server is function. |
| DONT3 | avoidance | respected | review | Source-level split implemented; no tsup export hiding relied on. plugin.ts imports internals and only export default V1 object. |
| DONT4 | avoidance | respected | review | Live proof passed; OMR remains enabled. No broken config left behind. |
| DONT5 | avoidance | respected | review | No OMP removal tasks or file changes were performed; OMP removal remains a follow-up after proof. |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-cdac3728b507 | AC5 | AC1, AC2, AC3, AC5 | C5, C6, DONT1, DONT2, DONT3 |  |
| tk-68e271faad87 | AC1, AC2, AC3 | AC1, AC2, AC3 | C1, C2, C3, C4, C5, C6, C7, DONT1, DONT2, DONT3, DONT4 |  |
| tk-78e69a27ab91 | AC4, AC6 | AC4, AC6 | C1, C2, C3, C4, DONT4 |  |
| tk-6ecaa08576e6 |  | AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9 | C1, C2, C3, C4, C5, C6, C7, DONT1, DONT2, DONT3, DONT4, DONT5 |  |
