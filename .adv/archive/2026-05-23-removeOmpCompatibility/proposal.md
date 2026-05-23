# Proposal: Remove OMP compatibility

## Summary

Remove the legacy OMP compatibility surface from `opencode-model-routing` now that OMR packaging and live plugin loading are proven healthy.

## Problem

OMR is the current product boundary, but the repository and surrounding local environment still expose legacy OMP artifacts: `cmd/omp`, `make build-omp`, old backup suffixes, active docs that refer to OMP, an old local checkout at `/home/jon/dev/omp`, and the old GitHub repository `JRedeker/opencode-model-preferences`.

Leaving those in place creates confusing duplicate product paths and increases the risk that future work updates or documents the wrong binary.

## Scope

- Remove active OMP compatibility code and build targets from this repository.
- Rename active backup/temp/preference naming to OMR naming.
- Clean active docs/spec/schema text so OMR is the supported product boundary.
- Preserve ADV archive/history and unrelated substring matches.
- Verify OMR remains healthy.
- Archive the old GitHub repo and delete the old local checkout only after exact target verification.

## Out of Scope

- Rewriting OMR fallback behavior.
- Changing `fallback_models` schema semantics.
- Removing `.adv/archive/**` history.
- Deleting unrelated matches such as `prompt`, `compliance`, or `compatibility`.

## Success Criteria

- OMR remains enabled and `opencode models` works.
- Legacy OMP binary/build/docs/checkouts/repo are removed or retired.
- All approved verification commands pass.