# Design

## Architecture

Use a strict source-level split between the OpenCode runtime entry and testable plugin internals.

- `plugin/src/plugin.ts` is the package runtime entry only.
- `plugin/src/plugin.ts` has imports and exactly one runtime export: `export default`.
- It does not re-export anything from internals.
- The default export is an OpenCode V1 plugin module object with exactly two keys: `id` and `server`.
- `server` uses the V1 contract `server(input, options)` and delegates to internal hook creation.
- `plugin/src/plugin-internal.ts` owns context creation, hook handlers, payload normalizers, and guards.
- Tests import helpers from `plugin-internal.ts`; runtime tests exercise `pluginModule.server` from `plugin.ts`.
- `tsup` remains single-entry through `src/plugin.ts`, so `dist/index.js` has only the default module export.

## Runtime Shape

```ts
const server: Plugin = async (input, options) => {
  if (!isPluginInput(input)) throw new Error("opencode-model-routing plugin: invalid initialization input");
  return createPluginHooks(input);
};

export default {
  id: "@sharper-flow/opencode-model-routing-plugin",
  server,
} satisfies PluginModule;
```

## Validator Integration

The independent validator concerns were incorporated:

- runtime/internal split is mandatory;
- `plugin.ts` re-exports nothing;
- default object is exactly `{ id, server }`;
- no `tui` or extra keys;
- server accepts the two-argument V1 shape;
- export-surface tests assert module keys and default object keys.

## Verification Plan

- RED/GREEN `bun test test/package-contract.test.ts` for export surface.
- `bun test test/plugin.test.ts` for behavior preservation.
- `make build-plugin`.
- `make test`.
- `make lint`.
- `./scripts/deploy-local.sh --dry-run`.
- `make deploy-local`.
- Enable OMR path in `~/.config/opencode/opencode.jsonc`.
- `opencode models`.
- Inspect latest OpenCode log for no `O.config` / `r.provider` startup failures.

## Out of Scope

- Removing OMP compatibility.
- Changing fallback config schema.
- Rewriting routing, cooldown, TTFT, replay orchestration, or provider resolution.
- Patching OpenCode core.