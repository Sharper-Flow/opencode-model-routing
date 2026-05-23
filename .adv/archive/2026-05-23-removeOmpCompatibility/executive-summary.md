# Executive Summary

## Outcome

Removed active OMP compatibility from OMR and made OMR the sole supported local binary/plugin path.

## What Changed

- Removed `cmd/omp/` source/tests and the `make build-omp` compatibility target.
- Removed `COMPAT_BINARY` and old `omp` clean-target handling from `Makefile`.
- Renamed active backup/temp/preference naming to OMR:
  - `opencode.json.omr-backup.<timestamp>`
  - `.omr-*.tmp`
  - `omr-preferences.json`
- Cleaned active docs/schema/spec wording to refer to OMR, not OMP.
- Deleted obsolete OMP-only tmux/openchad docs.
- Archived `JRedeker/opencode-model-preferences` and verified `archived=true`.
- Deleted `/home/jon/dev/omp` after exact clean-state/remote/stash/worktree/ahead checks and verified path absent.

## Verification

- `./scripts/test-makefile-targets.sh` PASS.
- `make test` PASS: Go packages and 92 plugin tests.
- `make lint` PASS: `go vet`, schema contract check, plugin typecheck.
- `./scripts/e2e-smoke.sh` PASS.
- Active OMP reference scan PASS after remediation.
- `./scripts/deploy-local.sh --check` PASS.
- Live `opencode models` PASS with OMR plugin enabled.
- Independent acceptance reviewer re-review: PASS, no findings.

## Remaining Concerns

None blocking.