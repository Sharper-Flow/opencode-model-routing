# Acceptance

Reviewed at: 2026-07-21T16:12:58.440Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| SC1 | success_criterion | End users no longer see 60s+ TTFT hangs or hard failures on a provider whose quota is already known exhausted elsewhere. | pass | AC1+AC5 verified: cross-process preemptive redirect after first failure (T5) + subagent TTFT sets cooldown without 60s dead-session recovery (T4). |
| SC2 | success_criterion | A cooldown set in one process is observable in another process's preemptive redirect within its next spawn cycle. | pass | T5 cross-process preemptive redirect verifies end-to-end visibility. KD8 await guarantees persist settle before sibling's spawn. |
| SC3 | success_criterion | No regression to existing fallback chain resolution, preemptive redirect, or availability preflight behavior. | pass | Full plugin suite 350/350. ModelHealthMap backwards compat verified. |
| AC1 | acceptance_criterion | After one quota_exhausted failure in process A, a fresh process B's next adv-engineer spawn hits preemptive redirect to the next healthy chain entry (verified by cross-process harness with shared cooldown file). | pass | cross-process-cooldown.test.ts AC1 tests (3): preemptive, fallback-resolver, preflight caller paths skip cooldown model in process B. |
| AC2 | acceptance_criterion | N≥2 concurrent cooldown writes to the shared file preserve every distinct model entry (no sibling erasure); per-model expiry = max across writers. | pass | cooldown-store.test.ts concurrent persists (2+4); cross-process-cooldown.test.ts (3+4 cross-process); bun-lockfile-compat.test.ts real-subprocess 2+4 writers. |
| AC3 | acceptance_criterion | Missing / stale / malformed / wrong-perm cooldown file never blocks fallback — read returns "not in cooldown", no exception escapes the read path, fallback works unchanged. | pass | cooldown-store.test.ts fail-open (8 tests); cross-process-cooldown.test.ts fail-open across preemptive/resolver/preflight paths. |
| AC4 | acceptance_criterion | Persistent cooldown survives process restart; expired entries pruned on write; expired entries do not block reads. | pass | cooldown-store.test.ts prune-on-write; cross-process-cooldown.test.ts restart cycle (3 tests). |
| AC5 | acceptance_criterion | TTFT firing on a subagent session sets cooldown without dead-session recovery (`isSubagent=true` flows through `handleTtftTimeout`; no `fallback.messages_failed` / `fallback.abort_failed` on dead subagent). | pass | ttft-subagent-aware.test.ts (4 tests): short-circuit, full recovery, EC5 default, detection cached. No recovery SDK calls on dead subagent. |
| AC6 | acceptance_criterion | All existing in-process cooldown tests pass unchanged. | pass | Full suite 350/350. Existing tests across 20 files pass unchanged. |
| C1 | constraint | Fail-open invariant — malformed/missing/wrong-perm cooldown file never blocks fallback (user decision 2026-07-21). | respected | CooldownStore.readCooldowns returns empty Map on every failure; persistCooldown never rejects. 8 fail-open unit + 4 integration tests. |
| C2 | constraint | Atomic write + cooperative lock around read-merge-write (LBP finding rq-disc10; addresses concurrent-writer lost-update hazard). | respected | CooldownStore.persistCooldown uses proper-lockfile.lock() around read-merge-write. Atomic rename. Concurrent persist tests + bun subprocess smoke test confirm. |
| C3 | constraint | Owner-only perms (0600), matching the Claude availability-snapshot pattern (user decision 2026-07-21). | respected | CooldownStore writes temp file mode:0o600 then renames. Reader enforces (mode & 0o077) === 0. Wrong-perm tests verify rejection. |
| C4 | constraint | OMR-only — no upstream OpenCode filing or coupling (user decision 2026-07-21). | respected | All changes in plugin/. No upstream coupling. proper-lockfile is only new dep. |
| C5 | constraint | Same TTL authority as in-memory: `cooldownMsByCategory[reason] ?? cooldownMs` (existing semantics preserved). | respected | ModelHealthMap.cooldown() persists absolute expiresAt computed by caller; TTL authority stays in cooldownMsByCategory. |
| C6 | constraint | Bun host compatibility required — any lock primitive must work under Bun. | respected | bun-lockfile-compat.test.ts spawns real bun subprocesses (2+4 writers). Both pass. proper-lockfile confirmed Bun-safe. |
| DONT1 | avoidance | No cross-process locking scheme that can itself hang (advisory locks only, bounded retries, fail-open on acquisition failure). | respected | proper-lockfile advisory locking, retries:3, stale:10s, onCompromised:log. Fail-open on acquisition failure. |
| DONT2 | avoidance | No regression to existing in-process cooldown tests or `isInCooldown(key)` call-site semantics for preemptive redirect, fallback chain resolution, or availability preflight. | respected | ModelHealthMap backwards-compat tests verify no-cooldownStore path unchanged. Full suite 350/350 pass. |
| DONT3 | avoidance | No cross-process session-state sharing beyond cooldown (session-state.ts remains per-process by design). | respected | session-state.ts NOT modified. Only cooldown-related files changed. |
| DONT4 | avoidance | No persistence of cooldowns unbounded by the existing `cooldownMsByCategory` authority. | respected | ModelHealthMap.cooldown signature unchanged; durationMs from caller's cooldownMsByCategory authority. |
| OOS1 | out_of_scope | Upstream OpenCode fix (user declined filing; OMR must tolerate missing event emission). | missing |  |
| OOS2 | out_of_scope | Provider-specific quota probes (OMR does not query provider quota APIs). | missing |  |
| OOS3 | out_of_scope | Cross-process session-state sharing beyond cooldown (only cooldown needs to be shared for preemptive redirect to work across processes). | missing |  |
| OOS4 | out_of_scope | TTFT tuning mechanism (Part 3 of proposal design) — recorded as open design question DQ2 for /adv-design; exact mechanism deferred. | missing |  |

