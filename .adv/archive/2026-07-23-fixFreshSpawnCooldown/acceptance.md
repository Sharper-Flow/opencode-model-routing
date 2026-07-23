# Acceptance

Reviewed at: 2026-07-23T05:15:30.000Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| AC1 | acceptance_criterion | **AC1 (core regression):** Fresh child + existing active primary cooldown + EMPTY session message history at first `chat.message` + session metadata identifies `adv-engineer` → `output.message.model` changes to the first healthy fallback BEFORE dispatch, and the cooled primary receives NO provider request. Test must NOT seed `messagesWithAgent(AGENT)` for the first hook. | pass | Same-process empty-history redirect. |
| AC2 | acceptance_criterion | **AC2:** AC1 driven through the real production `createPluginContext()` path (not an injected mock). | pass | createPluginContext coverage. |
| AC3 | acceptance_criterion | **AC3:** Same-process persisted-cooldown case covered. | pass | Same-process cooldown. |
| AC4 | acceptance_criterion | **AC4:** Fresh-context / cross-process read-through cooldown case covered. | pass | Persisted read-through. |
| AC5 | acceptance_criterion | **AC5:** Agent identity resolved from a structural source — `chat.message` `input.agent` primary, `session.get().agent` authoritative fallback — verified populated for fresh sub-agents. No heuristic inference (P33). | pass | Hook and metadata identity coverage. |
| AC6 | acceptance_criterion | **AC6:** Identity-unavailable behavior is deterministic and tested: never silently dispatch a model known to be cooled. | pass | Unique/zero/multiple chain coverage. |
| AC7 | acceptance_criterion | **AC7:** Ordered first-healthy fallback selection preserved (existing `resolveFallbackModel` semantics unchanged). | pass | Fallback order preserved. |
| AC8 | acceptance_criterion | **AC8:** Both first-dispatch paths fixed — `applyPreemptiveSkip` AND `applyAvailabilityPreflight` (identical `if (!agentName) return` defect). | pass | Fresh preemptive/availability coverage. |
| AC9 | acceptance_criterion | **AC9 (TTFT):** TTFT-stalled sub-agent handoff audited and proven. OMR-owned lifecycle gap fixed so a stalled child hands control back and rollover is not blocked; regression test for TTFT-stalled sub-agent handoff. If a genuine core limitation remains, source-backed evidence + concrete upstream follow-up recorded — but every OMR-owned fix shipped. | pass | TTFT abort coverage. |
| AC10 | acceptance_criterion | **AC10:** All existing plugin tests pass unchanged; full repository check green or a source-backed classification of pre-existing unrelated hygiene drift is recorded. | pass | 395/395 full suite tr_mrx236x0_d4d6b324. |
| AC11 | acceptance_criterion | **AC11:** Documented explanation of precisely why previous tests passed despite the production defect (the `messagesWithAgent` first-hook seeding mask). | pass | T6 review evidence. |
| AC12 | acceptance_criterion | **AC12:** Adjacent first-dispatch paths scanned for the same message-history timing assumption; findings recorded. | pass | T6 scan evidence. |
| C1 | constraint | **C1:** No opencode-core patch/fork/rebuild (global rule + req 7). | respected | No core changes. |
| C2 | constraint | **C2:** Structural identity only — `input.agent` / `session.get().agent`. No heuristic inference. | respected | Structural-only identity. |
| C3 | constraint | **C3:** Fail-open — identity-resolution or `session.get` failure must never crash routing or block a healthy dispatch. | respected | Fail-open handling. |
| C4 | constraint | **C4:** Reuse `detectSubagent`'s existing `session.get` response for the agent fallback; no redundant API calls. | respected | One session.get assertion. |
| C5 | constraint | **C5:** Work only in the ADV-managed worktree; merge before deploy; deploy from merged default branch. | respected | Worktree-only. |
| C6 | constraint | **C6:** Route tests through `bin/oc-test` if present; otherwise cap Vitest/bun workers. | respected | Isolated Bun tests. |
| DONT1 | avoidance | **DONT1:** Do not seed `messagesWithAgent(AGENT)` for the first-hook regression tests. | respected | No message seed. |
| DONT2 | avoidance | **DONT2:** Do not break existing preemptive redirect for primary sessions with committed history. | respected | Regression suite green. |
| DONT3 | avoidance | **DONT3:** Do not silently dispatch a model known to be cooled. | respected | No ambiguity guessing. |
| DONT4 | avoidance | **DONT4:** Do not expand into unrelated OMR refactors or bump the SDK as part of this change. | respected | Targeted diff. |
| DONT5 | avoidance | **DONT5:** Do not leave TTFT sub-agent rollover permanently blocked. | respected | Child abort coverage. |
| OOS1 | out_of_scope | Rewriting `resolveFallbackModel` ordered selection. | missing |  |
| OOS2 | out_of_scope | Rewriting `CooldownStore` file protocol/locking. | missing |  |
| OOS3 | out_of_scope | Bumping `@opencode-ai/plugin`/`sdk` deps (separate follow-up). | missing |  |
| OOS4 | out_of_scope | Any opencode-core change (upstream follow-up only). | missing |  |

