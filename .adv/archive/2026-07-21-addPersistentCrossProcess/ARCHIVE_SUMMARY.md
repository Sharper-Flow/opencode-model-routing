# Archive: Add persistent cross-process cooldown store

**Change ID:** addPersistentCrossProcess
**Archived:** 2026-07-21T16:21:27.778Z
**Created:** 2026-07-21T13:32:18.417Z

## Tasks Completed

- ✅ Setup: add proper-lockfile dependency and extract shared atomic-write test helper
  > Task checkpoint completed
- ✅ Implement plugin/src/state/cooldown-store.ts (CooldownStore class) + plugin/test/cooldown-store.test.ts
  > Task checkpoint completed
- ✅ Wire CooldownStore into model-health.ts (ModelHealthMap) and store.ts (FallbackStore)
  > Task checkpoint completed
- ✅ Make TTFT handler subagent-aware (Part 2) + add KD8 await in attemptFallback
  > Task checkpoint completed
- ✅ Integration tests: plugin/test/cross-process-cooldown.test.ts
  > Task checkpoint completed
- ✅ Bun compatibility smoke test for proper-lockfile integration
  > Task checkpoint completed

## Specs Modified

