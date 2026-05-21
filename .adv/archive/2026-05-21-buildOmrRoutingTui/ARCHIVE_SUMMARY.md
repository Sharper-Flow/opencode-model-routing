# Archive: Build OMR routing TUI

**Change ID:** buildOmrRoutingTui
**Archived:** 2026-05-21T02:41:40.965Z
**Created:** 2026-05-21T00:27:45.435Z

## Tasks Completed

- ✅ Extract apply planning and preview-safe config mutation path
  > Added `internal/config/apply_plan.go` with `ApplyPlan`, `ConfigMutation`, `BuildApplyPlan`, `BuildPreferencesApplyPlan`, and `Preview`. Refactored `ApplyPreferences` to build a plan first, then perform the existing backup, atomic write, owner-only permission write, and backup pruning. Added tests proving planning does not write/back up, plan output matches `ApplyPreferences`, and invalid chains fail without updated bytes.
- ✅ Add routing-stack domain/view-model helpers
  > Added `RoutingStack`, `RoutingValidationFinding`, `BuildRoutingStacks`, and `ValidateRoutingStack` in `internal/tui/routing_stack.go`. Helpers normalize config state and preferences into primary+fallback view models, skip unmappable main agents, prefer pending prefs over discovered state, reuse `config.ValidateFallbackChain`, and optionally report unavailable models when registry data is provided. Added tests for preference override, discovered fallback chain, unmappable main-agent skip, structural validation, and availability findings.
- ✅ Add OMR-native `omr` command and build/install path
  > Implemented `cmd/omr/main.go` with OMR-prefixed refresh/load/no-model/TUI errors and graceful interrupt handling. Added `cmd/omr/main_test.go` covering startup refresh and OMR-native no-model error. Updated Makefile default `build`/`install` to produce/install `omr`, added `build-omp` compatibility target, and cleaned both binaries. Extended `scripts/test-makefile-targets.sh` to assert default build/install path targets `omr`. Checkpoint commit: 5c8c7223a2007c15857f522b58194b7e122548a0.
- ✅ Refactor TUI around routing-stack target browser and detail/chain editing
  > Updated target list rendering to use `BuildRoutingStacks`, show `Routing Stacks` as the primary browser title, render primary/pending primary and fallback counts from routing-stack state, and keep ADV provider items separate. Added routing-stack detail context to the fallback chain editor with target and primary model before the editable fallback list. Preserved existing add/remove/reorder behavior and legacy key-hint expectations. Added tests for routing-stack title, primary/fallback description, and primary detail in the chain editor. Checkpoint commit: 9e223117287be804302268880cac772d44ea6eef.
- ✅ Wire preview-before-apply into the routing UI
  > Added `viewPreview` earlier. Post-review remediation extracted `config.ApplyPreparedPlan(plan)` and changed preview confirmation to call it with `m.previewPlan`, preserving exact preview/apply bytes. Added regression test proving confirmation writes the previewed model even if in-memory preferences drift after preview. Checkpoint commits: 43bef7418b6f732441362f331872c733a04b86a3 and 38e6bc3512d554b6121d2aef0a3e869ac65a7ac7.
- ✅ Update OMR-native docs and run cross-stack verification
  > Updated OMR docs and verification earlier. Post-hardening remediation removed stale README future-phase wording and placeholder `.adv` link, and replaced an old change-specific comment in `scripts/test-makefile-targets.sh` with generic build/install contract wording. Verification: `make build`, `make build-omp`, `scripts/test-makefile-targets.sh`, `scripts/e2e-smoke.sh`, `make test`, `make build-plugin`, `make lint`, and post-hardening `make test` + `make lint` passed. Checkpoint commits: c779cadb5ee1edd0214841236d89928af7f16140 and a7c29ee4d0219ec546bdd9ec9149002989b5b9a2.

## Specs Modified


## Wisdom Accumulated

- **[gotcha]** `adv_change_update` treats empty string fields as writes, not omissions. When updating one artifact, omit unrelated fields rather than passing `""`, or proposal/agreement/design can be overwritten with empty content.
- **[success]** Makefile dry-run contract tests are a cheap structural guard for binary rename/build-install expectations: assert `make -n build` targets `cmd/omr` and `make -n install` copies `omr`, while preserving hook side-effect checks.
- **[pattern]** For Bubbletea refactors, keep the root Model flat but make list items carry domain view models (`RoutingStack`) instead of recomputing UI-only state. This preserves current key handling while shifting correctness to tested domain helpers.
- **[pattern]** Preview-before-apply is safest as a normal Bubbletea view: build the same pure ApplyPlan used by apply, render `plan.Preview()`, and only call the mutation path from an explicit confirm key in that view.
- **[gotcha]** `make lint` requires plugin dependencies to exist. In a fresh worktree, run `make build-plugin` (frozen Bun install + typecheck) before `make lint`, or lint can fail with missing `bun-types` even though source is valid.
