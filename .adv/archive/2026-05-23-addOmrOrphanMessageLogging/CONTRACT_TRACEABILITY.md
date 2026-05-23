# Contract Traceability

**Change ID:** addOmrOrphanMessageLogging
**Contract Version:** 1
**Rigor:** standard
**Reviewed:** 2026-05-23T22:39:19.954Z

## Contract Items

| ID | Kind | Status | Evidence Policy | Evidence |
| --- | --- | --- | --- | --- |
| AC1 | acceptance_criterion | pass | test | test/orchestrator.test.ts:289 'orphan present → field in fallback.success' passes (camelCase orphanMessageId per remediation arch-2); helper found in orchestrator.ts via findOrphanCandidate |
| AC2 | acceptance_criterion | pass | test | test/orchestrator.test.ts:316 'no orphan' + 403 'assistant-before-user' + 424 'only-user' all assert orphanMessageId is undefined |
| AC3 | acceptance_criterion | pass | test | test/orchestrator.test.ts:346 malformed-array test → result.success === true confirms fallback flow not blocked; findOrphanCandidate try/catch returns undefined on throw |
| AC4 | acceptance_criterion | pass | test | test/orchestrator.test.ts:319 multiple-latest-wins verifies walk order; 397 assistant-before-user verifies sawLastUser flag boundary; defensive isRecord+typeof in orchestrator.ts findOrphanCandidate |
| AC5 | acceptance_criterion | pass | test | All pre-existing fallback.success tests still pass; payload built as Record<string, unknown> with existing keys (sessionId, from, to, reason, depth) untouched |
| AC6 | acceptance_criterion | pass | test | 7 new test fixtures: orphan-present (flat), nested-shape ({info:{},parts:[]}), no-orphan, multiple-latest-wins, malformed-array, assistant-before-user, only-user. All in test/orchestrator.test.ts describe block 'orphan_message_id logging' |
| AC7 | acceptance_criterion | pass | test | Full plugin suite 124/124 pass; was 117 + 7 new tests added by this change |
| AC8 | acceptance_criterion | pass | test | make deploy-local: tsup build success (24.21KB dist/index.js), deploy script verified + registered; 3 grep hits for orphanMessageId/findOrphanCandidate in deployed bundle |
| C1 | constraint | respected | static_check | git diff main..HEAD shows zero new client.session.* calls; orchestrator.ts already had session.messages fetch reused |
| C2 | constraint | respected | static_check | client.session.revert call unchanged (orchestrator.ts:148): same messageID, same options |
| C3 | constraint | respected | static_check | No delete attempt added to OMR; SDK has no message.delete; cleanup remains operational via session-doctor |
| C4 | constraint | respected | static_check | test/orchestrator.test.ts:346 malformed-array test: result.success === true confirms fallback flow proceeds; try/catch around findOrphanCandidate body prevents block |
| C5 | constraint | respected | static_check | findOrphanCandidate uses shared isRecord from plugin/src/utils/type-guards.ts (arch-1 remediation) + explicit typeof checks for id/role + Array.isArray for parts |
| OOS1 | out_of_scope | not_applicable | not_applicable | OOS: deleting orphan rows from OMR — SDK has no message.delete; respected |
| OOS2 | out_of_scope | not_applicable | not_applicable | OOS: periodic session-doctor scheduling — operational; respected |
| OOS3 | out_of_scope | not_applicable | not_applicable | OOS: cooldown precision improvements — user-decided separately; respected |
| OOS4 | out_of_scope | not_applicable | not_applicable | OOS: tagging messages at creation — SDK has no message-update API; respected |
| OOS5 | out_of_scope | not_applicable | not_applicable | OOS: upstream PR for OpenCode message.delete — deferred; respected |
| OOS6 | out_of_scope | not_applicable | not_applicable | OOS: emit orphanMessageId on failure paths — added during review via deferred-suggestions rejection; failure paths rare, doctor SQL finds orphans regardless; respected |

## Task References

| Task | Implements | Verifies | Respects | N/A Reason |
| --- | --- | --- | --- | --- |
| tk-42d5085ded79 | AC1, AC2, AC3, AC4, AC5 | AC1, AC2, AC3, AC4, AC5, AC6, AC7 | C1, C2, C3, C4, C5 |  |
| tk-4b252bf0be8c |  | AC8 |  | Build/deploy task; no TDD applicable. Verification is dist file equality + grep + deploy script success. |
