# Fix plugin packaging

## Why

OpenCode 1.15.9 can fail startup when this plugin is loaded from raw TypeScript (`main: "src/plugin.ts"`) with sibling `.ts` imports. Once defensive hook guards allow the plugin to load successfully, OpenCode's plugin/provider initialization can leave downstream provider config hooks unrun, causing `provider.list` / `config.providers` bootstrap failure.

Desired outcome: make plugin packaging and hook handling compatible with OpenCode 1.15.9 by shipping a bundled ESM JavaScript entry, preserving defensive guards for undefined hook inputs, updating local deploy/build contracts so the deployed plugin always has a valid runtime entry, and documenting compatibility/deploy expectations.

## What Changes

- Replace raw TypeScript plugin runtime entry with a bundled ESM JavaScript entry under `plugin/dist/`.
- Add build tooling and package metadata so OpenCode loads `dist/index.js` instead of `src/plugin.ts`.
- Keep defensive hook guards for undefined `chat.message` input/output and undefined event input.
- Support OpenCode's canonical event hook wrapper shape `{ event }` for the affected hook path.
- Update local deploy flow to build first, require the bundled entry and declarations to exist, deploy package-shaped runtime files, and keep dependencies bundled rather than runtime-required.
- Update docs and Make targets so install/deploy instructions describe the bundled runtime contract.
- Verify OpenCode 1.15.9 compatibility through source-backed reasoning and local tests.
- Add package `exports` entries for `.` and `./server` using `./dist/index.js` and generated declarations.
- Add package lifecycle coverage such as `prepack`, so packed/git-installed copies do not miss the runtime bundle.

## Success Criteria

1. `plugin/package.json` runtime entry points at bundled JavaScript, not `src/plugin.ts`, exposes matching generated declarations, and has `exports` entries for `.` and `./server` using `./dist/index.js` with `./` prefixes.
2. `make build-plugin` produces the bundled plugin artifact and fails if typecheck or bundle generation fails.
3. `scripts/deploy-local.sh` refuses or clearly errors when the bundled runtime entry is missing, and deploys the built runtime shape expected by OpenCode.
4. Plugin tests cover undefined `chat.message` input/output and undefined event input as no-op compatibility cases.
5. Full plugin verification passes: `bun test` and `bun run typecheck` from `plugin/`.
6. Repo-level verification for touched contracts passes: relevant `make` targets and schema contract checks selected during planning.
7. README / install docs accurately describe build/deploy behavior and OpenCode restart expectations.
8. Package lifecycle scripts prevent missing bundles for local deploy and packed/git-installed plugin usage.

## Scope

### In Scope

- `plugin/package.json` build scripts, runtime entry metadata, exports map, dependency/devDependency/build tooling contract, lifecycle scripts, and package files contract.
- Plugin bundling configuration needed to emit a single ESM runtime entry and declaration files.
- `plugin/src/plugin.ts` defensive compatibility guards for OpenCode hook probe behavior.
- OpenCode event hook wrapper support for canonical `{ event }` payloads.
- Plugin tests around hook-probe no-op behavior, event-wrapper behavior, and packaging/build invariants.
- `scripts/deploy-local.sh`, `Makefile`, and README install/deploy docs for the bundled runtime contract.
- Local and package distribution paths: deployed local-share plugin and packed/git-installed plugin artifact shape.
- Local verification commands for plugin tests, typecheck, and deployment/build flow.

### Out of Scope

- Fixing OpenCode core plugin-loader internals.
- Publishing a new npm release.
- Rewriting fallback orchestration, cooldown behavior, TTFT behavior, or model resolution semantics.
- Changing user-facing fallback configuration schema (`agent.<name>.options.fallback_models`).
- Migrating all OpenCode event handling semantics beyond compatibility necessary for the affected hooks.
- Adding session lifecycle hygiene handlers such as `session.deleted` or `session.compacted`.
- Adding workaround-focused documentation; docs should stay focused on the fixed build/deploy/restart path.

### Must Not

- Must not leave OpenCode loading this plugin through `src/plugin.ts` in the deployed/runtime package.
- Must not require runtime `node_modules/` in the local deployed plugin if dependencies are bundled.
- Must not silently deploy a package whose `main` points to a missing file.
- Must not mask plugin startup errors by letting the plugin fail to load as a workaround.
- Must not expand into OpenCode upstream changes inside this repo.
- Must not rely only on heuristic status-message matching when a structured OpenCode event field is verified and in scope for a touched handler.
- Must not add workaround-focused README sections; document the fixed path instead.

## Affected Code

- `plugin/package.json`
- `plugin/tsup.config.ts`
- `plugin/src/plugin.ts`
- `plugin/test/plugin.test.ts`
- `plugin/test/package-contract.test.ts`
- `scripts/deploy-local.sh`
- `scripts/test-makefile-targets.sh`
- `Makefile`
- `README.md`

## Constraints

- Preserve existing fallback routing behavior except where defensive hook guards turn probe-time invalid inputs into no-ops.
- Keep OpenCode 1.15.9 compatibility as the primary target for this fix.
- Prefer structural packaging fix over workaround instructions or load-failure masking.
- Keep local deploy compatible with JSON and JSONC OpenCode config handling already present in `scripts/deploy-local.sh`.
- Keep verification local and repeatable where possible.