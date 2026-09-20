// parseMessageResetBoundary — extract a provider-reported reset boundary
// from raw error text (message or status payload).
//
// Some providers state their own reset in the failure text itself ("Usage
// limit reached for week. Your limit will reset at 2026-09-09 15:26:55",
// observed verbatim from the zai-coding-plan provider; "You've reached your
// weekly usage limit for your plan. Your limit resets at <time>" per the
// Command Code usage-limits docs). The parsed boundary lets the cooldown run
// until the provider's own reset instead of the category constant.
//
// Bounded by design — every gate yields null and the caller keeps the
// category constant as its probe interval:
//   - strictly-future only: a past reset describes a window that already
//     reopened, and cooling until it means no cooldown at all;
//   - 7-day sanity ceiling: the longest legitimate rolling window is the
//     weekly cap, so anything further out is malformed or a different clock;
//   - malformed input (human-only clock times like "3:00 PM", prose without
//     a date) does not parse.
//
// Stamps without a timezone are read as host-local time (the ECMAScript
// Date.parse behavior for date-time strings), matching how the provider's
// naive local-time stamps are written on the user's own host. The timezone
// uncertainty is bounded by the same two gates above.

// Longest legitimate rolling window is the weekly cap.
export const RESET_BOUNDARY_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

// Calendar date + clock time, "T" or single-space separator, optional
// seconds / fractional seconds / timezone (Z or ±HH:MM / ±HHMM).
const RESET_AT_PATTERN =
  /\breset(?:s)?\s+at\s+(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?/i;

/**
 * Parse the first reset boundary found in `text`. Returns the epoch-ms
 * boundary when it is strictly in the future at `now` and no further than
 * RESET_BOUNDARY_MAX_AHEAD_MS ahead; null otherwise (past, malformed, or
 * absent reset).
 */
export function parseMessageResetBoundary(
  text: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!text) return null;
  const match = RESET_AT_PATTERN.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, tz] = match;
  // Rebuild as canonical ISO with the "T" separator; missing seconds mean
  // :00. Normalize fractional seconds because Date.parse accepts precision
  // beyond milliseconds but stores only three digits.
  const milliseconds = fraction
    ? `.${fraction.padEnd(3, "0").slice(0, 3)}`
    : "";
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}${milliseconds}${tz ?? ""}`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  if (ms <= now) return null;
  if (ms - now > RESET_BOUNDARY_MAX_AHEAD_MS) return null;
  return ms;
}
