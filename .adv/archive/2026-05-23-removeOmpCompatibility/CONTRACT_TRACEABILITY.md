# Contract Traceability

**Change ID:** removeOmpCompatibility
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 2026-05-23T06:05:00Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | Reviewer PASS: cmd/omp absent on disk and no tracked cmd/omp files. |
| AC2 | acceptance_criterion | pass | test | Reviewer PASS: Makefile builds ./cmd/omr only; build-omp target absent; clean removes omr/plugin artifacts only; ./scripts/test-makefile-targets.sh passed. |
| AC3 | acceptance_criterion | pass | test | Reviewer PASS: README, schema, and active model-preferences spec describe OMR/omr and omr-preferences.json, not OMP as active binary/project. |
| AC4 | acceptance_criterion | pass | test | Reviewer PASS: no active tmux/openchad matches found; obsolete OMP-only docs deleted. |
| AC5 | acceptance_criterion | pass | test | Reviewer PASS: .gitignore uses /omr and *.omr-backup.*; tests/docs use omr-preferences.json and .omr temp/backup naming; e2e smoke passed. |
| AC6 | acceptance_criterion | pass | test | Reviewer PASS: active OMP scan excluding .adv/archive and generated deps has only test legacy-removal guard pattern; prior blocker files remediated. |
| AC7 | acceptance_criterion | pass | test | Reviewer PASS: ./scripts/test-makefile-targets.sh, make test, make lint, ./scripts/e2e-smoke.sh, ./scripts/deploy-local.sh --check, and opencode models passed. |
| AC8 | acceptance_criterion | pass | test | Exact local target verified clean before deletion; /home/jon/dev/omp deleted and verified absent. |
| AC9 | acceptance_criterion | pass | test | GitHub repo JRedeker/opencode-model-preferences archived via gh api and verified archived=true; reviewer confirmed isArchived=true. |
| AC10 | acceptance_criterion | pass | test | deploy-local --check confirms plugin registration; live opencode models succeeds after cleanup. |
| C1 | constraint | respected | static_check | Reviewer detected no fallback behavior rewrite; verification suite and plugin tests passed. |
| C2 | constraint | respected | static_check | schema-contract-check passed; fallback_models field semantics unchanged. |
| C3 | constraint | respected | static_check | .adv/archive excluded and not removed; historical change bundles intact. |
| C4 | constraint | respected | static_check | Remediation targeted whole-word/active OMP references; unrelated substrings like prompt/compliance/compatibility were not removed. |
| C5 | constraint | respected | static_check | Before deletion/archive, exact targets were verified: local path, clean status, remote URL, stash, worktree count, branches not ahead; GitHub repo full_name and archived state checked. |
| C6 | constraint | not_applicable | static_check | GitHub archive did not fail; repo archived=true verified. |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-05ab200ed2ad | AC5 | AC1, AC2, AC5 | C1, C2, C3, C4 |  |
| tk-876c091629e4 | AC1, AC2, AC5 | AC1, AC2, AC5 | C1, C2, C3, C4 |  |
| tk-7adb239d32ae | AC3, AC4, AC6 | AC3, AC4, AC6 | C3, C4 |  |
| tk-03707ab13f85 |  | AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC10 | C1, C2, C3, C4 |  |
| tk-b7becf147a0c | AC8, AC9 | AC3, AC5, AC6, AC7, AC8, AC9, AC10 | C1, C2, C3, C4, C5, C6 |  |
