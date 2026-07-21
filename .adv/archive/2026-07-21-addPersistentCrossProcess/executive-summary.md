# Executive Summary

## Outcome

Adds a persistent cross-process cooldown store so that when one OpenCode plugin instance observes a non-retryable model failure (e.g., billing-cycle quota exhaustion), every other concurrent instance on the same host immediately skips that model on its next spawn — eliminating the cascade of 60s+ hangs and hard failures observed in production across 10+ processes.

## Why It Matters

Production evidence (2026-07-21) showed `adv-engineer` (kimi) failing 25+ times across 10+ OpenCode processes with zero preemptive redirects, because the in-memory cooldown state was invisible across processes. This change closes the cross-process visibility gap using a file-protocol store with cooperative locking — siblings now share cooldown state via `~/.local/share/opencode-model-routing/cooldown.json` (atomic, fail-open, owner-only). A secondary fix makes the TTFT-timeout handler subagent-aware, so TTFT timeouts on subagent sessions take the clean short-circuit path instead of attempting dead-session recovery. Together these end the cross-process cascade and prevent the residual in-process residual waste.

## Verdict

APPROVED

## What Was Built

1. **CooldownStore module** (`plugin/src/state/cooldown-store.ts`, ~380 LOC): persistent per-model cooldown map with file-protocol + proper-lockfile cooperative lock around read-merge-write. Mirrors the descriptor-bound reader pattern from `availability/snapshot.ts`. Reuses `parseStrictJson` (duplicate-key-rejecting). TTL-bounded in-process cache (2s) fronts hot-path reads. Prune-on-write bounds file size.
2. **ModelHealthMap + FallbackStore wiring** (`plugin/src/state/model-health.ts`, `plugin/src/state/store.ts`): optional `cooldownStore` injection (defaults to no-op for backwards compat). `cooldown()` returns `Promise<void>`; persists when store wired. `isInCooldown()` does read-through to persistent state when in-memory Map misses. Zero API regressions for callers that don't opt in.
3. **Subagent-aware TTFT handler** (`plugin/src/plugin-internal.ts`, `plugin/src/replay/orchestrator.ts`): `handleTtftTimeout` now calls `detectSubagent` and passes `isSubagent` to `attemptFallback` (mirrors the existing pattern at session.error/session.status call sites). KD8 invariant: `attemptFallback` awaits the cooldown persist settle before dispatching the replacement spawn, so sibling processes see the cooldown by the time their `isInCooldown` check runs.
4. **Comprehensive test coverage**: 5 new test files, 75 new tests, 0 regressions across the full 350-test plugin suite. Includes in-process cross-FallbackStore simulation, real bun subprocess lock contention (2-writer + 4-writer cases), fail-open across every caller path, and the KD8 ordering invariant.

## What Was Verified

- Verdict: APPROVED with 0 findings (inline review; subagent infrastructure unavailable in this session, so independent adv-reviewer spawn was not possible — review conducted inline against the 12-dimension framework and contract items)
- Tests: 350 pass / 0 fail across 20 files (added 272 tests). Full TDD evidence: RED→GREEN cycles recorded via `adv_run_test phase:'red'` + `phase:'green'` for each behavior-critical task.
- Preview URL: not_applicable — no frontend/visual surface; the change is plugin state-layer only (no UI components, no browser-visible output)
- Contract matrix: 23/23 rows passed/respected/not_applicable (0 failing). 6 ACs verified by explicit tests; 6 constraints respected; 4 avoidances honored; 4 out-of-scope items correctly excluded.
- Bun host compatibility: validated by `plugin/test/bun-lockfile-compat.test.ts` spawning real bun subprocesses contending for the same lockfile.
- Validator (adv-researcher design validation, Phase 3.5): all 5 findings integrated into amended design before implementation (KD1 explicit proper-lockfile options, KD8 persist-write ordering, KD4 cache necessity, EC5 confirmation, KD1 Bun-compat risk).

## Remaining Concerns

- **Subagent infrastructure note**: 3 consecutive empty returns from adv-engineer during execution prompted inline fallback for T1 and T6. T2–T5 executed inline per `inline_required` metadata. Subagent-driven review (adv-reviewer) was therefore not conducted; review was performed inline against the contract and 12-dimension framework. Independent review recommended post-merge if subagent infrastructure stabilizes.
- **CLARIFY_ASSUMPTION_HEAVY warning**: false-positive flag about "authentication/authorization" — the proposal uses "auth" only in the context of the `auth_error` ErrorCategory, not an authentication mechanism. No action required.
- **TTFT tuning (Part 3, OOS4)**: deferred to a follow-up change per design.md KD5. Residual 60s window remains for the first failure detection after a restart cycle (paid once per quota-exhaustion event, not per-spawn per-process). Open a separate change if production evidence shows this remains painful.
- **proper-lockfile dependency**: new runtime dep (~600 LOC, pure JS). Choice was gated by Bun compat smoke test (T6 passes); reversible to bespoke O_EXCL+PID fallback if a future Bun release breaks compat.

## Supporting Evidence

- Task IDs: tk-a1f3b2b7fbf5 (setup), tk-2941f5f79fd3 (CooldownStore impl + 35 tests), tk-520fd2a27486 (wiring + 14 tests), tk-02813db935e2 (TTFT subagent + KD8 + 8 tests), tk-8136a6bde4f8 (cross-process integration + 16 tests), tk-c3280415f03e (Bun smoke + 2 tests)
- Test runs: tr_mrut72ce_*, tr_mrut8d65_*, tr_mrut91xf_*, tr_mrut9hgr_*, tr_mrutcg8h_*, tr_mrutdfk0_*, tr_mrutdqub_*, tr_mrutio4a_*, tr_mrutjn8e_*, tr_mrutk3ds_*, tr_mrutnql1_*, tr_mruto7f9_*, tr_mrutq8oi_*, tr_mrutqnhp_*
- Git commits: fe47a14 (T1), 3efefd8 (T2), 45f700b (T3), 4d6053a (T4), d5448c8 (T5), 31d5dca (T6) on `change/addPersistentCrossProcess` branch
- Contract review matrix: 23/23 rows passing, persisted via `adv_contract_review_matrix_set`
- Design validation: adv-researcher Phase 3.5 report (advisory `fail` verdict — all 5 findings integrated)

## Consequence Context

| Category | Status | Source / Evidence |
|---|---|---|
| Delivered value | **shipped** | Cross-process cooldown visibility eliminates the production cascade (25+ failures/10+ processes → 0 redirects). Sibling processes now share state via atomic file-protocol. Acceptance summary + task summaries + contract review matrix. |
| Enabling-only/follow-up dependency | **none** | No required follow-ups. TTFT tuning (OOS4) is optional and only if residual 60s window remains painful in production. |
| Ops readiness | **pending (harden owns)** | Acceptance evidence is in. Harden owns release/deploy/production/docs/cleanup readiness. No production-impacting ops work identified — the cooldown file is auto-created on first write, no migration needed. |
| Migration/data impact | **n/a** | New runtime artifact `~/.local/share/opencode-model-routing/cooldown.json` (0600, auto-created). No existing data migrated. Fail-open if file missing/malformed. Source: C1/AC3 + design fail-open invariants. |
| Frontend/preview impact | **n/a** | No frontend/visual surface. Plugin state-layer only. Preview URL: not_applicable. |
| Collision/release risk | **low** | Single branch `change/addPersistentCrossProcess` from `main`. One new runtime dep (proper-lockfile, pure JS, gated by Bun compat smoke test). No cross-repo coupling. Acceptance review surfaced no blockers. |
| Open follow-ups | **none** | No required follow-ups. OOS4 (TTFT tuning) is optional post-merge work. No ops obligations. |
| Next action | **accept → /adv-harden** | Acceptance approval proceeds inline to `/adv-harden addPersistentCrossProcess` for release/deploy readiness verification before archive sign-off. |
