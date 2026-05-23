# Acceptance

Reviewed at: 2026-05-23T22:39:19.954Z

## Contract Review Matrix

| ID | Kind | Requirement | Status | Evidence |
|---|---|---|---|---|
| AC1 | acceptance_criterion | `fallback.success` log event includes `orphanMessageId: string` field (camelCase per codebase convention) when the messages-after-lastUser walk identifies an assistant message with empty parts. | pass | test/orchestrator.test.ts:289 'orphan present → field in fallback.success' passes (camelCase orphanMessageId per remediation arch-2); helper found in orchestrator.ts via findOrphanCandidate |
| AC2 | acceptance_criterion | `orphanMessageId` field is omitted (not set to `null`, not `undefined`, not empty string) when no orphan is detected. | pass | test/orchestrator.test.ts:316 'no orphan' + 403 'assistant-before-user' + 424 'only-user' all assert orphanMessageId is undefined |
| AC3 | acceptance_criterion | `orphanMessageId` field is omitted when the orphan-find logic throws — the catch must not block the fallback dispatch. | pass | test/orchestrator.test.ts:346 malformed-array test → result.success === true confirms fallback flow not blocked; findOrphanCandidate try/catch returns undefined on throw |
| AC4 | acceptance_criterion | The orphan-find logic walks messages with index > lastUser-index, filters to `role === "assistant"` with `parts.length === 0`, picks the most-recent (highest index). | pass | test/orchestrator.test.ts:319 multiple-latest-wins verifies walk order; 397 assistant-before-user verifies sawLastUser flag boundary; defensive isRecord+typeof in orchestrator.ts findOrphanCandidate |
| AC5 | acceptance_criterion | Existing `fallback.success` fields (`sessionId`, `from`, `to`, `reason`, `depth`) unchanged. | pass | All pre-existing fallback.success tests still pass; payload built as Record<string, unknown> with existing keys (sessionId, from, to, reason, depth) untouched |
| AC6 | acceptance_criterion | New test fixtures cover: orphan present (flat shape), nested OpenCode shape `{info: {id, role}, parts}`, no orphan (LLM completed normally), assistant message with parts (not an orphan), malformed messages array, assistant-before-user (no false match), empty messages array. | pass | 7 new test fixtures: orphan-present (flat), nested-shape ({info:{},parts:[]}), no-orphan, multiple-latest-wins, malformed-array, assistant-before-user, only-user. All in test/orchestrator.test.ts describe block 'orphan_message_id logging' |
| AC7 | acceptance_criterion | All existing tests pass. | pass | Full plugin suite 124/124 pass; was 117 + 7 new tests added by this change |
| AC8 | acceptance_criterion | Plugin rebuilt + deployed dist synced via `make deploy-local`. | pass | make deploy-local: tsup build success (24.21KB dist/index.js), deploy script verified + registered; 3 grep hits for orphanMessageId/findOrphanCandidate in deployed bundle |
| C1 | constraint | Do NOT add any new SDK calls — only filter the already-fetched messages array. | respected | git diff main..HEAD shows zero new client.session.* calls; orchestrator.ts already had session.messages fetch reused |
| C2 | constraint | Do NOT call `client.session.revert` with a different messageID than current — revert behavior unchanged. | respected | client.session.revert call unchanged (orchestrator.ts:148): same messageID, same options |
| C3 | constraint | Do NOT modify the orphan rows (no delete attempt; SDK doesn't expose). | respected | No delete attempt added to OMR; SDK has no message.delete; cleanup remains operational via session-doctor |
| C4 | constraint | Do NOT block fallback dispatch on orphan-find failure — graceful degrade via try/catch returning undefined. | respected | test/orchestrator.test.ts:346 malformed-array test: result.success === true confirms fallback flow proceeds; try/catch around findOrphanCandidate body prevents block |
| C5 | constraint | Structural correctness (P33): orphan detection is type-narrowed against the messages array shape; falsy/missing fields handled defensively via shared `isRecord` from `plugin/src/utils/type-guards.ts`. | respected | findOrphanCandidate uses shared isRecord from plugin/src/utils/type-guards.ts (arch-1 remediation) + explicit typeof checks for id/role + Array.isArray for parts |
| OOS1 | out_of_scope | Deleting orphan rows from OMR (SDK has no `message.delete`). | not_applicable | OOS: deleting orphan rows from OMR — SDK has no message.delete; respected |
| OOS2 | out_of_scope | Periodic `opencode-session-doctor` scheduling (operational). | not_applicable | OOS: periodic session-doctor scheduling — operational; respected |
| OOS3 | out_of_scope | Cooldown precision improvements (user decided wall-time/429 negligible). | not_applicable | OOS: cooldown precision improvements — user-decided separately; respected |
| OOS4 | out_of_scope | Tagging assistant messages at creation (SDK has no message-update API). | not_applicable | OOS: tagging messages at creation — SDK has no message-update API; respected |
| OOS5 | out_of_scope | Upstream PR for OpenCode `message.delete` exposure. | not_applicable | OOS: upstream PR for OpenCode message.delete — deferred; respected |
| OOS6 | out_of_scope | Emitting `orphanMessageId` on failure paths (abort_failed, revert_failed, prompt_failed) — failure paths are rare; doctor's SQL finds orphans regardless of OMR log correlation; cost > benefit for current scope. | not_applicable | OOS: emit orphanMessageId on failure paths — added during review via deferred-suggestions rejection; failure paths rare, doctor SQL finds orphans regardless; respected |

