# Design

## Investigation findings

OpenCode `session.revert` source (`packages/opencode/src/session/revert.ts:40-87`):
- Walks messages from `messageID` onward
- Sets `session.revert` pointer (visibility flag)
- Does NOT delete from `message` table

OpenCode SDK surface check (`@opencode-ai/sdk@1.15.5/dist/gen/sdk.gen.d.ts`):
- `session.delete` exists (whole session)
- `session.message` (read single message) exists
- `session.messages` (read all) exists
- **NO `message.delete` or `message.update`** — confirmed by full SDK surface grep

OMR's current `attemptFallback` (`orchestrator.ts:125-127`) already fetches the full messages array to find `lastUser`. The orphan candidate is in this same array — no additional SDK call needed.

## Fix plan

### Find the orphan candidate

After `lastUser` is identified, walk the same array for an assistant message after `lastUser` with empty/missing parts. Wrap in try/catch.

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
      const parts = Array.isArray(item.parts)
        ? item.parts
        : Array.isArray(info.parts) ? info.parts : [];
      if (!sawLastUser) {
        if (id === lastUserMessageID) sawLastUser = true;
        continue;
      }
      if (role === "assistant" && parts.length === 0 && id) {
        candidate = id; // latest wins (highest index)
      }
    }
    return candidate;
  } catch {
    return undefined;
  }
}
```

### Wire into `fallback.success` log

In `attemptFallback`, BEFORE the abort/revert/prompt sequence (capture pre-revert array state), but emit at success:

```ts
const orphanId = findOrphanCandidate(messages, lastUser.messageID);
// ... existing abort/revert/prompt ...
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

Compute `orphanId` BEFORE abort (revert may alter visibility/ordering on subsequent fetches; the array we already have is the pre-abort snapshot). No re-fetch.

### Test coverage (6 new tests)

In `plugin/test/orchestrator.test.ts`:

1. **Orphan present**: `[user-msg-1, assistant-msg-orphan-empty-parts]` → log includes `orphan_message_id`
2. **No orphan (LLM completed)**: `[user-msg-1, assistant-msg-with-parts]` → field omitted
3. **Multiple assistants after user**: latest empty-parts wins
4. **Malformed messages array**: passes non-record items → try/catch swallows; field omitted
5. **Assistant before user (out-of-order)**: should NOT match (only walks after sawLastUser)
6. **Empty messages array**: no orphan, field omitted

Plus verify all existing orchestrator tests still pass — `fallback.success` new field is optional/additive.

### Files touched

- `plugin/src/replay/orchestrator.ts` — add `findOrphanCandidate` helper; wire into success log
- `plugin/test/orchestrator.test.ts` — add 6 new tests

### Files NOT touched

- `client.session.revert` call unchanged
- `client.session.messages` call unchanged (reuse existing fetch)
- `client.session.abort/prompt` calls unchanged
- No new SDK methods, no new dependencies
- No spec deltas (this is pure log enrichment)

## Rebuild / deploy

```
make deploy-local
# Restart OpenCode
# Trigger fallback → grep log for "orphan_message_id" → verify matches DB SQL
```

Operator workflow (documented in completion notes):
```bash
# Find OMR-logged orphans
grep '"event":"fallback.success"' ~/.local/share/opencode/log/*.log \
  | grep orphan_message_id

# Cross-reference with session-doctor SQL (canonical detector)
opencode-session-doctor --dry-run
opencode-session-doctor --apply --backup-dir /tmp/opencode/session-doctor-backup
```

## Risk

| Risk | Mitigation |
|---|---|
| Wrong messageID logged → confusion | Doctor uses SQL shape, not OMR log IDs; false-positive in log doesn't cause data loss |
| Orphan-find throws | try/catch returns undefined; field omitted; existing fallback behavior preserved |
| Message-array shape differs across OpenCode versions | Defensive `isRecord` + `typeof` checks; no hard schema assumptions |
| Performance regression | Zero — same array, one extra filter pass |
| Field naming collision | `orphan_message_id` is new and unique; no existing log consumer |
