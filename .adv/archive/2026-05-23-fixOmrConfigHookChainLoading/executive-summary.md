# Executive Summary

## Outcome
OMR plugin now correctly receives OpenCode config via the documented `Hooks.config` callback (instead of the non-existent `PluginInput.config` field that left chains map empty in production). Combined with the parent change's classifier fix, fallback now triggers end-to-end on usage-cap 429s — confirmed in test output via `fallback.success` events.

## Verdict
APPROVED

## What Was Built
1. **PluginInput corrected** — stripped bogus `config?` field; matches real `@opencode-ai/plugin@1.15.5` SDK shape (`{client, project?, worktree?, directory?, experimental_workspace?, serverUrl?, $?}`).
2. **PluginHooks extended** — added `config?: (input: unknown) => Promise<void>` callback per SDK contract.
3. **createPluginContext refactored** — no longer reads `opts.rawConfig`/`opts.config` (always undefined in production); chains starts as empty `Map`.
4. **createPluginHooks registers config hook** — calls `loadFallbackChains(cfg, logger)` and updates `ctx.chains` via `.clear() + .set()` (preserves Map identity for handler closures that capture `ctx` by reference). Emits `config.loaded` info log with `agentCount`.
5. **Code comment + source link** — documents the OpenCode ordering dependency (`config` fires before `bus.subscribeAll` per `packages/opencode/src/plugin/index.ts:217-237 @ 7fe7b9f`).
6. **5 lifecycle tests** — hook registration, init→config→event lifecycle (with model-args assertion), ordering-violation regression guard (event-before-config), empty-config fallthrough, Map-identity-preserved on re-invocation (with new-chain-used assertion), stale-agent removal on config re-delivery (guards `.clear()` step).
7. **Loader hardened** — empty/whitespace agent keys skipped at load time (would be unreachable via handler ternary).
8. **Tests migrated** — `ctxWithChain` helper rewritten to direct chain mutation; `createRuntimeHooks` helper invokes `hooks.config(cfg)` after `server` to mirror real lifecycle.

## What Was Verified
- **Verdict:** APPROVED with 10 findings (0 blockers, 2 issues, 5 suggestions, 3 nits, 13 praise) — 2 issues + 3 suggestions remediated; 3 deferred (naming changes would diverge from SDK contract; test-helper DRY too small).
- **Tests:** 117/117 plugin tests pass; Go suite (cmd/omr + internal/config + internal/tui) pass; `tsc --noEmit` clean; `make deploy-local` success.
- **Investment:** 2 tasks (2 done, 0 cancelled) / 0 retries / ~54 min wall / tier: auto.
- **Contract matrix:** 21/21 required rows — 9 AC pass, 6 constraints respected, 6 out-of-scope not_applicable; 0 failures.
- **End-to-end evidence:** test output shows `fallback.success` events firing with `to:"anthropic/claude"` and `to:"updated/model"` reason=`quota_exhausted` — was silent before this change.

## Remaining Concerns
- Documented future-hardening option (OOS6): lazy `client.config.get()` hydration on first event if `chains.size === 0`. Defense-in-depth against possible future OpenCode hook-ordering changes. Deferred per validator recommendation; ordering-violation regression test guards the current contract.
- After OpenCode restart with this deployed plugin, user should observe fallback rotating models on the next usage-cap 429 (parent change + this change together).
