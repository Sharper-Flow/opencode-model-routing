# Agreement

## Objectives

1. OMR logs the orphan message ID at fallback time so log files can be correlated with `opencode-session-doctor`'s blank-row detection.
2. Detection is defensive: graceful degradation (omit field) when no orphan found or shape unexpected — never fabricate, never break fallback.
3. No new SDK calls — reuse the existing `client.session.messages()` fetch from `attemptFallback`.

## Acceptance criteria

- `fallback.success` log event includes `orphanMessageId: string` field (camelCase per codebase convention) when the messages-after-lastUser walk identifies an assistant message with empty parts.
- `orphanMessageId` field is omitted (not set to `null`, not `undefined`, not empty string) when no orphan is detected.
- `orphanMessageId` field is omitted when the orphan-find logic throws — the catch must not block the fallback dispatch.
- The orphan-find logic walks messages with index > lastUser-index, filters to `role === "assistant"` with `parts.length === 0`, picks the most-recent (highest index).
- Existing `fallback.success` fields (`sessionId`, `from`, `to`, `reason`, `depth`) unchanged.
- New test fixtures cover: orphan present (flat shape), nested OpenCode shape `{info: {id, role}, parts}`, no orphan (LLM completed normally), assistant message with parts (not an orphan), malformed messages array, assistant-before-user (no false match), empty messages array.
- All existing tests pass.
- Plugin rebuilt + deployed dist synced via `make deploy-local`.

## Constraints

- Do NOT add any new SDK calls — only filter the already-fetched messages array.
- Do NOT call `client.session.revert` with a different messageID than current — revert behavior unchanged.
- Do NOT modify the orphan rows (no delete attempt; SDK doesn't expose).
- Do NOT block fallback dispatch on orphan-find failure — graceful degrade via try/catch returning undefined.
- Structural correctness (P33): orphan detection is type-narrowed against the messages array shape; falsy/missing fields handled defensively via shared `isRecord` from `plugin/src/utils/type-guards.ts`.

## Out of scope

- Deleting orphan rows from OMR (SDK has no `message.delete`).
- Periodic `opencode-session-doctor` scheduling (operational).
- Cooldown precision improvements (user decided wall-time/429 negligible).
- Tagging assistant messages at creation (SDK has no message-update API).
- Upstream PR for OpenCode `message.delete` exposure.
- Emitting `orphanMessageId` on failure paths (abort_failed, revert_failed, prompt_failed) — failure paths are rare; doctor's SQL finds orphans regardless of OMR log correlation; cost > benefit for current scope.
