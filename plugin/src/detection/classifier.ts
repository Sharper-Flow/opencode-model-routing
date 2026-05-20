// Classifier: turns raw failure signals into ErrorCategory values.
//
// Two entry points:
//   - classifySessionError: typed session.error payload (statusCode, name).
//   - classifyRetryStatusText: free-form session.status text payload.

import type { ErrorCategory } from "../types.ts";
import { retryPatterns } from "./patterns.ts";

export interface SessionErrorLike {
  providerID?: string;
  statusCode?: number;
  name?: string;
  message?: string;
}

/**
 * Map a typed session.error payload to an ErrorCategory.
 * Precedence: name → statusCode → message text → unknown.
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

  const code = err.statusCode ?? 0;
  if (code === 429) return "rate_limit";
  if (code === 401 || code === 403) return "auth_error";
  if (code >= 500 && code < 600) return "server_error";
  if (code === 404 && name.includes("model")) return "unknown_model";

  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("rate-limit") || msg.includes("too many requests")) {
    return "rate_limit";
  }
  if (msg.includes("quota")) {
    return "quota_exhausted";
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
