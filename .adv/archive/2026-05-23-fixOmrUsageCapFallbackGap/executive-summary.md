# Executive Summary

## Outcome
OMR now triggers fallback on OpenAI/ChatGPT-Pro usage-cap 429s and OpenCode Go/free-tier retries. Two structural bugs fixed: classifier read flat error fields when OpenCode emits nested `{name, data:{...}}` (per `@opencode-ai/sdk` `EventSessionError` union), and `session.status` retry handler ignored the typed `action.reason` field (only scanned message text).

## Verdict
APPROVED

## What Was Built
1. **classifier.ts rewrite** — `SessionErrorLike` redefined to mirror real bus shape `{name, data:{...}}`; `classifySessionError` reads `data.statusCode`/`message`/`responseBody` with retry-pattern scan on `responseBody` as a defensive fallback. `SessionErrorData` extracted as a shared exported type (consumed by `EventInputShape` in plugin-internal.ts) so the SDK contract lives in exactly one place.
2. **patterns.ts** — 4 new patterns under "Quota exhaustion" inserted above `\bretrying\b` last-resort: literal `insufficient_quota`, "usage limit reached", generic `usage[ _-]?(limit|cap|maxed|exceeded)s?(?![a-z])` (trailing lookahead replaces `\b` because `_` is a word char and breaks `\b` on snake-case `usage_limit_reached`), and `free[_ ]?usage[_ ]?(exceeded|exhausted)`.
3. **plugin-internal.ts** — `handleEvent` `session.status` case reads typed `status.action.reason` structurally first per P33: `account_rate_limit→rate_limit`, `free_tier_limit→quota_exhausted`; unknown/future reasons fall through to text-pattern classification. `EventInputShape` + `isEventInputShape` extended for nested error + status.action narrowing.
4. **Test migration** — 14 flat-shape fixtures across `detection.test.ts` + `plugin.test.ts` rewritten to real nested SDK shape (the legacy flat shape never occurred in production). Verbatim regression tests added from real user-session log strings: `"The usage limit has been reached"` and ChatGPT-Pro `{"type":"usage_limit_reached"}`.
5. **Build + deploy** — `bun run build` succeeded; `~/.local/share/opencode-model-routing/plugin/dist/` synced and diff-verified.

## What Was Verified
- **Verdict:** APPROVED with 11 findings (0 blockers, 1 issue, 7 suggestions, 3 nits, 17 praise) — 1 issue + 4 quick wins remediated inline; 3 suggestions deferred to harden.
- **Tests:** 110/110 plugin tests pass; Go suite (`cmd/omr`, `internal/config`, `internal/tui`) pass; `tsc --noEmit` clean; `schema-contract-check.sh` PASS.
- **Investment:** 5 tasks (4 done, 1 cancelled-as-absorbed) / 0 retries / ~60 min wall / tier: auto.
- **Contract matrix:** 19 required rows — 8 AC pass, 6 constraints respected, 5 out-of-scope not_applicable; 0 failures.

## Remaining Concerns
- OMR's stderr is not captured in OpenCode's log file. We could not directly observe whether OMR's old handler fired during the user's incident. If fallback still doesn't trigger in production after this fix, suspect agent-name/chain resolution path (`resolveAgentName` returning null → empty chain → early "no chain" return in `attemptFallback`) — separate from this fix's scope.
- 3 deferred suggestions for `/adv-harden`: (a) extract `REASON_TO_CATEGORY` map for `action.reason` locality, (b) extract `isActionShape` helper from `isEventInputShape` complexity, (c) consider merging the two `insufficient_quota` patterns.
