# Acceptance

Reviewed at: 

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| AC1 | acceptance_criterion | `plugin/package.json` loads runtime from bundled JS (`dist/index.js`), not `src/plugin.ts`. | pass | plugin/package.json main is ./dist/index.js; package-contract test asserts not src/ or .ts; deploy verifies dist/index.js. |
| AC2 | acceptance_criterion | Package metadata includes `types` and `exports["."]` / `exports["./server"]` with `./dist/index.js` paths. | pass | plugin/package.json types plus exports . and ./server point to ./dist/index.d.ts and ./dist/index.js; package-contract test covers these paths. |
| AC3 | acceptance_criterion | `make build-plugin` generates bundle + declarations and fails on typecheck/build errors. | pass | Makefile build-plugin runs bun install --frozen-lockfile, bun run typecheck, bun run build; ./scripts/test-makefile-targets.sh passed. |
| AC4 | acceptance_criterion | `scripts/deploy-local.sh` refuses missing bundle and deploys valid bundled runtime shape. | pass | scripts/deploy-local.sh verify_runtime_bundle checks dist/index.js and dist/index.d.ts before deploy; final verification included deploy dry-run success and missing-bundle dry-run failure. |
| AC5 | acceptance_criterion | Package lifecycle supports local deploy and packed/git-installed usage; no runtime `node_modules` dependency if bundled. | pass | plugin/package.json has prepack build script, no runtime dependencies field, package files dist/NOTICE; deploy output is package-shaped runtime without node_modules. |
| AC6 | acceptance_criterion | Defensive hook guards keep undefined `chat.message` and `event` probe inputs as no-op. | pass | plugin tests cover undefined chat.message input/output and undefined event input/hook payload as no-op; bun test passed 88 tests. |
| AC7 | acceptance_criterion | If design confirms OpenCode event wrapper mismatch, handler supports canonical `{ event }` shape in this change. | pass | plugin/src/plugin.ts normalizes canonical { event } payload before handleEvent; plugin test verifies wrapped session.error dispatch triggers fallback; bun test passed. |
| AC8 | acceptance_criterion | Tests cover hook guards, event wrapper behavior if included, package metadata/build invariant, and deploy missing-bundle failure. | pass | plugin tests cover hook guards and event wrapper; package-contract test covers package metadata/build scripts; Makefile contract script covers deploy missing-bundle verification surface. |
| AC9 | acceptance_criterion | Verification passes: plugin tests, typecheck, relevant Make/deploy checks. | pass | Verification passed: bun test (88 pass), bun run typecheck, bun run build, ./scripts/test-makefile-targets.sh, make build-plugin, deploy-local dry-run, missing-bundle failure, make test, make lint. After acceptance remediation: bun test, typecheck, test-makefile-targets passed. |
| AC10 | acceptance_criterion | README documents LBP fixed build/deploy/restart path; no workaround-focused section. | pass | README plugin section documents make build-plugin, make deploy-local, bundled package-shaped runtime, and OpenCode restart; search found no workaround-focused wording. |
| C1 | constraint | Preserve existing fallback routing behavior except for compatibility no-op guards and confirmed event wrapper compatibility. | respected | Review found fallback behavior unchanged except hook boundary guards/event wrapper normalization; no fallback schema/orchestration rewrite. |
| C2 | constraint | Keep OpenCode 1.15.9 compatibility as primary target. | respected | OpenCode 1.15.9 compatibility addressed by bundled ESM entry and canonical { event } wrapper support; tests lock probe no-op behavior. |
| C3 | constraint | Use public OpenCode plugin/package surfaces; do not patch OpenCode core. | respected | All changes confined to this repo; no OpenCode core patch or upstream modifications; cross-repo review passed. |
| C4 | constraint | Keep `agent.<name>.options.fallback_models` schema unchanged. | respected | agent.<name>.options.fallback_models schema unchanged; config loader/model routing semantics not rewritten. |
| C5 | constraint | Prefer structural packaging/build guarantees over workaround instructions or load-failure masking. | respected | Package metadata tests, Makefile contract tests, deploy bundle validation, and package-shaped deploy provide structural guarantees. |
| C6 | constraint | Keep verification local and repeatable where possible. | respected | Local repeatable checks passed: bun test, typecheck, build, Make/deploy contract checks, make test, make lint. |
| DONT1 | avoidance | Do not leave OpenCode loading this plugin through `src/plugin.ts` in runtime package metadata. | respected | plugin/package.json main is ./dist/index.js; deploy runtime entry is dist/index.js; package-contract test rejects src/.ts main. |
| DONT2 | avoidance | Do not require runtime `node_modules/` in the local deployed plugin if dependencies are bundled. | respected | No runtime dependencies field; deploy copies dist/package metadata only, not node_modules. |
| DONT3 | avoidance | Do not silently deploy a package whose `main` points to a missing file. | respected | deploy-local verify_runtime_bundle refuses missing dist/index.js/dist/index.d.ts before deploy; missing-bundle dry-run failed as expected. |
| DONT4 | avoidance | Do not mask plugin startup errors by letting plugin load fail as workaround. | respected | Implementation fixes packaging/hook boundary directly; README avoids workaround language and does not rely on plugin load failure. |
| DONT5 | avoidance | Do not expand into OpenCode upstream changes inside this repo. | respected | Cross-repo review passed; no upstream OpenCode files or patches touched. |
| DONT6 | avoidance | Do not rewrite fallback orchestration, cooldown behavior, TTFT behavior, model resolution semantics, or user-facing schema. | respected | No rewrite to fallback orchestration, cooldown behavior, TTFT behavior, model resolution semantics, or schema; only package/hook compatibility changed. |
| DONT7 | avoidance | Do not add workaround-focused README sections; document the fixed path instead. | respected | README updated with fixed build/deploy/restart path; review found no workaround-focused section/wording. |
| DONT8 | avoidance | Do not add `session.deleted` / `session.compacted` lifecycle hygiene handlers in this change; carry as follow-up if still valuable. | respected | No session.deleted/session.compacted lifecycle handlers added. |

