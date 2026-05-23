# Executive Summary

## Outcome
OMR now logs `orphanMessageId` on `fallback.success` events when a blank assistant message is left behind (cannot be deleted via SDK). Operators can grep logs for orphan IDs and correlate with `opencode-session-doctor`'s SQL-based detection for forensic cleanup.

## Verdict
APPROVED

## What Was Built
1. **findOrphanCandidate helper** in `orchestrator.ts` — walks messages array after `lastUserMessageID`, returns latest assistant with empty parts. Supports both flat `{id, role, parts}` and nested `{info: {id, role}, parts}` OpenCode shapes via dual-shape resolution. Defensive: try/catch graceful degrade, isRecord narrowing, typeof checks.
2. **Pre-abort capture** — `orphanMessageId` computed BEFORE `session.abort` to use pre-revert array snapshot (doctor SQL still works post-revert, but pre-abort capture avoids any future visibility surprises).
3. **Conditional payload merge** — `orphanMessageId` attached to `fallback.success` log only when detected (omitted otherwise; never fabricated; never null).
4. **Shared isRecord** — extracted to `plugin/src/utils/type-guards.ts` (arch-1 DRY remediation); consumed by orchestrator.ts and plugin-internal.ts.
5. **Field naming** — `orphanMessageId` (camelCase) matches existing `fallback.success` keys (sessionId, from, to, reason, depth) per repo convention.

## What Was Verified
- **Verdict:** APPROVED with 11 findings (0 blockers, 3 issues, 5 suggestions, 3 nits, 12 praise) — 3 issues + 2 suggestions remediated; 1 design-suggestion rejected with evidence (emit-on-failure-paths costs > benefits given doctor SQL coverage); 1 pre-existing-bug nit out-of-scope.
- **Tests:** 124/124 plugin tests pass; tsc clean; `make deploy-local` success; 3 grep hits for orphanMessageId/findOrphanCandidate in deployed bundle confirm code shipped.
- **Investment:** 2 tasks (2 done, 0 cancelled) / 0 retries / ~18 min wall / tier: auto.
- **Contract matrix:** 19/19 required rows — 8 AC pass, 5 constraints respected, 6 out-of-scope not_applicable; 0 failures.

## Remaining Concerns
- **Operator workflow**: after restart, periodically run `opencode-session-doctor --dry-run` then `--apply --backup-dir /tmp/opencode/session-doctor-backup` to clean orphans. Log correlation: `grep '"orphanMessageId"' ~/.local/share/opencode/log/*.log`.
- **Failure path coverage**: orphan ID not emitted when abort/revert/prompt fails. Doctor SQL still finds these orphans (relies on row shape, not OMR logs). If failure correlation becomes important later, add separate `orphan.detected` event in fast-follow.
