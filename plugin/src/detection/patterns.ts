// Retry/error text patterns for session.status message classification.
//
// OpenCode's `session.status` events sometimes emit retry messages that bypass
// the typed `session.error` channel. The reference Smart-Coders-HQ plugin
// (Apache-2.0) scans these text payloads against a small dictionary of
// vendor-agnostic retry hints; we adopt the same approach.
//
// Patterns are case-insensitive substring or regex matches; classifier.ts
// folds them into ErrorCategory values.

import type { ErrorCategory } from "../types.ts";

interface Pattern {
  // RegExp to match against the lower-cased text payload.
  re: RegExp;
  category: ErrorCategory;
}

export const retryPatterns: Pattern[] = [
  // Rate-limit family
  { re: /\brate[ -]?limit/, category: "rate_limit" },
  { re: /\btoo many requests\b/, category: "rate_limit" },
  { re: /\b429\b/, category: "rate_limit" },

  // Quota exhaustion
  { re: /\bquota.*(exhaust|exceed)/, category: "quota_exhausted" },
  { re: /\binsufficient.+(credit|quota)/, category: "quota_exhausted" },
  // OpenAI literal error code. The previous \binsufficient.+(credit|quota)
  // pattern already matches the underscore/hyphen forms via .+, but the
  // no-separator form 'insufficientquota' is only caught here.
  { re: /\binsufficient[_-]?quota\b/, category: "quota_exhausted" },
  // OpenCode Go / Zen / free-tier "Usage limit reached" wording — see
  // packages/opencode/src/session/retry.ts:106 + GO_UPSELL_MESSAGE:9.
  { re: /\busage limit reached\b/, category: "quota_exhausted" },
  // Trailing `(?![a-z])` (not standard \b) so "usage_limit_reached" matches
  // — \b would require non-word char after "limit", but "_" is a word char.
  // Allows optional `s` for "usage limits" plural.
  {
    re: /\busage[ _-]?(limit|cap|maxed|exceeded)s?(?![a-z])/,
    category: "quota_exhausted",
  },
  {
    re: /\bfree[_ ]?usage[_ ]?(exceeded|exhausted)\b/,
    category: "quota_exhausted",
  },
  // Kimi Code specific — documented error wordings from
  // kimi.com/code/docs/en/kimi-code/error-reference.html. The weekly-cap
  // wording is not in the public docs but follows the same noun pattern as
  // the documented 5-hourly and monthly variants ("weekly quota has been
  // fully used up").
  { re: /\bweekly[ _-]?quota\b/, category: "quota_exhausted" },
  { re: /\bfully[ _-]?used[ _-]?up\b/, category: "quota_exhausted" },
  { re: /\bkimi[ _-]?monthly\b/, category: "quota_exhausted" },
  // Kimi billing-cycle 403 wording — used both as message text and inside
  // responseBody JSON. Note: the broader "usage limit" pattern above already
  // catches the prefix; this is belt-and-braces for the body-scan path.
  { re: /\bbilling[ _-]?cycle\b/, category: "quota_exhausted" },

  // Model not found / unknown
  { re: /\bmodel[ _-]?not[ _-]?found/, category: "unknown_model" },
  { re: /\bunknown[ _-]model/, category: "unknown_model" },

  // Auth errors. Cover US (unauthorized) + UK (unauthorised) + forbidden +
  // generic "bad api key" / "invalid api key" hints.
  { re: /\b(unauthorized|unauthorised|forbidden)\b/, category: "auth_error" },
  { re: /\b(bad|invalid|missing).{0,16}\bapi\s*key\b/, category: "auth_error" },
  { re: /\b(401|403)\b/, category: "auth_error" },

  // Server errors
  { re: /\binternal server error\b/, category: "server_error" },
  { re: /\b(5\d{2})\b/, category: "server_error" },
  { re: /\bservice unavailable\b/, category: "server_error" },

  // Generic retry signal — last resort; lowest priority.
  { re: /\bretrying\b/, category: "unknown" },
];
