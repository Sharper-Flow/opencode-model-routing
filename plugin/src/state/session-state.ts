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
  // Agent name resolved from session.messages[0]; cached.
  agentName: string | null;
  // Agent file path (markdown frontmatter source), if applicable.
  agentFile: string | null;
  // How many fallback steps have already executed for this session.
  fallbackDepth: number;
  // Epoch ms of the last fallback for this session — used for dedup.
  lastFallbackAt: number;
  // Track which model the user was last notified about (avoid duplicate
  // notifications when the same fallback is still active).
  recoveryNotifiedForModel: ModelKey | null;
  fallbackActiveNotifiedKey: ModelKey | null;
}

export function newSessionState(): SessionState {
  return {
    originalModel: null,
    currentModel: null,
    agentName: null,
    agentFile: null,
    fallbackDepth: 0,
    lastFallbackAt: 0,
    recoveryNotifiedForModel: null,
    fallbackActiveNotifiedKey: null,
  };
}
