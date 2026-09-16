// Classifier: turns raw failure signals into ErrorCategory values.
//
// Two entry points:
//   - classifySessionError: typed session.error payload (real OpenCode shape
//     is {name, data:{...}} per @opencode-ai/sdk EventSessionError union).
//   - classifyRetryStatusText: free-form session.status text payload.

import type { ErrorCategory } from "../types.ts";
import { retryPatterns } from "./patterns.ts";

/**
 * Inner `data` block on a NamedError-shaped session.error payload. Mirrors
 * the SDK union members' data fields — APIError exposes all of these;
 * ProviderAuthError only `providerID` + `message`; others a subset. Kept
 * permissive (all optional) so a single shape covers the union safely.
 * Imported by plugin-internal.ts EventInputShape to keep the SDK contract
 * defined in exactly one place.
 */
export interface SessionErrorData {
  providerID?: string;
  message?: string;
  statusCode?: number;
  isRetryable?: boolean;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  metadata?: Record<string, string>;
}

/**
 * Real OpenCode `session.error.properties.error` payload shape. Variants in
 * the SDK union (ApiError, ProviderAuthError, MessageAbortedError,
 * MessageOutputLengthError, UnknownError, etc.) all share `{name, data:{...}}`
 * via NamedError.toObject() — see packages/opencode/src/session/message-v2.ts
 * APIError schema and packages/core/src/util/error.ts NamedError.create().
 */
export interface SessionErrorLike {
  name?: string;
  data?: SessionErrorData;
}

/**
 * Map a typed session.error payload to an ErrorCategory.
 * Precedence: non-retryable user abort → name → data.statusCode →
 * data.message → data.responseBody scan → unknown.
 *
 * Status codes 403 and 429 are the ambiguous ones:
 *   - 403: Kimi returns it for billing-cycle quota exhaustion ("You've
 *     reached your usage limit for this billing cycle") while most providers
 *     use it for auth/forbidden. Scan the message and responseBody for quota
 *     signals first; if none match, fall through to auth_error.
 *   - 429: providers use it both for transient rate limiting and for
 *     plan/quota exhaustion. OpenAI plan exhaustion arrives as 429 "The
 *     usage limit has been reached". Scan the message and responseBody for
 *     quota signals first; if none match, fall through to rate_limit.
 * On both codes only quota_exhausted short-circuits; everything else keeps
 * the status code's direct mapping.
 */
// Quota wordings that mark plan exhaustion rather than a transient rate
// limit or an auth failure. Shared by the 403 and 429 branches: both status
// codes are ambiguous between their default semantics and quota exhaustion,
// and both resolve the ambiguity the same way — scan the message for these
// signals, then the responseBody through the retry patterns.
const quotaMessageSignals = [
  "usage limit",
  "quota",
  "billing cycle",
  "fully used up",
  "spending limit",
] as const;

function hasQuotaSignal(lowerCasedText: string): boolean {
  return quotaMessageSignals.some((signal) =>
    lowerCasedText.includes(signal),
  );
}

export function classifySessionError(
  err: SessionErrorLike,
): ErrorCategory | null {
  const name = (err.name ?? "").toLowerCase();
  // User-initiated ESC/cancel arrives from OpenCode as MessageAbortedError
  // (AbortedError in message-v2.ts). It is a terminal user action, not a model
  // failure, so fallback rotation must not fire.
  if (name.includes("messageabortederror") || name.includes("aborterror")) {
    return null;
  }
  if (name.includes("modelnotfound") || name.includes("model_not_found")) {
    return "unknown_model";
  }
  if (name.includes("quota")) {
    return "quota_exhausted";
  }
  if (name.includes("auth") || name.includes("unauthor")) {
    return "auth_error";
  }

  const data = err.data ?? {};
  const code = data.statusCode ?? 0;
  // HTTP 429 is ambiguous: providers use it both for transient rate limiting
  // and for plan/quota exhaustion (OpenAI plan exhaustion is 429 "The usage
  // limit has been reached" — the usage-limit→quota mapping otherwise lives
  // only in the 403 branch below and in classifyRetryStatusText). Scan the
  // message and responseBody for quota signals before the bare-429 return.
  // Only quota_exhausted short-circuits here — everything else keeps the
  // rate_limit classification.
  if (code === 429) {
    const msg429 = (data.message ?? "").toLowerCase();
    if (hasQuotaSignal(msg429)) return "quota_exhausted";
    const body429 = data.responseBody;
    if (typeof body429 === "string" && body429.length > 0) {
      if (classifyRetryStatusText(body429) === "quota_exhausted") {
        return "quota_exhausted";
      }
    }
    return "rate_limit";
  }
  if (code === 401) return "auth_error";
  // HTTP 403 is ambiguous: Kimi's billing-cycle quota exhaustion returns 403
  // with a message containing "usage limit" / "quota" / "billing cycle"
  // (see kimi.com/code/docs/en/kimi-code/error-reference.html). Scan the
  // message and responseBody for quota signals before falling back to the
  // default auth_error classification. Only quota_exhausted short-circuits
  // here — rate_limit and other categories still fall through to the
  // responseBody scan at the bottom of this function.
  if (code === 403) {
    if (hasQuotaSignal((data.message ?? "").toLowerCase())) {
      return "quota_exhausted";
    }
    const body403 = data.responseBody;
    if (typeof body403 === "string" && body403.length > 0) {
      const bodyClass = classifyRetryStatusText(body403);
      if (bodyClass === "quota_exhausted") return "quota_exhausted";
    }
    return "auth_error";
  }
  if (code >= 500 && code < 600) return "server_error";
  if (code === 404 && name.includes("model")) return "unknown_model";

  const msg = (data.message ?? "").toLowerCase();
  if (
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("too many requests")
  ) {
    return "rate_limit";
  }
  if (msg.includes("quota")) {
    return "quota_exhausted";
  }

  // Scan the message through retryPatterns — catches "usage limit reached",
  // "billing cycle", "fully used up", and other patterns the hardcoded checks
  // above miss. Mirrors the responseBody-scan coverage below, ensuring the
  // message field gets the same pattern coverage as the response body.
  const msgClass = classifyRetryStatusText(data.message);
  if (msgClass) return msgClass;

  // Final fallback: scan responseBody text through retryPatterns. Catches
  // OpenAI insufficient_quota JSON, GoUsageLimitError / FreeUsageLimitError
  // substrings, and other provider-specific error bodies that don't surface
  // through the typed message field. Defensive typeof check: shape narrowing
  // only validates `data` is a Record, not that responseBody is a string.
  const body = data.responseBody;
  if (typeof body === "string" && body.length > 0) {
    const bodyClass = classifyRetryStatusText(body);
    if (bodyClass) return bodyClass;
  }

  return "unknown";
}

/**
 * Map session.status retry text to an ErrorCategory. Returns null when no
 * pattern matches — callers should treat null as "do not trigger fallback".
 */
export function classifyRetryStatusText(
  text: string | null | undefined,
): ErrorCategory | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const pat of retryPatterns) {
    if (pat.re.test(lower)) return pat.category;
  }
  return null;
}
