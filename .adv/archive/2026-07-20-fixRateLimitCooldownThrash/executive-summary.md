# Executive Summary — fixRateLimitCooldownThrash

## Outcome

Two compounding bugs in `opencode-model-routing` fixed in a single small, surgical change to the TypeScript plugin runtime:

1. **`rate_limit` cooldown default wrong for hour-scale provider windows** — `defaultConfig.cooldownMsByCategory` now includes `rate_limit: 30 * 60_000` (was: intentionally absent, falling through to 5-minute default that was far shorter than MiniMax Token Plan's observed ~1-hour exhaustion window).
2. **`cooldownMsByCategory` user-side override silently ignored** — `pluginOptions.cooldownMsByCategory` from the plugin tuple in `opencode.jsonc` now flows through a typed `extractCooldownOverrides` helper → `createPluginContext` 3-layer merge → applied at failure time. Was: type advertised configurability but runtime plumbing never wired.

## Value delivered

`explore` (and any subagent) hitting M3 rate-limit will now roll over to GLM-5.2 → MiMo cleanly for 30 minutes per failure, breaking the thrash cycle the prior 5-minute default caused. Users can tune the cooldown per-category via `opencode.jsonc` (e.g., bump MiniMax to 60min, keep other providers' defaults). The bug is fixed out-of-the-box for the dominant case AND the structural plumbing supports any future provider-mix variance without code changes.

## Verification

- **Tests**: 266 pass / 0 fail across 15 files (`tr_mrsizqde_0a19cd23`). Includes 13 new test cases across 3 describe blocks: extractCooldownOverrides direct unit (test.each over numeric edge cases + prototype-inherited name rejection + mixed valid/invalid), createPluginContext 3-layer merge (override applied, additive preservation, 3-layer layering, no-override default), createPluginHooks plumbing (pluginOptions.cooldownMsByCategory reaches ctx.config).
- **Type safety**: `tsc --noEmit` clean (`tr_mrsizmu4_3de5e829`).
- **Build**: tsup success, dist/index.js 47.86KB + dist/index.d.ts 145B (`tr_mrsiznnh_ecbf202e`).
- **Independent design validation**: 2-pass adv-researcher (CONFLICT → revisions → CONFLICT → revisions, all findings addressed; architecture judgment "Approach B remains appropriate").
- **Independent acceptance review**: adv-reviewer ACCEPT verdict with 1 remediation (vacuous plumbing test assertion replaced with meaningful one; commit `517491f`).
- **TDD discipline**: RED → GREEN recordings for every implementation task (tr IDs in commit messages).

## P33 posture

- `KNOWN_CATEGORIES` uses `satisfies Record<ErrorCategory, true>` for compile-time exhaustiveness — adding/removing ErrorCategory member fails `tsc`.
- `isErrorCategory` uses `Object.hasOwn` — prototype-safe (rejects `toString`, `constructor`, `__proto__`).
- `extractCooldownOverrides` validates at boundary: drops malformed entries (NaN, -Infinity, negative, non-number, unknown categories, prototype-inherited names) with warn logs; never crashes.
- Additive 3-layer merge preserves defaults at every layer (default → opts.config → pluginOptions overrides).
- `Number.POSITIVE_INFINITY` accepted programmatically (documented sentinel) but JSON-config limitation cited (RFC 8259 §6).

## Risks + follow-ups

- **30min default may be too sticky for providers with legitimately short rate-limit windows** — mitigated by user-override escape hatch (this is the Bug 2 fix). Default is conservative on purpose.
- **Other M3-primary roles still exposed** (`adv-tron`, `adv-visual-review`, `general`) — same bug exposure but Path C's 30min default protects them globally without primary changes. Will surface separately if they thrash.
- **Follow-up ADV change: JSON schema extension** for `cooldownMsByCategory` (enum enforcement, `Infinity` JSON representation, schema file location) — deferred; type safety + defensive validation cover the correctness gap.
- **Follow-up ADV change: Go writer support** — `omr` binary does not yet emit `cooldownMsByCategory`; users hand-edit `opencode.jsonc` until Go-side support added.
- **Follow-up small change: `explore` primary re-swap back to M3** — after 30min cooldown proven in production for a few weeks. Path A's GPT-5.6 Sol mitigation remains in effect until then.

## Bundled cross-repo work

Toolbox PR [#42](https://github.com/JRedeker/toolbox/pull/42) (merged 2026-07-20) removed dead OMP artifacts (`omp-preferences.json` live + backup, `/OMP` example in `agents/adv.md`, stale reference in `backups/dotfiles/MANIFEST.md:9`). These were residual from OMR's 2026-05-23 `removeOmpCompatibility` retirement and had misled the cancelled `updateModelRouting` ADV change (2026-07-10) into recreating the dead `omp-preferences.json`. Cleanup landed ahead of this change so the cross-repo documentation surface is consistent.

## Operational deployment (post-archive, tracked outside this change)

1. `pnpm run build && bash scripts/deploy-local.sh --fix` in `~/dev/opencode-model-routing/`
2. Restart OpenCode to load new plugin bundle (pluginOptions captured at init; restart required)
3. Update `~/toolbox/docs/model-routing.md` revision note + remove "temp" annotation on `explore` row