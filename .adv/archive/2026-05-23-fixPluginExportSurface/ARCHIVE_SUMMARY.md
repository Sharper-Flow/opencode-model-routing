# Archive: Fix plugin export surface

**Change ID:** fixPluginExportSurface
**Archived:** 2026-05-23T05:17:42.109Z
**Created:** 2026-05-23T04:31:51.059Z

## Tasks Completed

- ✅ Add runtime export-surface contract test
  > Added package runtime contract test that installs/builds plugin, imports dist/index.js, and asserts the runtime module exports only default V1 plugin object with id/server. RED evidence confirms current exports include createPluginContext, handleChatMessage, and handleEvent.
- ✅ Split plugin runtime entry from internals and adopt V1 module
  > Moved testable helper implementation into plugin/src/plugin-internal.ts. Replaced plugin/src/plugin.ts with a thin V1 PluginModule default export containing exactly id and server. Server accepts OpenCode V1 input/options shape and delegates to internal hook creation. Package contract test now passes and proves built dist exports only default with id/server.
- ✅ Update plugin behavior tests for internal/runtime split
  > Updated plugin behavior tests to import helper functions from plugin-internal.ts and exercise the runtime V1 module through pluginModule.server. Added test helper wrappers for intentionally malformed unknown hook payloads so typecheck remains strict while preserving malformed-payload coverage.
- ✅ Run build, deploy, and live OpenCode proof
  > Task checkpoint completed

## Specs Modified


## Wisdom Accumulated

- **[pattern]** For OpenCode plugins, runtime package entry should default-export a V1 PluginModule object `{ id, server }` and avoid named function exports. Legacy loader enumerates function-valued exports as plugins, so test seams must live in internal modules and export-surface tests should assert `Object.keys(dist) === ['default']`.
