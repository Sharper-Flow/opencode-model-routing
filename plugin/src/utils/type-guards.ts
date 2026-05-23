// Shared structural type guards. Kept narrow on purpose — pure functions
// with no dependencies so any module can import without cycles.

/**
 * Narrows `unknown` to a record-shaped object (non-null, non-array).
 * Used at all OpenCode SDK boundary points where payloads arrive as
 * `unknown` and need defensive shape checking before property access.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
