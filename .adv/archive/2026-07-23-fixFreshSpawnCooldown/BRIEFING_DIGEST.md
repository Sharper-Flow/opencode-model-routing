# Archive Briefing Digest

**Change ID:** fixFreshSpawnCooldown
**Title:** Fix fresh spawn cooldown
**Status:** archived
**Generated:** 2026-07-23T05:17:44.772Z

## Identity Anchors

- CHANGE
- STATUS
- TERMINAL_GATE_SUMMARY
- Origin: adhoc

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

Showing 28 of 28 durable facts.

- **[unresolved_action]** required_main_agent_actions: User acceptance may proceed with CAUTION; surface review-coverage-1 as non-blocking regression-hardening work.
- **[unresolved_action]** required_main_agent_actions: Do not mark release complete until the agreement's mandatory post-merge deploy/restart/live-spawn evidence is recorded. Perform deployment only from merged default branch.
- **[unresolved_action]** required_main_agent_actions: Optionally add the metadata-only fresh-child redirect regression before release; no scope or agreement change is required.
- **[wisdom_candidate]** wisdom_candidates: [pattern] Fresh-session routing needs an integration assertion per structural identity source: testing metadata resolution alone does not prove pre-dispatch redirect remains wired through that source.
- **[archive_only_evidence]** verification: tests_run=bun run --cwd plugin test, bun run --cwd plugin typecheck && bun run --cwd plugin lint && bun run --cwd plugin build, bun run --cwd plugin format:check results=pass — 394/394 tests across 24 files passed (10.47s; adv_run_test tr_mrx1p4yx_f6835f97). Typecheck, ESLint, and tsup build passed (tr_mrx1pfid_e0fb1ecc). format:check exited 1 only for plugin/test/detection.test.ts, package-contract.test.ts, production-wiring.test.ts, and subagent-fallover-flow.test.ts; git diff main...HEAD shows none of those four files changed, confirming pre-existing untouched formatter drift.
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin test
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin typecheck && bun run --cwd plugin lint && bun run --cwd plugin build
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin format:check
- **[unresolved_action]** required_main_agent_actions: Acceptance may proceed: prior metadata-only structural identity integration gap is closed.
- **[unresolved_action]** required_main_agent_actions: Retain and execute agreement release obligations after merge; do not claim release completion beforehand.
- **[archive_only_evidence]** verification: tests_run=bun run --cwd plugin test -- test/fresh-spawn-cooldown.test.ts, bun run --cwd plugin typecheck results=pass — Remediation test passed: 4/4 tests, 0 failures, including metadata-only fresh child with empty history, one session.get, zero messages/prompt calls (adv_run_test tr_mrx1svj8_4b5d5af6). Typecheck passed (tr_mrx1swz2_26fbd55a). Source inspection confirms the new test omits input.agent and obtains adv-engineer only from MockClient session.get metadata before asserting cooled-primary redirect a/one → b/two.
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin test -- test/fresh-spawn-cooldown.test.ts
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin typecheck
- **[report_follow_up]** follow_ups: Version evidence differs from packet's approximate fada1a5: codesearch fetched 92cede0541305a99579b0575b79297089d37e6da, which itself declares 1.18.4. Record the exact validated SHA.
- **[report_follow_up]** follow_ups: Need live/integration evidence for the parent agent's behavior after Task receives cancelled; source proves terminal cancellation, not model-directed re-spawn.
- **[report_follow_up]** follow_ups: Need explicit configuration/behavior policy for a cooled model key belonging to more than one agent chain.
- **[report_follow_up]** follow_ups: Add a resumed task_id test because upstream prompt input uses current next.name whereas session metadata is creation-time agent; precedence selects hook identity, but intended resume semantics need proof.
- **[research_citation]** sources: OpenCode 1.18.4 version basis: Fetched source reports packages/opencode version 1.18.4 at commit 92cede0541305a99579b0575b79297089d37e6da. (https://github.com/sst/opencode/blob/92cede0541305a99579b0575b79297089d37e6da/packages/opencode/package.json#L1-L4)
- **[research_citation]** sources: Task creation and prompt identity propagation: Task creates a child session with agent: next.name and calls prompt with agent: next.name. (https://github.com/sst/opencode/blob/92cede0541305a99579b0575b79297089d37e6da/packages/opencode/src/tool/task.ts#L151-L214)
- **[research_citation]** sources: chat.message hook contract and invocation: Hook input declares agent?: string. (https://github.com/sst/opencode/blob/92cede0541305a99579b0575b79297089d37e6da/packages/plugin/src/index.ts#L232-L244)
- **[research_citation]** sources.omitted: 10 additional sources omitted (bounded to first 3)
- **[archive_only_evidence]** architecture_assessment: Verdict CAUTION. Claims 1 and 2 are confirmed at upstream commit 92cede0541305a99579b0575b79297089d37e6da, whose fetched package version is 1.18.4. Hook-agent → persisted session-agent → history precedence is sound and structural; reuse of the one session.get response is safe if its unwrap/shape failure stays fail-open. Both current pre-dispatch helpers demonstrably early-return when agentName is absent. Core source is readable, not opaque: session cancellation cancels the child background job and resolves parent background.wait with cancelled. However TaskTool converts cancelled to a Task failure, not an automatic replacement spawn; parent re-spawn depends on the parent model/tool loop and needs live integration proof. Model-key-only chain selection is structurally data-driven but ambiguous whenever the cooled key occurs in multiple chains; Map/config order can be repeatable yet select another agent policy, so it is not sufficiently deterministic semantically without a collision rule.
- **[report_follow_up]** follow_ups: Packet omitted TASK_SCOPE/IN_SCOPE/OUT_OF_SCOPE/DONE_WHEN/STOP_WHEN/VERIFICATION anchors; report is constrained to the explicit correction request.
- **[research_citation]** sources: First-dispatch identity resolution and helper calls: Hook agent is cached first, structural session metadata second, committed-message scan last; resolved identity feeds both first-dispatch helpers. (file:///home/jon/.local/share/opencode/worktree/83d9c2be3d917269afb19d21ca172bdf6fbbbf29/change/fixFreshSpawnCooldown/plugin/src/plugin-internal.ts#L354-L385)
- **[research_citation]** sources: Cooldown preemptive first-dispatch gate: Helper returns without agent identity, now supplied by T1/T2 structural sources. (file:///home/jon/.local/share/opencode/worktree/83d9c2be3d917269afb19d21ca172bdf6fbbbf29/change/fixFreshSpawnCooldown/plugin/src/preemptive.ts#L26-L35)
- **[research_citation]** sources: Availability preflight first-dispatch gate: Identical agent-identity gate; same resolved identity fixes fresh first-dispatch selection. (file:///home/jon/.local/share/opencode/worktree/83d9c2be3d917269afb19d21ca172bdf6fbbbf29/change/fixFreshSpawnCooldown/plugin/src/availability/preflight.ts#L40-L53)
- **[research_citation]** sources.omitted: 2 additional sources omitted (bounded to first 3)
- **[archive_only_evidence]** architecture_assessment: AC11: historical fallover tests passed because their setup seeded messagesWithAgent(AGENT) before the first chat.message, making the history-only resolver succeed. Scenario 5 proves currentModel is populated despite empty first-hook history and later cooldown marking works after messages appear; it does not prove an already-cooled primary redirects on that first hook. AC12: both first-dispatch gates—applyPreemptiveSkip and applyAvailabilityPreflight—are fixed by T1/T2 structural identity caching. Remaining agent-identity-unavailable behavior belongs to pending T3; no additional first-dispatch gate using the scanned identifiers was found.

## Contract / AC Coverage

| ID | Kind | Status |
| --- | --- | --- |
| AC1 | acceptance_criterion | pass |
| AC2 | acceptance_criterion | pass |
| AC3 | acceptance_criterion | pass |
| AC4 | acceptance_criterion | pass |
| AC5 | acceptance_criterion | pass |
| AC6 | acceptance_criterion | pass |
| AC7 | acceptance_criterion | pass |
| AC8 | acceptance_criterion | pass |
| AC9 | acceptance_criterion | pass |
| AC10 | acceptance_criterion | pass |
| AC11 | acceptance_criterion | pass |
| AC12 | acceptance_criterion | pass |
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
| DONT5 | avoidance | respected |
| OOS1 | out_of_scope | missing |
| OOS2 | out_of_scope | missing |
| OOS3 | out_of_scope | missing |
| OOS4 | out_of_scope | missing |

## Unresolved Actions

- User acceptance may proceed with CAUTION; surface review-coverage-1 as non-blocking regression-hardening work.
- Do not mark release complete until the agreement's mandatory post-merge deploy/restart/live-spawn evidence is recorded. Perform deployment only from merged default branch.
- Optionally add the metadata-only fresh-child redirect regression before release; no scope or agreement change is required.
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin test
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin typecheck && bun run --cwd plugin lint && bun run --cwd plugin build
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin format:check
- Acceptance may proceed: prior metadata-only structural identity integration gap is closed.
- Retain and execute agreement release obligations after merge; do not claim release completion beforehand.
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin test -- test/fresh-spawn-cooldown.test.ts
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run --cwd plugin typecheck
