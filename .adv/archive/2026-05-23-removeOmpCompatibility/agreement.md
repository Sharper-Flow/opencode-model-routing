# Agreement

## Objectives

1. Remove active OMP compatibility from the OMR repository.
2. Keep OMR as the only supported local binary and plugin path.
3. Clean user-facing docs, schema wording, Make targets, ignore patterns, and obsolete OMP-only docs.
4. Prove OMR still works after removal.
5. Remove the old local `/home/jon/dev/omp` checkout only after clean-state proof.
6. Archive the old GitHub repository `JRedeker/opencode-model-preferences` only after OMR verification passes.

## Acceptance Criteria

1. `cmd/omp/` and its tests are removed from the OMR repo.
2. `make build-omp`, `COMPAT_BINARY`, and clean-target `omp` removal are gone.
3. README and schema no longer describe OMP as an active supported binary or required standalone project.
4. Obsolete OMP-only tmux/openchad docs are removed or rewritten as historical/irrelevant; active docs refer to OMR where applicable.
5. `.gitignore` no longer ignores `/omp`; backup suffix policy is updated from `omp-backup` to an OMR-neutral or OMR-named suffix, with docs/tests updated.
6. Remaining `omp` text matches are either absent or explicitly historical/archived/vendor/license-context references.
7. OMR verification passes: `make test`, `make lint`, `./scripts/e2e-smoke.sh`, `./scripts/deploy-local.sh --check`, and live `opencode models`.
8. `/home/jon/dev/omp` is removed only after `git status --short` shows no uncommitted work and remote is confirmed as `JRedeker/opencode-model-preferences`.
9. GitHub repo `JRedeker/opencode-model-preferences` is archived only after local OMR verification passes.
10. Current OMR plugin remains enabled and working after all cleanup.

## Constraints

1. Do not rewrite OMR fallback behavior.
2. Do not change `fallback_models` schema semantics.
3. Do not remove Advance archive records or historical change bundles.
4. Do not remove unrelated substring matches such as `prompt`, `compliance`, or `compatibility`.
5. Treat local directory deletion and GitHub archive as destructive/external actions requiring exact target verification immediately before execution.
6. If GitHub archive fails due to permission/API limits, preserve repo cleanup and report the remote blocker.

## Discovery Evidence

- OMR live proof passed on shipped main: `opencode models` exits 0, OMR plugin loads, provider init completes.
- OMR config is loaded from `~/.config/opencode/opencode.jsonc`; OMR plugin path is registered.
- Local old repo `/home/jon/dev/omp` has remote `https://github.com/JRedeker/opencode-model-preferences.git`.
- Remote repo `JRedeker/opencode-model-preferences` is an old standalone OMP repo with README title `omp — OpenCode Model Preferences`.
- Active OMR repo still contains OMP references in Makefile, README, `.gitignore`, schema description, and OMP/openchad docs.

## Sign-Off

Approved by user reply: `approve`.