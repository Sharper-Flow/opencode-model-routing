// FallbackStore: the per-process state container for the plugin.
//
// Holds:
//   - sessions: per-session SessionState (history, agent name, fallback depth).
//   - health: per-model health (cooldown windows).
//   - lock: in-flight session set, used to serialize concurrent triggers.
//
// All state is in-memory; the plugin recreates it on every OpenCode restart
// per agreement.

import {
  ModelHealthMap,
  type CooldownStoreLike,
  type NowFn,
} from "./model-health.ts";
import { FailureDeduplicator } from "./failure-dedup.ts";
import { newSessionState, type SessionState } from "./session-state.ts";

export class FallbackStore {
  readonly sessions: SessionsAccessor;
  readonly health: ModelHealthMap;
  readonly failures: FailureDeduplicator;
  private inFlight = new Set<string>();
  private now: NowFn;

  constructor(
    now: NowFn = () => Date.now(),
    cooldownStore?: CooldownStoreLike,
  ) {
    this.now = now;
    this.health = new ModelHealthMap(now, cooldownStore);
    this.failures = new FailureDeduplicator({ now });
    this.sessions = new SessionsAccessor(this.now);
  }

  // acquireLock returns true if the session was not already in flight (and
  // marks it in-flight); false if another trigger is already executing.
  acquireLock(sessionId: string): boolean {
    if (this.inFlight.has(sessionId)) return false;
    this.inFlight.add(sessionId);
    return true;
  }

  releaseLock(sessionId: string): void {
    this.inFlight.delete(sessionId);
  }
}

// SessionsAccessor wraps the per-session map and exposes the dedup helper
// alongside lazy state creation.
export class SessionsAccessor {
  private map = new Map<string, SessionState>();
  private now: NowFn;

  constructor(now: NowFn) {
    this.now = now;
  }

  get(sessionId: string): SessionState {
    let s = this.map.get(sessionId);
    if (!s) {
      s = newSessionState();
      this.map.set(sessionId, s);
    }
    return s;
  }

  isInDedupWindow(sessionId: string, windowMs: number): boolean {
    const s = this.map.get(sessionId);
    if (!s) return false;
    return this.now() - s.lastFallbackAt < windowMs;
  }

  setAgentFile(sessionId: string, file: string): void {
    const s = this.get(sessionId);
    s.agentFile = file;
  }
}
