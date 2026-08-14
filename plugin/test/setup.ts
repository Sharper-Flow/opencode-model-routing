// setup.ts — test-runner preload. Neutralizes inherited production environment.
//
// WHY THIS EXISTS
//   The `oc` wrapper exports OMR_LOG_FILE=~/.local/share/opencode/omr.log into
//   every OpenCode session, so any shell spawned inside one inherits a live
//   production log path. `createLogger()` resolves its file sink from that
//   variable, and the one test path that builds a real logger
//   (pluginModule.server -> createPluginHooks -> createLogger) then appends
//   test fixtures to the real routing log.
//
//   That actually happened: 28 synthetic `quota_exhausted` events with
//   sessionId "s1" and model "anthropic/claude" reached the production log and
//   later corrupted a quota-burn investigation, which had to re-derive its
//   signal from a different event class.
//
//   Isolation lives here rather than in a package.json script prefix so that it
//   binds to the test RUNNER, not the INVOCATION. `bun test`, `bun run test`,
//   IDE runners, and agent shells all load bunfig.toml; a script prefix covers
//   only `bun run test`.
//
// Loaded via plugin/bunfig.toml `[test] preload`.

// Empty string is falsy at the `if (fileSink)` guard in logging/logger.ts, so
// no file is ever opened. Preferred over a /dev/null path, which is
// platform-specific and would still open a handle.
process.env.OMR_LOG_FILE = "";

// Carried over verbatim from the package.json test script this preload
// replaces. The path is DELIBERATELY UNWRITABLE — `/dev/null` is not a
// directory, so every cooldown write fails and the store never persists across
// tests. Do not "fix" this into a real temp path: a writable default makes
// cooldown state leak between test files and breaks cross-process cooldown
// tests that assume a cold store.
process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = "/dev/null/omr-test-isolation";
