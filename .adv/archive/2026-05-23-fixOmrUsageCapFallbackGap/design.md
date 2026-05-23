# Design

## Discovery findings (root cause)

Investigation of OpenCode source (sst/opencode @ commit 7fe7b9f) confirms two independent bugs in OMR. Both must be fixed for the user-reported symptom to disappear. Validated independently by adv-researcher (verdict: APPROVE).

### Bug A — schema mismatch on `session.error` payload

OpenCode plugin SDK types `session.error.properties.error` as a union:
`ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError`.

All variants share the shape (from `@opencode-ai/sdk/dist/gen/types.gen.d.ts` and `packages/opencode/src/session/message-v2.ts:41-58`):
```ts
{ name: "<ErrorName>", data: { message, statusCode?, isRetryable, responseHeaders?, responseBody?, ... } }
```

OMR's `SessionErrorLike` (`plugin/src/detection/classifier.ts:10`) expects FLAT fields:
```ts
{ providerID?, statusCode?, name?, message? }
```

So for every real `session.error` event:
- `err.name` is read correctly ("APIError", "ProviderAuthError", …)
- `err.statusCode` is `undefined` (actual value at `err.data.statusCode`)
- `err.message` is `undefined` (actual value at `err.data.message`)

Result: classifier returns `"unknown"` for almost every typed error. The existing tests use the flat shape and so do not catch this — they are a test-API fiction with no production caller.

### Bug B — pattern coverage + structural-signal gap on `session.status` retry

`session.status.properties.status` shape (from `packages/opencode/src/session/status.ts:8-30`):
```ts
{ type: "idle" | "busy" | "retry",
  // when type === "retry":
  attempt, message,
  action?: { reason: "free_tier_limit" | "account_rate_limit" | (string & {}),
             provider, title, message, label, link? },
  next }
```

When the user hits a Go / free-tier / Zen usage cap, OpenCode's `retryable()` (`packages/opencode/src/session/retry.ts:67-150`) emits the retry message:
> "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/.../go"

with `action: { reason: "account_rate_limit", provider: "opencode-go", ... }`.

OMR's `handleEvent` (`plugin/src/plugin-internal.ts:241`) reads only `props.status?.message`, ignoring the typed `action.reason` field entirely. The message text matches no current pattern → `classifyRetryStatusText` returns `null` → handler short-circuits → no fallback fires. This is the user-reported symptom.

## Fix plan

### Fix 1 — read `session.error` payload correctly (Bug A)

Replace `SessionErrorLike` to mirror the real bus shape:
```ts
export interface SessionErrorLike {
  name?: string;
  data?: {
    providerID?: string;
    message?: string;
    statusCode?: number;
    isRetryable?: boolean;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    metadata?: Record<string, string>;
  };
}
```

Per adv-researcher recommendation (option B), do NOT preserve flat-shape back-compat — those fields never existed on real payloads. Rewrite existing tests to use the real `{name, data:{...}}` shape. Cleaner per P19 and aligned with P33.

`classifySessionError` precedence: `name` → `data.statusCode` → `data.message` → `data.responseBody` (JSON-scan through retryPatterns to catch `insufficient_quota`, `GoUsageLimitError`, `FreeUsageLimitError` substrings) → `"unknown"`.

### Fix 2 — structural action.reason + expanded patterns (Bug B)

In `handleEvent` `session.status` case (`plugin-internal.ts:241`):

1. **First** — if `props.status?.type === "retry"` and `props.status.action?.reason` is present, map structurally (P33):
   - `"account_rate_limit"` → `"rate_limit"`
   - `"free_tier_limit"` → `"quota_exhausted"`
   - other (open-ended `(string & {})`) → fall through to text patterns
2. **Then** — `classifyRetryStatusText(props.status?.message)` as today.

Add patterns to `retryPatterns[]` in `patterns.ts`, **inserted before** the generic `\bretrying\b` last-resort entry, grouped under the "Quota exhaustion" section (P04 locality):
- `/\busage[ _-]?(limit|cap|maxed|exceeded)\b/` → `"quota_exhausted"`
- `/\busage limit reached\b/` → `"quota_exhausted"` (explicit OpenCode Go phrasing)
- `/\binsufficient[_-]?quota\b/` → `"quota_exhausted"`
- `/\bfree[_ ]?usage[_ ]?(exceeded|exhausted)\b/` → `"quota_exhausted"` (matches GO_UPSELL_MESSAGE)

### Fix 3 — tests reflecting real shapes

Rewrite `plugin/test/detection.test.ts` and `plugin/test/plugin.test.ts`:

- `classifySessionError({ name: "APIError", data: { statusCode: 429, message: "Quota exceeded..." } })` → `"rate_limit"` (statusCode precedence over message)
- `classifySessionError({ name: "APIError", data: { message: "Quota exceeded.", isRetryable: false, responseBody: '{"error":{"code":"insufficient_quota"}}' } })` → `"quota_exhausted"` (responseBody scan)
- `classifySessionError({ name: "APIError", data: {} })` → `"unknown"`
- `handleEvent` session.status retry with `action.reason: "account_rate_limit"` → fallback fires with `reason: "rate_limit"`, no reliance on message text
- `handleEvent` session.status retry with `action.reason: "free_tier_limit"` → fallback fires with `reason: "quota_exhausted"`
- `handleEvent` session.status retry with unrecognized reason + matching usage-limit text → fallback fires via text-pattern fallback
- `classifyRetryStatusText("5 hour usage limit reached...")` → `"quota_exhausted"`
- `classifyRetryStatusText("Free usage exceeded, subscribe to Go")` → `"quota_exhausted"`

Update existing session.error test fixtures from flat `{statusCode: 429}` to nested `{name: "APIError", data: {statusCode: 429, isRetryable: false}}`.

### Files touched

- `plugin/src/detection/patterns.ts` — add 4 patterns (insertion order matters)
- `plugin/src/detection/classifier.ts` — rewrite `SessionErrorLike`; read from `data`; add responseBody JSON scan
- `plugin/src/plugin-internal.ts` — session.status case: read `action.reason` first
- `plugin/test/detection.test.ts` — rewrite to real shapes + add new pattern tests
- `plugin/test/plugin.test.ts` — rewrite session.error fixture shapes + add action.reason tests

### Out of scope (confirmed)

- Streaming chat-text scanning — not needed; both error paths reached.
- OpenCode upstream changes — not needed.
- Backoff/retry logic — not needed (OMR is router, not retry engine).
- ContextOverflowError handling — separately not retryable per OpenCode retry.ts:69; out of scope.

## Rebuild / deploy

After source edits:
```
cd /home/jon/.local/share/opencode/worktree/.../change/fixOmrUsageCapFallbackGap/plugin
bun run build && bun test
# then sync deployed plugin at ~/.local/share/opencode-model-routing/plugin/dist
```
Sync step + verification of the deployed dist will be a planning task.
