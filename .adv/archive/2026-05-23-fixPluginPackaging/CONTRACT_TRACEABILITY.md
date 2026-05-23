# Contract Traceability

**Change ID:** fixPluginPackaging
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | plugin/package.json main is ./dist/index.js; package-contract test asserts not src/ or .ts; deploy verifies dist/index.js. |
| AC2 | acceptance_criterion | pass | test | plugin/package.json types plus exports . and ./server point to ./dist/index.d.ts and ./dist/index.js; package-contract test covers these paths. |
| AC3 | acceptance_criterion | pass | test | Makefile build-plugin runs bun install --frozen-lockfile, bun run typecheck, bun run build; ./scripts/test-makefile-targets.sh passed. |
| AC4 | acceptance_criterion | pass | test | scripts/deploy-local.sh verify_runtime_bundle checks dist/index.js and dist/index.d.ts before deploy; final verification included deploy dry-run success and missing-bundle dry-run failure. |
| AC5 | acceptance_criterion | pass | test | plugin/package.json has prepack build script, no runtime dependencies field, package files dist/NOTICE; deploy output is package-shaped runtime without node_modules. |
| AC6 | acceptance_criterion | pass | test | plugin tests cover undefined chat.message input/output and undefined event input/hook payload as no-op; bun test passed 88 tests. |
| AC7 | acceptance_criterion | pass | test | plugin/src/plugin.ts normalizes canonical { event } payload before handleEvent; plugin test verifies wrapped session.error dispatch triggers fallback; bun test passed. |
| AC8 | acceptance_criterion | pass | test | plugin tests cover hook guards and event wrapper; package-contract test covers package metadata/build scripts; Makefile contract script covers deploy missing-bundle verification surface. |
| AC9 | acceptance_criterion | pass | test | Verification passed: bun test (88 pass), bun run typecheck, bun run build, ./scripts/test-makefile-targets.sh, make build-plugin, deploy-local dry-run, missing-bundle failure, make test, make lint. After acceptance remediation: bun test, typecheck, test-makefile-targets passed. |
| AC10 | acceptance_criterion | pass | test | README plugin section documents make build-plugin, make deploy-local, bundled package-shaped runtime, and OpenCode restart; search found no workaround-focused wording. |
| C1 | constraint | respected | static_check | Review found fallback behavior unchanged except hook boundary guards/event wrapper normalization; no fallback schema/orchestration rewrite. |
| C2 | constraint | respected | static_check | OpenCode 1.15.9 compatibility addressed by bundled ESM entry and canonical { event } wrapper support; tests lock probe no-op behavior. |
| C3 | constraint | respected | static_check | All changes confined to this repo; no OpenCode core patch or upstream modifications; cross-repo review passed. |
| C4 | constraint | respected | static_check | agent.<name>.options.fallback_models schema unchanged; config loader/model routing semantics not rewritten. |
| C5 | constraint | respected | static_check | Package metadata tests, Makefile contract tests, deploy bundle validation, and package-shaped deploy provide structural guarantees. |
| C6 | constraint | respected | static_check | Local repeatable checks passed: bun test, typecheck, build, Make/deploy contract checks, make test, make lint. |
| DONT1 | avoidance | respected | review | plugin/package.json main is ./dist/index.js; deploy runtime entry is dist/index.js; package-contract test rejects src/.ts main. |
| DONT2 | avoidance | respected | review | No runtime dependencies field; deploy copies dist/package metadata only, not node_modules. |
| DONT3 | avoidance | respected | review | deploy-local verify_runtime_bundle refuses missing dist/index.js/dist/index.d.ts before deploy; missing-bundle dry-run failed as expected. |
| DONT4 | avoidance | respected | review | Implementation fixes packaging/hook boundary directly; README avoids workaround language and does not rely on plugin load failure. |
| DONT5 | avoidance | respected | review | Cross-repo review passed; no upstream OpenCode files or patches touched. |
| DONT6 | avoidance | respected | review | No rewrite to fallback orchestration, cooldown behavior, TTFT behavior, model resolution semantics, or schema; only package/hook compatibility changed. |
| DONT7 | avoidance | respected | review | README updated with fixed build/deploy/restart path; review found no workaround-focused section/wording. |
| DONT8 | avoidance | respected | review | No session.deleted/session.compacted lifecycle handlers added. |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-5d1132fc39e4 | AC1, AC2, AC5 | AC1, AC2, AC5 | C1, C2, C3, C4, C5, C6, DONT1, DONT2, DONT3, DONT4, DONT5, DONT6, DONT7, DONT8 |  |
| tk-6c99b7eed4eb | AC6, AC7 | AC6, AC7, AC8 | C1, C2, C3, C4, DONT4, DONT5, DONT6, DONT8 |  |
| tk-5031ecb4d1c3 | AC3 | AC3, AC9 | C2, C5, C6, DONT3, DONT4, DONT5, DONT6, DONT7 |  |
| tk-ff51b1990356 | AC4, AC5 | AC4, AC5, AC8 | C2, C3, C5, C6, DONT1, DONT2, DONT3, DONT4, DONT5, DONT7 |  |
| tk-dc14c13c9253 | AC10 | AC10 | C2, C5, C6, DONT4, DONT7 |  |
| tk-ab230e32f94e |  | AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9, AC10 | C1, C2, C3, C4, C5, C6, DONT1, DONT2, DONT3, DONT4, DONT5, DONT6, DONT7, DONT8 |  |
