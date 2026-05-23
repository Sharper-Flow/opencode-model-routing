# Agreement

## Objectives

1. OMR triggers fallback on OpenCode Go / free-tier / Zen "Usage limit reached" retries (session.status type=retry with `action.reason`).
2. OMR correctly classifies raw provider `session.error` events (OpenAI insufficient_quota, generic ApiError) by reading the actual `{name, data:{...}}` payload shape OpenCode emits.
3. No regression on existing classifications.
4. Test fixtures use the real OpenCode plugin SDK payload shapes; legacy flat-error fixtures are removed.

## Acceptance criteria

- `classifySessionError({ name: "APIError", data: { statusCode: 429, message: "Quota exceeded..." } })` returns `"rate_limit"`.
- `classifySessionError({ name: "APIError", data: { message: "Quota exceeded.", isRetryable: false, responseBody: '{"error":{"code":"insufficient_quota"}}' } })` returns `"quota_exhausted"`.
- `handleEvent` on `session.status` retry with `action.reason: "account_rate_limit"` triggers fallback with `reason: "rate_limit"` — no reliance on message text.
- `handleEvent` on `session.status` retry with `action.reason: "free_tier_limit"` triggers fallback with `reason: "quota_exhausted"`.
- `classifyRetryStatusText("5 hour usage limit reached. It will reset in 5 hours 23 minutes...")` returns `"quota_exhausted"` (pattern fallback).
- `classifyRetryStatusText("Free usage exceeded, subscribe to Go")` returns `"quota_exhausted"`.
- All other existing classifications in `plugin/test/detection.test.ts` still pass after fixture migration to real shapes.
- Plugin rebuilt (`bun run build`) + full test suite green; deployed plugin at `~/.local/share/opencode-model-routing/plugin/dist/` updated to match.

## Constraints

- Do NOT modify OpenCode core / upstream event emission.
- Do NOT add streaming chat-text scanning — confirmed unnecessary.
- Do NOT add retry/backoff logic to OMR.
- Keep patterns anchored (use `\b` word boundaries) to avoid false positives.
- Structural classification (action.reason) MUST take precedence over text patterns (P33).
- New patterns inserted before the `\bretrying\b` last-resort entry in retryPatterns[].

## Out of scope

- Fixing OpenCode upstream event emission.
- Adding retry/backoff to OMR.
- Changing agent model configurations.
- Adding new providers or chain features.
- ContextOverflowError handling (OpenCode marks it non-retryable; fallback doesn't help).
