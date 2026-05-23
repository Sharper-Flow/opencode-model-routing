# Design

## Direction

Remove legacy OMP compatibility at the source of truth and keep OMR as the only supported local binary/plugin path.

## Implementation Plan

1. Add failing contract checks before removal:
   - `make build-omp` must not exist.
   - `COMPAT_BINARY`, `./cmd/omp/`, and `cmd/omp` source must be absent.
   - E2E backup expectation must use `omr-backup`.
2. Remove compatibility code/build surface:
   - Delete `cmd/omp/`.
   - Remove `build-omp`, `COMPAT_BINARY`, and `omp` clean handling from `Makefile`.
3. Rename active OMR-owned naming:
   - `opencode.json.omr-backup.<timestamp>`.
   - `.omr-*.tmp`.
   - `omr-preferences.json`.
4. Clean docs/spec/schema:
   - README/schema/model-preferences docs refer to OMR, not OMP.
   - Delete obsolete OMP-only tmux/openchad docs.
   - Preserve historical ADV archives and license/vendor context.
5. Verify OMR before destructive cleanup:
   - `./scripts/test-makefile-targets.sh`.
   - `make test`.
   - `make lint`.
   - `./scripts/e2e-smoke.sh`.
   - Active OMP reference scan excluding `.adv/archive/**` and generated deps.
   - `./scripts/deploy-local.sh --check`.
   - Live `opencode models`.
6. External cleanup after verification:
   - Verify `/home/jon/dev/omp` exact path, clean status, remote URL, empty stash, single worktree, no branch ahead of upstream.
   - Verify GitHub repo full name before archiving.
   - Archive `JRedeker/opencode-model-preferences`; verify `archived=true`.
   - Delete `/home/jon/dev/omp`; verify absent.
   - Re-run live OMR checks.

## Safety

- Do not touch `.adv/archive/**`.
- Do not rewrite runtime fallback semantics or `fallback_models` schema shape.
- Do not use broad substring deletion; target only active OMP product references.
- Treat repo archive and local checkout deletion as exact-target destructive operations.