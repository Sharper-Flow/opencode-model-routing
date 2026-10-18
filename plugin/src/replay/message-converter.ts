// Convert parts from a previous message attempt into the shape required by
// client.session.prompt(). Native subtask parts are dispatch instructions,
// not replayable prompt content: copying one would execute the task again.
//
// Borrowed in spirit from Smart-Coders-HQ/opencode-model-fallback (Apache-2.0).

import { isRecord } from "../utils/type-guards.ts";

export type Part = unknown;

export function convertPartsForPrompt(
  parts: Part[] | null | undefined,
): Part[] {
  if (!parts || !Array.isArray(parts)) return [];
  return parts.filter((part) => !isRecord(part) || part.type !== "subtask");
}
