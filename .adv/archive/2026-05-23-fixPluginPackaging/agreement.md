# Agreement

## Objectives

1. Ship OpenCode-compatible bundled plugin runtime with `dist/index.js`, generated declarations, and explicit package exports.
2. Enforce bundle existence through build, deploy, and package lifecycle scripts before users load the plugin.
3. Preserve startup safety through no-op defensive handling for invalid OpenCode hook probe inputs.
4. Include the OpenCode event wrapper mismatch fix if design confirms canonical `{ event }` payload for the target OpenCode versions.
5. Document the LBP fixed build/deploy/restart path without adding workaround-focused documentation.

## Acceptance Criteria

1. `plugin/package.json` loads runtime from bundled JS (`dist/index.js`), not `src/plugin.ts`.
2. Package metadata includes `types` and `exports["."]` / `exports["./server"]` with `./dist/index.js` paths.
3. `make build-plugin` generates bundle + declarations and fails on typecheck/build errors.
4. `scripts/deploy-local.sh` refuses missing bundle and deploys valid bundled runtime shape.
5. Package lifecycle supports local deploy and packed/git-installed usage; no runtime `node_modules` dependency if bundled.
6. Defensive hook guards keep undefined `chat.message` and `event` probe inputs as no-op.
7. If design confirms OpenCode event wrapper mismatch, handler supports canonical `{ event }` shape in this change.
8. Tests cover hook guards, event wrapper behavior if included, package metadata/build invariant, and deploy missing-bundle failure.
9. Verification passes: plugin tests, typecheck, relevant Make/deploy checks.
10. README documents LBP fixed build/deploy/restart path; no workaround-focused section.

## Constraints

1. Preserve existing fallback routing behavior except for compatibility no-op guards and confirmed event wrapper compatibility.
2. Keep OpenCode 1.15.9 compatibility as primary target.
3. Use public OpenCode plugin/package surfaces; do not patch OpenCode core.
4. Keep `agent.<name>.options.fallback_models` schema unchanged.
5. Prefer structural packaging/build guarantees over workaround instructions or load-failure masking.
6. Keep verification local and repeatable where possible.

## Avoidances

1. Do not leave OpenCode loading this plugin through `src/plugin.ts` in runtime package metadata.
2. Do not require runtime `node_modules/` in the local deployed plugin if dependencies are bundled.
3. Do not silently deploy a package whose `main` points to a missing file.
4. Do not mask plugin startup errors by letting plugin load fail as workaround.
5. Do not expand into OpenCode upstream changes inside this repo.
6. Do not rewrite fallback orchestration, cooldown behavior, TTFT behavior, model resolution semantics, or user-facing schema.
7. Do not add workaround-focused README sections; document the fixed path instead.
8. Do not add `session.deleted` / `session.compacted` lifecycle hygiene handlers in this change; carry as follow-up if still valuable.

## Decisions

### User Decisions

- Event wrapper scope: include the OpenCode event wrapper mismatch fix if design confirms it.
- Distribution scope: guarantee both local deploy and packed/git-installed package usage.
- Documentation scope: keep README focused on the LBP fixed path; do not add workaround-focused documentation.

### Agent Decisions (LBP)

- Prefer `tsup` for bundling because it supports ESM bundling, declaration generation, clean output, and no-splitting configuration in one build surface.
- Treat Bun build as less suitable for this package because Bun documentation says its bundler is not intended to replace `tsc` for declaration generation.
- Include package `exports` for `.` and `./server` because OpenCode resolver checks server exports before `main`.
- Use `./`-prefixed dist paths in package metadata to stay inside package containment checks.

## Deferred Questions

None.

## Sign-Off

Acceptance criteria approved by user reply: `approve`.