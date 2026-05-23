OMR's plugin reads `opts.config` from PluginInput to populate `chains: Map<string, ModelKey[]>` via `loadFallbackChains(opts.rawConfig, ...)`. But OpenCode's actual PluginInput (per `@opencode-ai/plugin@1.15.5` SDK + `packages/opencode/src/plugin/index.ts:135-150` source) does NOT have a `config` field — it only has `{client, project, worktree, directory, experimental_workspace, serverUrl, $}`. OpenCode passes config via the `Hooks.config` hook callback, not the init input. Result: `opts.config = undefined`, chains map stays empty, every `attemptFallback` short-circuits at `orchestrator.ts:99` with `error: "no chain"` (debug-level log, never appears in info-level OpenCode log file). Plugin has effectively never triggered a fallback in production. Existing tests pass because they inject chains directly via `ctxWithChain([...])` synthetic context — bypassing the real config-loading path entirely.</problemStatement>
<parameter name="proposal"># Proposal: Fix OMR config hook chain loading

## Problem
OMR's plugin reads `opts.config` from PluginInput, but `@opencode-ai/plugin` PluginInput type does NOT include `config`. OpenCode passes config via the `Hooks.config` callback. So `chains` map is always empty in production, every fallback attempt exits early with `"no chain"`.

Evidence:
- Latest user-session log `2026-05-23T193224.log` shows plugin loaded, 10 session.status events with "The usage limit has been reached", but zero session.abort/prompt fallback dispatches.
- `packages/opencode/src/plugin/index.ts:134-150` constructs PluginInput as `{client, project, worktree, directory, experimental_workspace, serverUrl, $}` — no config.
- `@opencode-ai/plugin@1.15.5` `Hooks.config?: (input: Config) => Promise<void>` is the documented config delivery channel.

## Direction
Register a `config` hook in `createPluginHooks` that receives the merged OpenCode `Config` object and lazily populates `ctx.chains` via `loadFallbackChains`. Handle the chicken-and-egg case where an event fires before `config` hook (defer event handling until chains loaded, OR read config from disk eagerly at plugin init as a fallback).

## Success criteria
- A reproduced 429 from openai with isRetryable=true triggers `client.session.abort` + `prompt` with the next model in the adv agent's fallback chain in a live OpenCode session.
- Integration test simulates real OpenCode PluginInput shape (no `config` field) and a synthetic `config` hook invocation → asserts chains populate end-to-end.
- Loader and event handler interaction is verified: chains available by the time first session.status event fires.

## Out of scope
- The classification correctness fix (already shipped in parent `fixOmrUsageCapFallbackGap`).
- Pattern additions (already shipped).
- OpenCode upstream changes.
- Architectural refactor beyond config delivery.

## Notes
- Parent change `fixOmrUsageCapFallbackGap` shipped the classifier/pattern/action.reason fixes — necessary but not sufficient. This change is the remaining gap.
- Without this fix, the parent change's value is theoretical (good logging when a fallback could fire, but no fallback ever fires).
