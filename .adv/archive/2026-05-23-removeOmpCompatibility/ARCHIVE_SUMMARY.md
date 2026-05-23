# Archive: Remove OMP compatibility

**Change ID:** removeOmpCompatibility
**Archived:** 2026-05-23T15:31:46.448Z
**Created:** 2026-05-23T05:26:37.288Z

## Tasks Completed

- ✅ Add OMP-removal contract tests
  > Extended Makefile contract checks to require `build-omp`, `COMPAT_BINARY`, `./cmd/omp/`, and `cmd/omp` source directory to be absent. Updated e2e smoke to expect `opencode.json.omr-backup.*`. Verified RED failures against current OMP compatibility surface.
- ✅ Remove OMP code, Make target, and backup suffix
  > Deleted cmd/omp source/tests and empty directory. Removed Makefile build-omp/COMPAT_BINARY/omp clean handling. Renamed active config backup and temp naming from .omp-backup/.omp-* to .omr-backup/.omr-* in atomic writer, tests, deploy-local, and .gitignore. Verification: ./scripts/test-makefile-targets.sh PASS; go test ./internal/config ./cmd/omr -count=1 PASS; ./scripts/e2e-smoke.sh PASS.
- ✅ Clean OMP docs and active text references
  > Removed README text describing standalone OMP and build-omp target; updated backup suffix docs to omr-backup; updated schema wording from Go writer (omp) to Go writer (omr); deleted obsolete OMP-only openchad/tmux spec and research docs; rewrote Makefile contract test strings to avoid active OMP text while still checking retired target/path absence. Verification: ./scripts/test-makefile-targets.sh PASS; active OMP reference scan excluding .adv/archive returned no matches; ./schema-contract-check.sh PASS.
- ✅ Run OMR verification before destructive external cleanup
  > Ran full OMR verification suite before any destructive external cleanup. Results: ./scripts/test-makefile-targets.sh PASS; make test PASS (Go packages plus 92 plugin tests); make lint PASS; ./scripts/e2e-smoke.sh PASS; active OMP reference scan excluding .adv/archive and generated deps PASS; ./scripts/deploy-local.sh --check PASS; opencode models PASS. Reverted unrelated .opencode/package-lock.json drift caused by live opencode models invocation; final worktree clean.
- ✅ Archive old GitHub repo and remove local OMP checkout
  > Verified /home/jon/dev/omp immediately before deletion: clean git status, remote https://github.com/JRedeker/opencode-model-preferences.git, empty stash, one worktree, branches not ahead. Verified GitHub repo target JRedeker/opencode-model-preferences, archived it with gh api, and confirmed archived=true. Deleted /home/jon/dev/omp and confirmed path absent. Re-ran post-cleanup OMR checks. Acceptance review then found active OMP references; remediation renamed remaining active OMP identity references to OMR: model-preferences spec, preferences filename `omr-preferences.json`, log prefixes, comments, and stale temp-file assertion. Verification after remediation: go test ./internal/config ./cmd/omr -count=1 PASS; ./scripts/e2e-smoke.sh PASS; active OMP reference scan PASS; make test PASS; make lint PASS; ./scripts/deploy-local.sh --check PASS; opencode models PASS.

## Specs Modified

