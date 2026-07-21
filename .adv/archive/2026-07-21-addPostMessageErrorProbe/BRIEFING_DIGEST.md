# Archive Briefing Digest

**Change ID:** addPostMessageErrorProbe
**Title:** Add post-message error probe
**Status:** archived
**Generated:** 2026-07-21T17:40:51.905Z

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
| release | done |

## Epic Context

No Epic membership

## Durable Facts

Showing 15 of 15 durable facts.

- **[report_follow_up]** follow_ups: Packet omitted TASK_SCOPE, IN_SCOPE, OUT_OF_SCOPE, DONE_WHEN, STOP_WHEN, and VERIFICATION anchors; research proceeded using the user request and authoritative briefing packet.
- **[report_follow_up]** follow_ups: No implementation exists yet, so AC8/full-suite evidence is intentionally pending.
- **[research_citation]** sources: OpenCode plugin documentation: Documents plugin event hooks and lists message.updated, session.error, session.status, and session.deleted as available events. (https://opencode.ai/docs/plugins/)
- **[research_citation]** sources: OpenCode current plugin runtime: Plugin runtime listens through EventV2Bridge and forwards each event to hook.event; it does not provide replay/cursor metadata to the hook. (https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)
- **[research_citation]** sources: OpenCode EventV2 bridge: Bridge decorates/publishes events and separately emits durable sync envelopes to GlobalBus; normal plugin hooks receive normal event payloads. (https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/event-v2-bridge.ts)
- **[research_citation]** sources.omitted: 4 additional sources omitted (bounded to first 3)
- **[archive_only_evidence]** architecture_assessment: PASS WITH ONE CAUTION. The plugin event hook is the canonical integration point: OpenCode's plugin runtime listens through EventV2Bridge and forwards {id,type,properties} to hook.event (https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts). OpenCode's processor publishes session.error before ensuring(cleanup()) persists assistantMessage through updateMessage (https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts); the durable message.updated path therefore correctly reconciles missed transient delivery. The schema makes message.updated durable by sessionID and session.error transient, while providing typed assistant-error variants including MessageAbortedError (https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/session.ts). Exact-plus-provisional indexing is the smallest structural mechanism that bridges a no-message-ID transient signal to a persisted message-ID signal in either order. Caution: the design does not explicitly specify whether a session.status retry signal is deduplicated against a subsequent same-cause session.error. Its stated status fingerprint shape can differ from the error fingerprint, so a test/explicit key policy is needed to prove SC1/DONT3 for that transition.
- **[unresolved_action]** required_main_agent_actions: No remediation required. Record this independent acceptance evidence and proceed with acceptance-gate evaluation.
- **[unresolved_action]** required_main_agent_actions: Leave unrelated availability/preflight, persistent cooldown architecture, and upstream OpenCode changes untouched.
- **[wisdom_candidate]** wisdom_candidates: [success] A synchronous bounded alias registry ahead of async fallback dispatch proves EventV2 transient/durable ordering idempotency without adding a polling or SSE lifecycle.
- **[archive_only_evidence]** verification: tests_run=bun test, bun run typecheck, bun run build, git diff --check main...HEAD results=pass — 374/374 tests passed across 21 files; TypeScript typecheck passed; tsup ESM and DTS build passed. Diff check passed. Source review found EventV2 handling remains in the existing event hook; no provider probe, direct SSE, polling timer, or OpenCode downgrade was added. failure.signal logs source/session/message/category/duplicate only; responseBody remains fingerprint input and is not logged.
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun test
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run typecheck
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run build
- **[unresolved_action]** consumer_warnings: verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: git diff --check main...HEAD

## Contract / AC Coverage

| ID | Kind | Status |
| --- | --- | --- |
| SC1 | success_criterion | pass |
| SC2 | success_criterion | pass |
| SC3 | success_criterion | pass |
| SC4 | success_criterion | pass |
| AC1 | acceptance_criterion | pass |
| AC2 | acceptance_criterion | pass |
| AC3 | acceptance_criterion | pass |
| AC4 | acceptance_criterion | pass |
| AC5 | acceptance_criterion | pass |
| AC6 | acceptance_criterion | pass |
| AC7 | acceptance_criterion | pass |
| AC8 | acceptance_criterion | pass |
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
| OOS5 | out_of_scope | missing |

## Unresolved Actions

- No remediation required. Record this independent acceptance evidence and proceed with acceptance-gate evaluation.
- Leave unrelated availability/preflight, persistent cooldown architecture, and upstream OpenCode changes untouched.
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun test
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run typecheck
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: bun run build
- verification_missing: Reviewer aggregate evidence is non-authoritative; no typed adv_run_test run ID proves command: git diff --check main...HEAD
