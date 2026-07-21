// context-summary.ts — pure, dependency-free extractor that summarises the
// assistant work produced AFTER the last user message (i.e. the failed turn's
// in-progress tool calls and text) so the next model in the fallback chain can
// continue instead of restarting from the bare user prompt.
//
// Contract:
//   - Walk only messages that follow `lastUserMessageID`.
//   - For each assistant message part:
//       * text parts (`type === "text"`): first ~TEXT_EXCERPT_CHARS chars.
//       * any other part with a string `type`: treated as a tool call; the
//         tool name is the part's `type` field (per task contract).
//   - Build a markdown bulleted list, capped at ~MAX_CHARS (truncation marker
//     appended when the cap is hit).
//   - Return "" when there is no assistant work after the last user message.
//   - Graceful degradation: ANY unexpected shape or thrown error → "".
//     The fallback path must NEVER block on context enrichment.
//
// Supports BOTH OpenCode message shapes via the shared type-guard helpers:
//   - flat:    { id, role, parts }
//   - nested:  { info: { id, role }, parts }

import { isRecord, messageInfo, messageParts } from "../utils/type-guards.ts";

const MAX_CHARS = 2000;
const TEXT_EXCERPT_CHARS = 200;
const TRUNCATION_MARKER = "\n…(truncated)";

export function extractContextSummary(
  messages: unknown[],
  lastUserMessageID: string,
): string {
  try {
    if (
      !Array.isArray(messages) ||
      typeof lastUserMessageID !== "string" ||
      lastUserMessageID.length === 0
    ) {
      return "";
    }

    // Locate the lastUser message; we only consider work AFTER it.
    let start = -1;
    for (let i = 0; i < messages.length; i++) {
      const info = messageInfo(messages[i]);
      if (!info) continue;
      const id = info.id ?? info.messageID;
      if (id === lastUserMessageID) {
        start = i;
        break;
      }
    }
    if (start < 0) return "";

    const lines: string[] = [];
    for (let i = start + 1; i < messages.length; i++) {
      const info = messageInfo(messages[i]);
      if (!info) continue;
      if (info.role !== "assistant") continue;

      const parts = messageParts(messages[i]);
      for (const part of parts) {
        if (!isRecord(part)) continue;
        const type = part.type;
        if (type === "text") {
          const text = typeof part.text === "string" ? part.text : "";
          if (text.length === 0) continue;
          const excerpt =
            text.length > TEXT_EXCERPT_CHARS
              ? `${text.slice(0, TEXT_EXCERPT_CHARS)}…`
              : text;
          lines.push(`- ${excerpt}`);
        } else if (typeof type === "string" && type.length > 0) {
          // Tool-call part: the `type` field IS the tool name.
          lines.push(`- Tool: ${type}`);
        }
      }
    }

    if (lines.length === 0) return "";

    // Accumulate lines, reserving room for the truncation marker so the final
    // string never exceeds MAX_CHARS.
    let out = "";
    for (const line of lines) {
      const next = out.length === 0 ? line : `${out}\n${line}`;
      if (next.length + TRUNCATION_MARKER.length > MAX_CHARS) {
        return out + TRUNCATION_MARKER;
      }
      out = next;
    }
    return out;
  } catch {
    // Any parse failure degrades to a bare prompt.
    return "";
  }
}
