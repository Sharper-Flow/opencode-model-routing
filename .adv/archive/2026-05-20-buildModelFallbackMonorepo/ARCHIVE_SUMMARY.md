# Archive: Build model fallback monorepo

**Change ID:** buildModelFallbackMonorepo
**Archived:** 2026-05-20T14:04:18.607Z
**Created:** 2026-05-20T05:25:45.439Z

## Tasks Completed

- ✅ Rename go module path to github.com/Sharper-Flow/opencode-model-routing
  > Task checkpoint completed
- ✅ Decouple make install from pre-push hook installation
  > Task checkpoint completed
- ✅ Add make test and make lint targets
  > Task checkpoint completed
- ✅ Add writeBackup helper and integrate into ApplyPreferences with writeFileAtomic
  > Task checkpoint completed
- ✅ Refresh Go dependencies (go mod tidy) and resolve documented lint warnings
  > Task checkpoint completed
- ✅ Author schema/fallback-schema.json and schema-contract-check.sh
  > Task checkpoint completed
- ✅ Add fallback chain validation (internal/config/fallback.go) and PreferencesConfig field
  > Task checkpoint completed
- ✅ Extend discoverTargets to read fallback_models from JSON config and markdown frontmatter
  > Task checkpoint completed
- ✅ Extend ApplyPreferences to write agent.<name>.options.fallback_models
  > Task checkpoint completed
- ✅ Add fallback chain editor view to TUI
  > Task checkpoint completed
- ✅ Scaffold plugin/ directory: package.json, tsconfig, config loader, types, state store
  > Task checkpoint completed
- ✅ Detection classifier and agent resolver
  > Task checkpoint completed
- ✅ Replay orchestrator with abort→revert→prompt sequence
  > Task checkpoint completed
- ✅ Preemptive skip via chat.message hook, TTFT timer, plugin entrypoint wiring
  > Task checkpoint completed
- ✅ Top-level Makefile orchestrating both stacks, wire schema-contract-check into lint
  > Task checkpoint completed
- ✅ End-to-end smoke test: omp writes options.fallback_models, plugin loads it correctly
  > Task checkpoint completed

## Specs Modified

