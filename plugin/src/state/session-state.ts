// Per-session state for fallback tracking.
//
// Held in memory only — agreement excludes cross-restart persistence.
// Cooldown windows are short enough that recreating state on restart costs
// at most one extra failed attempt per model per restart.

import type { ModelKey } from "../types.ts";

export interface SessionState {
  // The model that started this session — used for recovery detection
  // (when the original recovers from cooldown).
  originalModel: ModelKey | null;
  // The model currently in use after fallback.
  currentModel: ModelKey | null;
  // The model that last had a request dispatched for this session: set from
  // chat.message (after availability preflight and preemptive redirect have
  // settled the final model) and after a successful recovery prompt. Failure
  // signals that carry no model identity attribute their cooldown here —
  // currentModel can name a model this session advanced to without that
  // model ever serving a request (subagent short-circuit), and cooling it
  // would bench a healthy model for another model's failure.
  lastServedModel: ModelKey | null;
  // Agent name resolved from session.messages[0]; cached.
  agentName: string | null;
  // Agent file path (markdown frontmatter source), if applicable.
  agentFile: string | null;
  // How many fallback steps have already executed for this session.
  fallbackDepth: number;
  // Epoch ms of the last fallback for this session — used for dedup.
  lastFallbackAt: number;
  // Cached subagent detection result: `true` if session.get returned a
  // non-empty parentID (this session is a child of another, observed by
  // the parent's Task tool). `false` if confirmed primary. `undefined`
  // before first check. Used to short-circuit abort/recovery on subagent
  // sessions where the parent Task tool observes cancel events as
  // terminal — see detectSubagent() in plugin-internal.ts.
  isSubagent?: boolean;
  // Parent session id captured by the same session.get that resolves
  // isSubagent. `null` once confirmed primary. Used by the family
  // disjointness constraint to find the requesting session's model.
  parentSessionId?: string | null;
  // Serving model of the parent session, for agents opted into
  // family_disjoint_from_parent. `undefined` = not yet resolved; a resolved
  // ModelKey is cached so repeated selection scans in one process do not
  // re-fetch. Unknown outcomes are never cached — a modelless parent is
  // usually transient (assistant turn still streaming), so each scan
  // re-attempts resolution.
  parentModelKey?: ModelKey;
}

export function newSessionState(): SessionState {
  return {
    originalModel: null,
    currentModel: null,
    lastServedModel: null,
    agentName: null,
    agentFile: null,
    fallbackDepth: 0,
    lastFallbackAt: 0,
    // isSubagent intentionally omitted — undefined until first detection.
  };
}
