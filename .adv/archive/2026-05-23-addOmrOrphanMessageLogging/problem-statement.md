After OMR triggers fallback (parent change), it calls `client.session.revert({sessionID, messageID: lastUser.messageID})`. Verified via OpenCode source (`packages/opencode/src/session/revert.ts:40-87`): `revert` is a SOFT revert — sets `session.revert` pointer to hide rows from active session view but does NOT delete the message rows from DB. The blank assistant message shell (created by OpenCode before the LLM call failed) persists permanently.

Result: every fallback cycle leaves one blank assistant row in the DB. Per ~70h ChatGPT Pro cap window, with current 5-min cooldown and heavy use, ~840 blank rows accumulate. The OpenCode SDK exposes no `message.delete` API, so OMR cannot clean these itself. External cleanup tool exists (`opencode-session-doctor`) that detects them by SQL shape (`role=assistant AND finish IS NULL AND 0 parts`), but operators have no log signal correlating specific orphan rows to specific fallback events.

User-stated concern (after investigation reduced false concerns):
- 429 cost: zero (no billing, no rate-limit penalty, no account impact)
- Wall time waste: ~1-2s per cycle — negligible
- Blank rows accumulating: the only real problem worth addressing in code</problemStatement>
<parameter name="proposal"># Proposal: Add OMR orphan message logging

## Problem
OMR fallback leaves blank assistant message rows in OpenCode's DB (one per cycle). `session.revert` is a soft revert — hides but doesn't delete. SDK has no `message.delete`. Operators clean via `opencode-session-doctor` but have no log signal correlating fallback events to specific orphan rows.

## Direction
At fallback time, identify the blank assistant message the LLM call left behind (the message after `lastUser` in the messages array, with no parts). Log its ID as `orphan_message_id` on the `fallback.success` event. Operators / forensic tools can grep logs for orphan IDs and correlate with the session-doctor SQL pattern.

Wrap the identification in a try/catch so any unexpected message shape degrades gracefully to the current behavior (no field logged). No new SDK calls — uses the existing `client.session.messages()` fetch already performed in `attemptFallback`.

## Success criteria
- `fallback.success` log event includes `orphan_message_id: string` field when an unfinished assistant message is detected after `lastUser`.
- Field is omitted when no orphan is detected (graceful degradation — no fabricated IDs).
- Field is omitted when the orphan-find logic throws (existing fallback behavior preserved).
- The logged ID matches the SQL-detected orphan row in OpenCode's DB for verified test scenarios.

## Scope
- `plugin/src/replay/orchestrator.ts` — find orphan candidate before abort/revert; pass through to log
- `plugin/test/orchestrator.test.ts` — cover: orphan found, no orphan, find-logic errors

## Out of scope
- Deleting orphan rows from OMR (SDK doesn't expose; doctor handles)
- Periodic doctor scheduling (operational responsibility)
- Cooldown changes (separate discussion; user decided wall-time/429 cost negligible)
- Tagging the message at creation time (SDK doesn't expose message update API)
- Upstream PR for OpenCode `message.delete` API (defer; tracked elsewhere)
</parameter>
<parameter name="agreement"># Agreement

## Objectives

1. OMR logs the orphan message ID at fallback time so log files can be correlated with `opencode-session-doctor`'s blank-row detection.
2. Detection is defensive: graceful degradation (omit field) when no orphan found or shape unexpected — never fabricate, never break fallback.
3. No new SDK calls — reuse the existing `client.session.messages()` fetch from `attemptFallback`.

## Acceptance criteria

- `fallback.success` log event includes `orphan_message_id: string` field when the messages-after-lastUser walk identifies an assistant message with empty parts.
- `orphan_message_id` field is omitted (not set to `null`, not `undefined`, not empty string) when no orphan is detected.
- `orphan_message_id` field is omitted when the orphan-find logic throws — the catch must not block the fallback dispatch.
- The orphan-find logic walks messages with index > lastUser-index, filters to `role === "assistant"` with `parts.length === 0`, picks the most-recent (highest index).
- Existing `fallback.success` fields (`sessionId`, `from`, `to`, `reason`, `depth`) unchanged.
- New test fixtures cover: orphan present, no orphan (LLM completed normally), assistant message with parts (not an orphan), malformed messages array.
- All existing tests pass.
- Plugin rebuilt + deployed dist synced via `make deploy-local`.

## Constraints

- Do NOT add any new SDK calls — only filter the already-fetched messages array.
- Do NOT call `client.session.revert` with a different messageID than current — revert behavior unchanged.
- Do NOT modify the orphan rows (no delete attempt; SDK doesn't expose).
- Do NOT block fallback dispatch on orphan-find failure — graceful degrade.
- Structural correctness (P33): orphan detection is type-narrowed against the messages array shape; falsy/missing fields handled defensively.

## Out of scope

- Deleting orphan rows from OMR (SDK has no `message.delete`).
- Periodic `opencode-session-doctor` scheduling (operational).
- Cooldown precision improvements (user decided wall-time/429 negligible).
- Tagging assistant messages at creation (SDK has no message-update API).
- Upstream PR for OpenCode `message.delete` exposure.
- Adding orphan ID to other log events (`preemptive.redirected`, etc.) — only `fallback.success` for now.
</parameter>
<parameter name="design"># Design

## Investigation findings

Read OpenCode source (`packages/opencode/src/session/revert.ts:40-87`) confirms `session.revert`:
- Walks messages from `messageID` onward
- Sets `session.revert` pointer (visibility flag)
- Does NOT delete from `message` table

Read OpenCode SDK (`@opencode-ai/sdk@1.15.5/dist/gen/sdk.gen.d.ts`):
- `session.delete` exists (whole session)
- `session.message` (read single message) exists
- `session.messages` (read all) exists
- **NO `message.delete` or `message.update`** — confirmed by grep on the full SDK surface

OMR's current `attemptFallback` (`orchestrator.ts:125-127`):
```ts
messages = await client.session.messages({ sessionID: sessionId } as never)
  .catch(async () => client.session.messages({ sessionId } as never));
```
Already fetches the full message array to find `lastUser`. The orphan candidate is in this same array — no additional SDK call needed.

## Fix plan

### Find the orphan candidate

After `lastUser` is identified (existing `findLastUserMessage(messages)`), walk the same array for an assistant message after `lastUser` with empty/missing parts. Wrap in try/catch.

```ts
function findOrphanCandidate(
  messages: unknown[],
  lastUserMessageID: string,
): string | undefined {
  try {
    let sawLastUser = false;
    let candidate: string | undefined;
    for (const item of messages) {
      if (!isRecord(item)) continue;
      const info = isRecord(item.info) ? item.info : item;
      if (!isRecord(info)) continue;
      const id = typeof info.id === "string" ? info.id : undefined;
      const role = typeof info.role === "string" ? info.role : undefined;
      const parts = Array.isArray(item.parts) ? item.parts : Array.isArray(info.parts) ? info.parts : [];
      if (!sawLastUser) {
        if (id === lastUserMessageID) sawLastUser = true;
        continue;
      }
      if (role === "assistant" && parts.length === 0 && id) {
        // Record latest; subsequent assistant messages would overwrite.
        candidate = id;
      }
    }
    return candidate;
  } catch {
    return undefined;
  }
}
```

### Wire into `fallback.success` log

In `attemptFallback`, after success branch (line 170-180):

```ts
const orphanId = findOrphanCandidate(messages, lastUser.messageID);
const logPayload: Record<string, unknown> = {
  sessionId,
  from: current,
  to: next,
  reason,
  depth: state.fallbackDepth,
};
if (orphanId !== undefined) logPayload.orphan_message_id = orphanId;
logger.info("fallback.success", logPayload);
```

Place the orphan-find BEFORE the abort/revert/prompt sequence to capture the array state pre-revert (revert may change visibility/ordering on next fetch). Since we already have `messages` fetched at line 125, no re-fetch.

### Test coverage

In `plugin/test/orchestrator.test.ts` (or new helpers):

1. **Orphan present**: messages = [user-msg-1, assistant-msg-orphan-empty-parts]. Expect log payload includes `orphan_message_id: "assistant-msg-orphan"`.
2. **No orphan (LLM completed)**: messages = [user-msg-1, assistant-msg-with-text-parts]. Expect log payload omits the field.
3. **Multiple assistants after user**: pick the latest empty-parts one.
4. **Malformed messages array**: passes a string/number/null inside. Expect log payload omits the field (try/catch fires).
5. **Assistant before user (out-of-order)**: should NOT match (only walks after sawLastUser).
6. **Empty messages array**: no orphan, field omitted.
7. **Existing `fallback.success` test**: still passes; new field optional.

### Files touched

- `plugin/src/replay/orchestrator.ts` — add `findOrphanCandidate` helper; wire into success log
- `plugin/test/orchestrator.test.ts` — add 6 new tests + verify existing tests still pass

### Files NOT touched

- `client.session.revert` call unchanged
- `client.session.messages` call unchanged
- `client.session.abort/prompt` calls unchanged
- No new SDK methods
- No spec deltas

## Rebuild / deploy

```
make deploy-local
# Restart OpenCode
# Trigger fallback → grep log for "orphan_message_id" → verify matches DB SQL
```

Forensic correlation workflow (post-deploy, documented in completion notes):
```
# Find OMR-logged orphans
grep '"event":"fallback.success"' ~/.local/share/opencode/log/*.log | grep orphan_message_id

# Cross-reference with session-doctor SQL
opencode-session-doctor --dry-run --filter=orphans-only
```

## Risk

| Risk | Mitigation |
|---|---|
| Wrong messageID logged → confusion | Doctor uses SQL shape, not OMR log IDs; false positive in log doesn't cause data loss |
| Orphan-find throws unexpectedly | try/catch returns undefined; field omitted; existing fallback behavior preserved |
| Message-array shape differs across OpenCode versions | Defensive `isRecord` + `typeof` checks; no hard schema assumptions |
| Performance regression | Zero — same array, one extra filter pass |
</parameter>
</invoke>