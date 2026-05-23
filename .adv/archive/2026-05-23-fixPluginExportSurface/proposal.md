# Fix plugin export surface

## Why

Live proof of rebuilt OMR failed after enabling `/home/jon/.local/share/opencode-model-routing/plugin`: `opencode models` on OpenCode 1.15.10 errored with `O.config is not a function`, `undefined is not an object (evaluating 'O.config')`, and `undefined is not an object (evaluating 'r.provider')`.

The package was already bundled to `dist/index.js`, but the runtime module still exported helper functions alongside `default`:

```text
["createPluginContext", "default", "handleChatMessage", "handleEvent"]
```

OpenCode falls back to legacy export enumeration when `default` is a function rather than a V1 module object. Legacy loading treats every function-valued export as a plugin. `createPluginContext()` returns an object whose `config` is a plain config object, matching `O.config is not a function`.

## What Changes

- Split runtime entry from testable internals.
- Make `plugin/src/plugin.ts` default-export a V1 object-shaped plugin module: `{ id, server }`.
- Move helper functions to `plugin/src/plugin-internal.ts`.
- Update tests to import internals from the internal module.
- Add a runtime export-surface contract test proving `plugin/dist/index.js` exports only `default`, and that `default` has exactly `id` and `server`.
- Rebuild, deploy, enable OMR, and prove `opencode models` succeeds.

## Success Criteria

1. Runtime import of built/deployed package exposes only `default`.
2. `default` is a V1 plugin module object with stable `id` and function-valued `server`.
3. No helper functions are exported from `plugin/dist/index.js`.
4. Existing plugin behavior tests pass through the internal/testable surface.
5. Export-surface test fails on the old multi-function export shape and passes after the fix.
6. `make build-plugin`, `make test`, `make lint`, and `./scripts/deploy-local.sh --dry-run` pass.
7. Live proof passes: OMR enabled in `opencode.jsonc`, fresh `opencode models` succeeds, and OMR remains enabled.

## Out of Scope

- Removing OMP compatibility.
- Rewriting fallback routing behavior, schema, cooldown, TTFT policy, or replay orchestration.
- Patching OpenCode core.