# Contract Traceability

**Change ID:** addPersistentCrossProcess
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 2026-07-21T16:12:58.440Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| SC1 | success_criterion | pass | review | AC1+AC5 verified: cross-process preemptive redirect after first failure (T5) + subagent TTFT sets cooldown without 60s dead-session recovery (T4). |
| SC2 | success_criterion | pass | review | T5 cross-process preemptive redirect verifies end-to-end visibility. KD8 await guarantees persist settle before sibling's spawn. |
| SC3 | success_criterion | pass | review | Full plugin suite 350/350. ModelHealthMap backwards compat verified. |
| AC1 | acceptance_criterion | pass | test | cross-process-cooldown.test.ts AC1 tests (3): preemptive, fallback-resolver, preflight caller paths skip cooldown model in process B. |
| AC2 | acceptance_criterion | pass | test | cooldown-store.test.ts concurrent persists (2+4); cross-process-cooldown.test.ts (3+4 cross-process); bun-lockfile-compat.test.ts real-subprocess 2+4 writers. |
| AC3 | acceptance_criterion | pass | test | cooldown-store.test.ts fail-open (8 tests); cross-process-cooldown.test.ts fail-open across preemptive/resolver/preflight paths. |
| AC4 | acceptance_criterion | pass | test | cooldown-store.test.ts prune-on-write; cross-process-cooldown.test.ts restart cycle (3 tests). |
| AC5 | acceptance_criterion | pass | test | ttft-subagent-aware.test.ts (4 tests): short-circuit, full recovery, EC5 default, detection cached. No recovery SDK calls on dead subagent. |
| AC6 | acceptance_criterion | pass | test | Full suite 350/350. Existing tests across 20 files pass unchanged. |
| C1 | constraint | respected | static_check | CooldownStore.readCooldowns returns empty Map on every failure; persistCooldown never rejects. 8 fail-open unit + 4 integration tests. |
| C2 | constraint | respected | static_check | CooldownStore.persistCooldown uses proper-lockfile.lock() around read-merge-write. Atomic rename. Concurrent persist tests + bun subprocess smoke test confirm. |
| C3 | constraint | respected | static_check | CooldownStore writes temp file mode:0o600 then renames. Reader enforces (mode & 0o077) === 0. Wrong-perm tests verify rejection. |
| C4 | constraint | respected | static_check | All changes in plugin/. No upstream coupling. proper-lockfile is only new dep. |
| C5 | constraint | respected | static_check | ModelHealthMap.cooldown() persists absolute expiresAt computed by caller; TTL authority stays in cooldownMsByCategory. |
| C6 | constraint | respected | static_check | bun-lockfile-compat.test.ts spawns real bun subprocesses (2+4 writers). Both pass. proper-lockfile confirmed Bun-safe. |
| DONT1 | avoidance | respected | review | proper-lockfile advisory locking, retries:3, stale:10s, onCompromised:log. Fail-open on acquisition failure. |
| DONT2 | avoidance | respected | review | ModelHealthMap backwards-compat tests verify no-cooldownStore path unchanged. Full suite 350/350 pass. |
| DONT3 | avoidance | respected | review | session-state.ts NOT modified. Only cooldown-related files changed. |
| DONT4 | avoidance | respected | review | ModelHealthMap.cooldown signature unchanged; durationMs from caller's cooldownMsByCategory authority. |
| OOS1 | out_of_scope | missing | not_applicable |  |
| OOS2 | out_of_scope | missing | not_applicable |  |
| OOS3 | out_of_scope | missing | not_applicable |  |
| OOS4 | out_of_scope | missing | not_applicable |  |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-a1f3b2b7fbf5 |  |  | DONT2 | Mechanical setup; does not implement or verify contract behavior directly. Respects DONT2 by preserving existing test behavior. |
| tk-2941f5f79fd3 | C2, C3 |  | C1, DONT1, DONT4 |  |
| tk-520fd2a27486 | C5 |  | DONT2, DONT4 |  |
| tk-02813db935e2 | AC5 |  | DONT1, DONT2 |  |
| tk-8136a6bde4f8 |  | AC1, AC2, AC3, AC4, AC5, AC6 | DONT2, DONT3 |  |
| tk-c3280415f03e |  | C6 |  |  |
