# Proposal: Fix OMR usage cap fallback gap

## Problem
OMR (opencode-model-routing) does not trigger model fallback when OpenAI returns a usage cap / insufficient_quota error (HTTP 429 with `code: "insufficient_quota"`). The user sees a warning ("usage is maxed out") in chat but OMR never rotates to the next model in the fallback chain.

## Root cause (preliminary)
Two potential gaps:
1. **Pattern gap**: OMR's `retryPatterns` and `classifySessionError` match `rate limit`, `429`, `quota exhaust` etc. but do not match "usage maxed", "usage cap", "usage limit reached", or "insufficient_quota" language.
2. **Event delivery gap**: OpenCode may surface insufficient_quota as a chat text warning rather than emitting a `session.error` event with the proper error object. If no `session.error` or `session.status` event fires, OMR's event handler never runs.

## Direction
- Add missing patterns for usage cap / insufficient_quota language to both `retryPatterns` and `classifySessionError`.
- Investigate whether OpenCode emits `session.error` for insufficient_quota 429s at all.
- If the event delivery gap is real, add a fallback detection path (e.g., scan streaming text for known error patterns) or document the upstream limitation.

## Success Criteria
- A real OpenAI insufficient_quota 429 (reproduced or captured response body) triggers OMR fallback to the next model in the chain in a live OpenCode session.
- Pattern matchers classify representative usage-cap strings as `quota_exhausted` in unit/integration test or scripted verification.
- No regression on existing `rate_limit` / `quota_exhausted` classifications.
- If event-delivery gap is real, the chosen mitigation (text-scan path or documented upstream limitation) is implemented and verified.

## Scope
- Plugin source at `~/.local/share/opencode-model-routing/plugin/` (deployed artifact)
- Dev source in `~/dev/opencode-model-routing/` if available
- Pattern fixes in `src/detection/patterns.ts` and `src/detection/classifier.ts`

## Out of scope
- Fixing OpenCode's event emission behavior (upstream)
- Adding exponential backoff (OMR is a fallback router, not a retry engine)
- Changing the adv agent model order (workaround, not fix)
