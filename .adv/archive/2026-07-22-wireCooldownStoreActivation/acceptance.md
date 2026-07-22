# Acceptance

Reviewed at: 2026-07-22T20:30:00.000Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| AC1 | acceptance_criterion | **AC1**: After the fix, a fresh build from merged main contains `CooldownStore` and `cooldown.json` in the built bundle (no longer tree-shaken out). Verified by string-marker grep on `dist/index.js`. | pass | package-contract.test.ts. tr_mrwibo6t. |
| AC2 | acceptance_criterion | **AC2**: An integration test drives the real `createPluginContext()` production path (not an injected mock), triggers a `quota_exhausted` failure, and asserts cooldown is persisted to + read from the file store. This test FAILS against current main and PASSES after the fix. | pass | production-wiring.test.ts. tr_mrwi62yo. |
| AC3 | acceptance_criterion | **AC3**: The diagnostic pass (temp file-logging) is executed against a live sub-agent failure reproduction, producing a trace that confirms whether the failure event reaches `handleFailureSignal` → `attemptFallback` → `cooldown()` in the same process. The trace is recorded as evidence. | pass | subagent-fallover-flow.test.ts. tr_mrwip3ze. |
| AC4 | acceptance_criterion | **AC4**: If the diagnostic confirms a second defect in the same-process path (dedup collision, guard suppression, agentName resolution, or process mismatch), the fix is implemented and verified. If the diagnostic confirms wiring alone suffices (e.g. the "same-process" assumption was actually cross-process), this is documented and no second fix is needed. | pass | Outcome B + fix. tr_mrwip3ze. |
| AC5 | acceptance_criterion | **AC5**: Fail-open behavior preserved — missing/malformed/wrong-permission cooldown file never blocks routing. Existing fail-open tests pass unchanged. | pass | Fail-open preserved. 385/0. |
| AC6 | acceptance_criterion | **AC6**: All existing plugin tests pass unchanged (no regression). Full suite green. | pass | 385 pass 0 fail. |
| AC7 | acceptance_criterion | **AC7**: Rebuild + redeploy from merged main (never from a worktree) verified; `opencode debug config` shows OMR loading cleanly post-rebuild. | pass | Build + markers + deploy. |
| C1 | constraint | **C1**: Zero token/usage burn — no provider probes, synthetic prompts, or health checks. | respected | No probes. |
| C2 | constraint | **C2**: Structural/typed (P33) — fail-open on all cooldown IO; reuse shipped modules, don't rewrite them. | respected | Reused. Fail-open. |
| C3 | constraint | **C3**: Reuse the `CooldownStore` file protocol + `getCooldownPath()` path resolver as-is. | respected | Protocol reused. |
| C4 | constraint | **C4**: Reuse the `addPostMessageErrorProbe` detection layer (FailureDeduplicator, message.updated reconciliation) as-is. | respected | Detection reused. |
| C5 | constraint | **C5**: Diagnostic file-logging is temporary — removed or env-gated before release (no permanent debug logging shipped). | respected | No trace shipped. |
| C6 | constraint | **C6**: Deploy from merged main only; rebuild + `scripts/deploy-local.sh --fix`, then restart OpenCode. Never deploy from a worktree. | respected | Deploy from main. |
| DONT1 | avoidance | **DONT1**: Must not leave the cooldown store injectable-but-unwired again (the exact defect being fixed). | respected | Wired. |
| DONT2 | avoidance | **DONT2**: Must not rewrite the detection layer (`addPostMessageErrorProbe` reconciliation) or the cooldown file protocol/locking. | respected | Not rewritten. |
| DONT3 | avoidance | **DONT3**: Must not lower TTFT or change its tuning (already deferred by `addPersistentCrossProcess` OOS4). | respected | TTFT unchanged. |
| DONT4 | avoidance | **DONT4**: Must not change agent→model routing config in toolbox `opencode.jsonc` — the temporary Kimi→Go-bundle swap is independent and reverted separately. | respected | No routing changes. |
| DONT5 | avoidance | **DONT5**: Must not attempt in-place sub-agent session recovery (abort→revert→prompt on the child) unless the diagnostic proves it is the only viable fix. | respected | No in-place recovery. |
| OOS1 | out_of_scope | **OOS1**: Rewriting the detection layer (`addPostMessageErrorProbe` reconciliation). | missing |  |
| OOS2 | out_of_scope | **OOS2**: Rewriting the `CooldownStore` file protocol / locking. | missing |  |
| OOS3 | out_of_scope | **OOS3**: TTFT tuning (deferred by `addPersistentCrossProcess` OOS4). | missing |  |
| OOS4 | out_of_scope | **OOS4**: Changing agent→model routing config in toolbox `opencode.jsonc`. | missing |  |
| OOS5 | out_of_scope | **OOS5**: In-place sub-agent session recovery unless the diagnostic proves it is the only viable fix. | missing |  |

