# Agreement

## Objectives

1. OMR populates `ctx.chains` from OpenCode's actual config delivery channel (`Hooks.config` callback) instead of the non-existent `PluginInput.config` field.
2. Chain loading is guaranteed to happen before the first bus event fires (OpenCode's plugin loader enforces this ordering today; documented dependency in code).
3. `PluginInput` interface is corrected to match the real SDK shape (no `config` field).
4. Integration test simulates the real OpenCode plugin lifecycle (init → config hook → event) and verifies chains populate end-to-end.
5. Ordering-violation regression test codifies the contract: handler must not crash when event fires before config hook (chains empty is correct pre-config behavior).

## Acceptance criteria

- `createPluginHooks` registers a `config` hook typed as `(input: Config) => Promise<void>` per `@opencode-ai/plugin` SDK.
- The `config` hook calls `loadFallbackChains(cfg, logger)` and updates `ctx.chains` via in-place `.clear() + .set()` so handler closures see updates.
- `createPluginContext` no longer reads `opts.rawConfig`/`opts.config`; chains starts as empty Map and is populated by the `config` hook.
- `PluginInput` interface no longer declares `config?: unknown`; documented as matching OpenCode's actual shape `{client, project?, worktree?, directory?, experimental_workspace?, serverUrl?, $?}`.
- New lifecycle test: `createPluginHooks(realShapeInput)` (no config) → `hooks.config(syntheticCfg)` with `agent.adv.options.fallback_models: [...]` → `hooks.event({event: sessionStatusRetryWithUsageMessage})` → asserts `client.session.abort` + `client.session.prompt` called with next model in chain.
- New ordering-violation test: fire `hooks.event` BEFORE `hooks.config`; assert handler does not crash, no fallback fires, log records empty-chain skip; then call `hooks.config` + fire event again; assert fallback now fires.
- Code comment at the `config` hook registration site documents the OpenCode ordering dependency with source link.
- All existing tests still pass.
- Plugin rebuilt + deployed dist synced via `make deploy-local`.

## Constraints

- Do NOT change `loadFallbackChains` function signature or internal logic (already correctly handles the Config shape, including AgentConfig.options field promotion).
- Do NOT add a disk-read fallback unless the `config` hook proves insufficient — keep dependency surface narrow.
- Do NOT add lazy `client.config.get()` hydration in this change (deferred; document as future hardening option for multi-version support).
- Chains map identity must remain stable across hook calls (mutate in-place via `.clear()` + `.set()`); references held by handler closures must continue to see updates.
- Structural correctness (P33) — define a typed Config shape consumed by the hook; do not infer config layout via heuristics.
- Do NOT modify OpenCode core / upstream — fix is plugin-side only.

## Out of scope

- Fixing OpenCode upstream PluginInput type to include config.
- The classifier / pattern / action.reason work (already shipped in parent `fixOmrUsageCapFallbackGap`).
- Adding new config-driven features (e.g., per-agent dedup window override).
- Multi-tier config merging beyond what OpenCode already does before delivering to the hook.
- Hot-reload of config changes (OpenCode-side behavior).
- Lazy `client.config.get()` hydration defense-in-depth (validator-flagged future option; deferred).
