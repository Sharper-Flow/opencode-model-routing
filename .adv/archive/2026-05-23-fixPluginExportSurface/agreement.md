# Agreement

## Objectives

1. Fix OMR live OpenCode startup by preventing legacy export enumeration from treating helper functions as plugins.
2. Adopt OpenCode V1 plugin module shape for the runtime entry: default object with stable `id` and `server` function.
3. Preserve testability through an internal source module that is not the package runtime entry.
4. Add structural tests proving the built runtime export surface is safe.
5. Prove the fix live with OMR enabled and `opencode models` passing.
6. Keep OMP removal blocked until live proof passes.

## Acceptance Criteria

1. Built runtime import of `plugin/dist/index.js` exposes exactly one module export: `default`.
2. `default` is an object-shaped OpenCode V1 plugin module with stable `id` and function-valued `server`.
3. No helper functions (`createPluginContext`, `handleChatMessage`, `handleEvent`, normalizers, or test seams) are exported from `plugin/dist/index.js`.
4. Existing plugin behavior remains covered through an internal/testable source module.
5. Runtime export-surface test fails on the current multi-function export shape and passes after the fix.
6. Existing plugin behavior tests pass after imports are updated to the internal module.
7. `make build-plugin`, `make test`, `make lint`, and `./scripts/deploy-local.sh --dry-run` pass.
8. Live proof passes with OMR enabled in `~/.config/opencode/opencode.jsonc`: fresh `opencode models` exits 0 and does not log `O.config` or `r.provider` startup failures.
9. OMR remains enabled after live proof; if proof fails, OMR is re-disabled and failure evidence is preserved.

## Constraints

1. Do not remove OMP compatibility in this change.
2. Do not change `agent.<name>.options.fallback_models` schema.
3. Do not rewrite fallback routing, cooldown, TTFT, or replay orchestration except mechanical imports required by the split.
4. Do not patch OpenCode core.
5. Keep plugin id stable: `@sharper-flow/opencode-model-routing-plugin`.
6. Prefer structural source/package/export tests over heuristic log matching.
7. Keep local deploy package-shaped and bundled.

## Avoidances

1. Do not leave function-valued helper exports on the runtime entry.
2. Do not make `default` a plugin function.
3. Do not rely on bundler export hiding instead of source-level split.
4. Do not leave OpenCode config broken if live proof fails.
5. Do not proceed to OMP removal before live proof passes.

## Sign-Off

Approved by user reply: `approve`.