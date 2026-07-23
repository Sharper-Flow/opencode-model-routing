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
 * Status-code 403 is the one ambiguous code: Kimi returns it for billing-cycle
 * quota exhaustion ("You've reached your usage limit for this billing cycle")
 * while most providers use it for auth/forbidden. For 403 only, scan the
 * message and responseBody for quota signals first; if none match, fall
 * through to auth_error. Other status codes keep their direct mapping.
 */
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
  if (code === 429) return "rate_limit";
  if (code === 401) return "auth_error";
  // HTTP 403 is ambiguous: Kimi's billing-cycle quota exhaustion returns 403
  // with a message containing "usage limit" / "quota" / "billing cycle"
  // (see kimi.com/code/docs/en/kimi-code/error-reference.html). Scan the
  // message and responseBody for quota signals before falling back to the
  // default auth_error classification. Only quota_exhausted short-circuits
  // here — rate_limit and other categories still fall through to the
  // responseBody scan at the bottom of this function.
  if (code === 403) {
    const msg403 = (data.message ?? "").toLowerCase();
    if (
      msg403.includes("usage limit") ||
      msg403.includes("quota") ||
      msg403.includes("billing cycle") ||
      msg403.includes("fully used up") ||
      msg403.includes("spending limit")
    ) {
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
