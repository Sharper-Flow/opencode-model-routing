// Classifier: turns raw failure signals into ErrorCategory values.
//
// Two entry points:
//   - classifySessionError: typed session.error payload (real OpenCode shape
//     is {name, data:{...}} per @opencode-ai/sdk EventSessionError union).
//   - classifyRetryStatusText: free-form session.status text payload.

import type { ErrorCategory } from "../types.ts";
import { retryPatterns } from "./patterns.ts";

/**
 * Real OpenCode `session.error.properties.error` payload shape. Variants in
 * the SDK union (ApiError, ProviderAuthError, MessageAbortedError,
 * MessageOutputLengthError, UnknownError, etc.) all share `{name, data:{...}}`
 * via NamedError.toObject() — see packages/opencode/src/session/message-v2.ts
 * APIError schema and packages/core/src/util/error.ts NamedError.create().
 */
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

/**
 * Map a typed session.error payload to an ErrorCategory.
 * Precedence: name → data.statusCode → data.message → data.responseBody scan → unknown.
 */
export function classifySessionError(err: SessionErrorLike): ErrorCategory {
  const name = (err.name ?? "").toLowerCase();
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
  if (code === 401 || code === 403) return "auth_error";
  if (code >= 500 && code < 600) return "server_error";
  if (code === 404 && name.includes("model")) return "unknown_model";

  const msg = (data.message ?? "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("rate-limit") || msg.includes("too many requests")) {
    return "rate_limit";
  }
  if (msg.includes("quota")) {
    return "quota_exhausted";
  }

  // Final fallback: scan responseBody text through retryPatterns. Catches
  // OpenAI insufficient_quota JSON, GoUsageLimitError / FreeUsageLimitError
  // substrings, and other provider-specific error bodies that don't surface
  // through the typed message field.
  const body = data.responseBody;
  if (body) {
    const bodyClass = classifyRetryStatusText(body);
    if (bodyClass) return bodyClass;
  }

  return "unknown";
}

/**
 * Map session.status retry text to an ErrorCategory. Returns null when no
 * pattern matches — callers should treat null as "do not trigger fallback".
 */
export function classifyRetryStatusText(text: string | null | undefined): ErrorCategory | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const pat of retryPatterns) {
    if (pat.re.test(lower)) return pat.category;
  }
  return null;
}
