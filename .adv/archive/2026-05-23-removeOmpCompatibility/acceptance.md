# Acceptance

Reviewed at: 2026-05-23T06:05:00Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| AC1 | acceptance_criterion | `cmd/omp/` and its tests are removed from the OMR repo. | pass | Reviewer PASS: cmd/omp absent on disk and no tracked cmd/omp files. |
| AC2 | acceptance_criterion | `make build-omp`, `COMPAT_BINARY`, and clean-target `omp` removal are gone. | pass | Reviewer PASS: Makefile builds ./cmd/omr only; build-omp target absent; clean removes omr/plugin artifacts only; ./scripts/test-makefile-targets.sh passed. |
| AC3 | acceptance_criterion | README and schema no longer describe OMP as an active supported binary or required standalone project. | pass | Reviewer PASS: README, schema, and active model-preferences spec describe OMR/omr and omr-preferences.json, not OMP as active binary/project. |
| AC4 | acceptance_criterion | Obsolete OMP-only tmux/openchad docs are removed or rewritten as historical/irrelevant; active docs refer to OMR where applicable. | pass | Reviewer PASS: no active tmux/openchad matches found; obsolete OMP-only docs deleted. |
| AC5 | acceptance_criterion | `.gitignore` no longer ignores `/omp`; backup suffix policy is updated from `omp-backup` to an OMR-neutral or OMR-named suffix, with docs/tests updated. | pass | Reviewer PASS: .gitignore uses /omr and *.omr-backup.*; tests/docs use omr-preferences.json and .omr temp/backup naming; e2e smoke passed. |
| AC6 | acceptance_criterion | Remaining `omp` text matches are either absent or explicitly historical/archived/vendor/license-context references. | pass | Reviewer PASS: active OMP scan excluding .adv/archive and generated deps has only test legacy-removal guard pattern; prior blocker files remediated. |
| AC7 | acceptance_criterion | OMR verification passes: `make test`, `make lint`, `./scripts/e2e-smoke.sh`, `./scripts/deploy-local.sh --check`, and live `opencode models`. | pass | Reviewer PASS: ./scripts/test-makefile-targets.sh, make test, make lint, ./scripts/e2e-smoke.sh, ./scripts/deploy-local.sh --check, and opencode models passed. |
| AC8 | acceptance_criterion | `/home/jon/dev/omp` is removed only after `git status --short` shows no uncommitted work and remote is confirmed as `JRedeker/opencode-model-preferences`. | pass | Exact local target verified clean before deletion; /home/jon/dev/omp deleted and verified absent. |
| AC9 | acceptance_criterion | GitHub repo `JRedeker/opencode-model-preferences` is archived only after local OMR verification passes. | pass | GitHub repo JRedeker/opencode-model-preferences archived via gh api and verified archived=true; reviewer confirmed isArchived=true. |
| AC10 | acceptance_criterion | Current OMR plugin remains enabled and working after all cleanup. | pass | deploy-local --check confirms plugin registration; live opencode models succeeds after cleanup. |
| C1 | constraint | Do not rewrite OMR fallback behavior. | respected | Reviewer detected no fallback behavior rewrite; verification suite and plugin tests passed. |
| C2 | constraint | Do not change `fallback_models` schema semantics. | respected | schema-contract-check passed; fallback_models field semantics unchanged. |
| C3 | constraint | Do not remove Advance archive records or historical change bundles. | respected | .adv/archive excluded and not removed; historical change bundles intact. |
| C4 | constraint | Do not remove unrelated substring matches such as `prompt`, `compliance`, or `compatibility`. | respected | Remediation targeted whole-word/active OMP references; unrelated substrings like prompt/compliance/compatibility were not removed. |
| C5 | constraint | Treat local directory deletion and GitHub archive as destructive/external actions requiring exact target verification immediately before execution. | respected | Before deletion/archive, exact targets were verified: local path, clean status, remote URL, stash, worktree count, branches not ahead; GitHub repo full_name and archived state checked. |
| C6 | constraint | If GitHub archive fails due to permission/API limits, preserve repo cleanup and report the remote blocker. | not_applicable | GitHub archive did not fail; repo archived=true verified. |

