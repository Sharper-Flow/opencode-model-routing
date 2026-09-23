// Root entrypoint for directory-form plugin loading. OpenCode 2 resolves a
// local plugin directory through <dir>/server or <dir>/index (Bun
// resolveSync) and does not consult package.json "exports" for that shape,
// so the package ships this shim beside dist/ — without it, a directory
// entry naming this package is silently skipped. The npm-name form keeps
// resolving through exports ("." and "./server") to dist/index.js.
export { default } from "./dist/index.js";
