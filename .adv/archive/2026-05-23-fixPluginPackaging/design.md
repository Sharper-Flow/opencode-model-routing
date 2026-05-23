# Design

## Architecture Overview

Convert the plugin runtime from source-loaded TypeScript to a package-shaped bundled ESM artifact. OpenCode should resolve `plugin/package.json` to `./dist/index.js` and generated declarations, while local deploy installs only runtime package files.

## Components

1. **Package contract**
   - `plugin/package.json` `main`, `types`, and `exports` point at `./dist/index.js` / `./dist/index.d.ts`.
   - `exports["."]` and `exports["./server"]` both expose the runtime entry because OpenCode can resolve plugin server entries through package exports.
   - `prepack` runs the build so packed/git-installed usage includes generated runtime files.
   - Runtime package has no production `dependencies`; OpenCode and build tooling remain dev dependencies because the runtime bundle is self-contained.

2. **Build pipeline**
   - `tsup` builds `plugin/src/plugin.ts` to `plugin/dist/index.js` as ESM with declarations.
   - Config uses a single entry, `splitting: false`, `sourcemap: false`, and `clean: true` to avoid stale bundle output.
   - `make build-plugin` runs frozen install, typecheck, and build in sequence.

3. **Deploy pipeline**
   - `scripts/deploy-local.sh` verifies `dist/index.js`, `dist/index.d.ts`, and package metadata before deploy.
   - Deploy copies a package-shaped runtime (`package.json`, `dist/`, optional `NOTICE`) to the local OpenCode plugin path.
   - Dry-run still verifies the runtime bundle so missing artifacts fail before any deploy.
   - JSONC config patching remains conservative: validation is best-effort and auto-patch refuses JSONC to avoid comment loss.

4. **Hook compatibility boundary**
   - Keep defensive no-op guards for undefined `chat.message` input/output and undefined event input.
   - Add a narrow event input normalizer that unwraps canonical OpenCode `{ event }` payloads before dispatch.
   - Preserve existing fallback routing, cooldown, TTFT, model-resolution semantics, and user-facing config schema.

5. **Verification surfaces**
   - Package contract tests assert runtime metadata and scripts.
   - Plugin tests cover undefined probe inputs and canonical `{ event }` dispatch.
   - Makefile/deploy contract script asserts build-plugin and deploy-local invariants.
   - README describes the fixed build/deploy/restart path, not a workaround.

## Lowest-Bad-Path Decisions

- Use `tsup` despite maintenance-mode caution because it is small, familiar, supports ESM + declaration generation in one command, and fits the single-entry plugin package better than Bun's bundler for declaration output.
- Keep the default plugin function export instead of migrating to a new plugin shape; the failure is packaging/boundary compatibility, not runtime API semantics.
- Keep event normalization narrow to `{ event }` instead of adding broad heuristic shape inference.
- Make package metadata and deploy validation machine-checked contracts, not prose-only instructions.

## Risks and Mitigations

- **Bundle missing or stale**: `make build-plugin`, `prepack`, deploy verification, and package contract tests catch missing artifacts.
- **OpenCode wrapper mismatch persists**: plugin tests exercise the canonical wrapped payload through the default export hook.
- **Runtime node_modules dependency**: bundle and deploy package-shaped runtime without `node_modules`; production deps remain empty.
- **Scope drift into OpenCode core or routing behavior**: implementation stays in package/build/deploy/hook-boundary files and preserves routing schema.

## Validation Plan

- `bun test` in `plugin/`.
- `bun run typecheck` in `plugin/`.
- `bun run build` in `plugin/`.
- `./scripts/test-makefile-targets.sh`.
- `make build-plugin`.
- `./scripts/deploy-local.sh --dry-run`.
- Missing-bundle dry-run failure check.
- `make test` and `make lint` for final verification.