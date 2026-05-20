// Convert parts from a previous message attempt into the shape required by
// client.session.prompt(). Passes through text + tool-call + attachment parts
// unchanged in v1; we keep the seam so future shape adjustments stay local.
//
// Borrowed in spirit from Smart-Coders-HQ/opencode-model-fallback (Apache-2.0).

export type Part = unknown;

export function convertPartsForPrompt(parts: Part[] | null | undefined): Part[] {
  if (!parts || !Array.isArray(parts)) return [];
  // Defensive copy — orchestrator shouldn't mutate the caller's array.
  return [...parts];
}
