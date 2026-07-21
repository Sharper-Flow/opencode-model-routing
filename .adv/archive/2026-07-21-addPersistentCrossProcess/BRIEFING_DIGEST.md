# Archive Briefing Digest

**Change ID:** addPersistentCrossProcess
**Title:** Add persistent cross-process cooldown store
**Status:** archived
**Generated:** 2026-07-21T16:21:27.782Z

## Identity Anchors

- CHANGE
- STATUS
- TERMINAL_GATE_SUMMARY

## Archive Digest

**Status:** archived

| Gate | Status |
| --- | --- |
| proposal | done |
| discovery | done |
| design | done |
| planning | done |
| execution | done |
| acceptance | done |
| release | pending |

## Epic Context

No Epic membership

## Durable Facts

Showing 10 of 10 durable facts.

- **[report_follow_up]** follow_ups: Context7 unavailable: monthly quota exceeded. Exa unavailable: API key missing. Canonical fallback documentation was retrieved.
- **[report_follow_up]** follow_ups: Verify persisted discovery artifact has rq-disc07 spec-law disposition; not checked due ADV state-access policy.
- **[research_citation]** sources: proper-lockfile official README: `realpath` defaults to true and requires target file to exist; stale defaults to 10 seconds; retries may be a retry-options object; default `onCompromised` throws. The implementation uses atomic mkdir locking. (https://github.com/moxystudio/node-proper-lockfile#lockfile-options)
- **[research_citation]** sources: proper-lockfile upstream test/example source: Upstream tests demonstrate locking a nonexistent target only with `{ realpath: false }`; retries can be configured with a retry object. (https://github.com/moxystudio/node-proper-lockfile/blob/master/test/lock.test.js)
- **[research_citation]** sources: Bun official Node.js compatibility: Bun documents node:fs as implemented at 92% of Node test-suite coverage, supporting a targeted real-Bun contention smoke test rather than an assumption of package compatibility. (https://bun.com/docs/runtime/nodejs-compat)
- **[research_citation]** sources.omitted: 5 additional sources omitted (bounded to first 3)
- **[archive_only_evidence]** architecture_assessment: CORRECTNESS: Locking the full read-merge-write transaction plus max-per-model expiry merge solves AC2 after acquisition; no merge race remains within an exclusive critical section. KD1 omits `realpath: false`, while proper-lockfile defaults to true and requires its target file to exist, so first-run cooldown.json cannot persist. Current ModelHealthMap.cooldown is synchronous void while proper-lockfile is asynchronous, leaving no specified completion point before B can spawn. A fresh B has empty cache, so KD4 does not defeat literal AC1, but it delays already-running sibling observation by up to two seconds. TTFT subagent handling mirrors existing detectSubagent behavior, which catches and defaults false. KD5 does not contradict SC1 for a provider already known exhausted elsewhere, but cannot remove first unknown exhaustion TTFT. SIMPLICITY: proper-lockfile is simpler than bespoke stale-PID locking because it uses mkdir and mtime stale handling. Bun documents no built-in locking primitive. Cache lacks cited hot-path measurement; file-atomic helper extraction is unrelated cleanup. SPEC-LAW: rq-disc07 requires spec deltas or explicit no-delta rationale. I cannot inspect discovery state under policy, so I do not know whether that is met; design itself does not evidence it.
- **[unresolved_action]** validation.blockers: KD1's shown `proper-lockfile.lock(path, { retries: 3, stale: 10_000 })` leaves `realpath` at its documented default true, which requires the cooldown target to exist. A first-run missing cooldown.json therefore cannot acquire the lock or persist; this violates first-write cross-process visibility and restart persistence.
- **[unresolved_action]** validation.blockers: KD1 does not override proper-lockfile's documented default `onCompromised`, which throws. A compromised lock update can therefore escape the persistence path rather than degrade to the required no-op behavior.
- **[unresolved_action]** validation.blockers: The design says `cooldown()` writes persistent state, but existing `cooldown()` is synchronous void while proper-lockfile acquisition/write is asynchronous. No ordered completion point is specified before a parent can issue B's replacement spawn, so AC1 is race-prone even after lock bootstrap is fixed.

## Contract / AC Coverage

| ID | Kind | Status |
| --- | --- | --- |
| SC1 | success_criterion | pass |
| SC2 | success_criterion | pass |
| SC3 | success_criterion | pass |
| AC1 | acceptance_criterion | pass |
| AC2 | acceptance_criterion | pass |
| AC3 | acceptance_criterion | pass |
| AC4 | acceptance_criterion | pass |
| AC5 | acceptance_criterion | pass |
| AC6 | acceptance_criterion | pass |
| C1 | constraint | respected |
| C2 | constraint | respected |
| C3 | constraint | respected |
| C4 | constraint | respected |
| C5 | constraint | respected |
| C6 | constraint | respected |
| DONT1 | avoidance | respected |
| DONT2 | avoidance | respected |
| DONT3 | avoidance | respected |
| DONT4 | avoidance | respected |
| OOS1 | out_of_scope | missing |
| OOS2 | out_of_scope | missing |
| OOS3 | out_of_scope | missing |
| OOS4 | out_of_scope | missing |

## Unresolved Actions

- KD1's shown `proper-lockfile.lock(path, { retries: 3, stale: 10_000 })` leaves `realpath` at its documented default true, which requires the cooldown target to exist. A first-run missing cooldown.json therefore cannot acquire the lock or persist; this violates first-write cross-process visibility and restart persistence.
- KD1 does not override proper-lockfile's documented default `onCompromised`, which throws. A compromised lock update can therefore escape the persistence path rather than degrade to the required no-op behavior.
- The design says `cooldown()` writes persistent state, but existing `cooldown()` is synchronous void while proper-lockfile acquisition/write is asynchronous. No ordered completion point is specified before a parent can issue B's replacement spawn, so AC1 is race-prone even after lock bootstrap is fixed.
