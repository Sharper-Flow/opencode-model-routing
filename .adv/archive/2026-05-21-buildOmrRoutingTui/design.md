# Design

## Architecture Overview

Build OMR’s configuration UI as an OMR-native Go/Bubbletea tool with a new `omr` binary/path. The existing `cmd/omp` and `internal/tui` code are treated as source material, not the product boundary. The implementation should preserve the proven config and schema logic while reshaping the UI around a routing-stack domain model.

Core layers:

1. **Command layer** — add `cmd/omr` as the primary entrypoint. It reuses config/model refresh behavior but presents OMR-native naming and errors.
2. **Routing domain layer** — introduce pure routing-stack and apply-plan logic around primary model, fallback chain, validation, and diff generation.
3. **Config persistence layer** — keep existing `ConfigPath`, `Load`, `LoadPreferences`, `SavePreferences`, `ApplyPreferences`, validation, atomic write, backup, and permission safeguards, but split direct mutation from planning/preview.
4. **TUI layer** — split the current single `internal/tui/tui.go` into smaller components/views: target browser, routing-stack detail, model picker, chain editor, preview/apply view, shared delegates/styles/keymap.
5. **Runtime plugin layer** — no runtime behavior change expected. The plugin remains consumer of OpenCode config and `agent.<name>.options.fallback_models`.

## Key Decisions

- Add `cmd/omr` and Makefile/install support for `omr` as the primary binary/path.
- Do not implement supported automatic OMP preference migration.
- Keep v1 manual-only; no built-in routing presets/templates.
- Extract pure apply planning so preview and apply share the same mutation output.
- Keep a flat root Bubbletea `Model` with state-specific methods/files; avoid independent root submodels.
- Reuse `ValidateFallbackChain`, `ModelKeyPattern`, `MaxChainLength`, `FallbackJSONPath`, `writeFileAtomic`, `writeBackup`, and `pruneBackups`.

## Implementation Strategy

1. Add routing/apply-plan tests first: preview no-write, plan/apply shared output, invalid chain blocks preview/apply, apply-only backup/atomic/permission behavior.
2. Add `cmd/omr/main.go` and Makefile/install support for `omr`.
3. Create routing-stack/domain helpers for primary model + fallback chain view models and validation findings.
4. Extract `BuildApplyPlan` or equivalent from `ApplyPreferences`; preview renders the plan, apply writes it with existing safeguards.
5. Refactor TUI around routing stacks: target browser, detail view, chain editor, model picker, preview/apply view.
6. Update README/docs/tests; keep `make test` and `make lint` green.

## LBP Analysis

- Go/Bubbletea remains the right stack.
- Structural correctness belongs below the UI in validators and plan/apply logic.
- Preview must share apply code to avoid drift.
- Flat root model with split files is the simplest Bubbletea structure for this codebase.

## Affected Components

- `cmd/omr/`
- `cmd/omp/` optional compatibility wrapper only
- `Makefile`
- `internal/tui/`
- `internal/config/preferences.go`
- `internal/config/fallback.go`
- `internal/config/atomic.go`
- `internal/config/config.go`
- `README.md` / docs
- `internal/tui`, `internal/config`, and smoke tests

## Risks / Mitigations

| Risk | Mitigation |
|---|---|
| Preview diverges from apply | Make preview render from the same `ApplyPlan` used by apply. |
| UI refactor grows too large | Keep behavior slices test-driven. |
| Config writes regress safety | Preserve backup/atomic/0600 tests and add preview-no-write tests. |
| Old OMP naming leaks into product | Add `omr` binary/docs first; treat `omp` as legacy internal/wrapper. |
| Invalid chains slip through UI | Validate with `ValidateFallbackChain` and writer-side checks before preview/apply. |

## Validator Result

DESIGN_VALIDATION: `VALIDATED`

Findings:

- Correctness: solves all six objectives with no logical gaps.
- Simplicity: caution that TUI file split is the largest surface; use flat root `Model` with view-specific methods rather than independent submodels.
- Spec-law compliance: no conflicts; preserves fallback path, write safety, Bubbletea stack, and config safety requirements.
- Key alternatives: no significant alternative overlooked.

Recommendation: proceed. Implementation should keep `ApplyPlan` extraction anchored to existing `ApplyPreferences` mutation logic and keep the TUI split pragmatic.
