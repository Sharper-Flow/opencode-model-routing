# Proposal: Add OMR orphan message logging

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
- Cooldown changes (user decided wall-time/429 cost negligible)
- Tagging the message at creation time (SDK doesn't expose message update API)
- Upstream PR for OpenCode `message.delete` API (defer; tracked elsewhere)
