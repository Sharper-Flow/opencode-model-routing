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

export interface MessageEnvelope {
  info: Record<string, unknown>;
  parts: unknown[];
}

export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  return isRecord(value) && isRecord(value.info) && Array.isArray(value.parts);
}

export function messageInfo(value: unknown): Record<string, unknown> | undefined {
  if (isMessageEnvelope(value)) return value.info;
  if (isRecord(value)) return value;
  return undefined;
}

export function messageParts(value: unknown): unknown[] {
  if (isMessageEnvelope(value)) return value.parts;
  const info = messageInfo(value);
  return info && Array.isArray(info.parts) ? info.parts : [];
}

export function unwrapSdkData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}
