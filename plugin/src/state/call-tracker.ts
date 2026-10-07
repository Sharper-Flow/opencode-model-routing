// call-tracker.ts — per-session in-flight LLM call records.
//
// The host persists an assistant message row (agent + providerID/modelID)
// BEFORE processing a request — the main agent loop and compaction alike
// (upstream session/compaction.ts: updateMessage(msg) then processor
// .process(...); verified 2026-10-07). A message.updated arrival for an
// incomplete assistant row therefore marks a call as IN FLIGHT, and the
// row's terminal updates — error persisted or time.completed set — close
// it. The chat.params hook, which fires per request (compaction included),
// confirms a matching record and refreshes its recency.
//
// Model-less failure signals (session.status retry, session.error) carry no
// model identity. They attribute through these records: the signal names at
// most a provider token (status.action.provider / error.data.providerID),
// and the open-call set says which call is actually failing. A provider
// token alone is NEVER promoted to a ModelKey — attribution always yields
// the open record's own providerID/modelID pair.
//
// State is in-memory and per-process by design: a bounded record of what
// this process saw in flight. Missed open events degrade to "unattributed"
// (no cooldown, no rotation), never to a guess.

export interface OpenCallRecord {
  sessionId: string;
  messageId: string;
  // Agent named by the row (or adopted from a chat.params confirm). Null
  // when neither source carried one — isolation cannot key on it then.
  agent: string | null;
  providerID: string;
  modelID: string;
  // Refreshed by repeated row updates and chat.params confirms; drives TTL
  // reaping so a record whose close event was missed cannot poison
  // attribution forever.
  refreshedAt: number;
}

export interface AttributedCall {
  messageId: string;
  agent: string | null;
  providerID: string;
  modelID: string;
}

export interface InFlightCallTrackerOptions {
  now?: () => number;
  ttlMs?: number;
  maxPerSession?: number;
  maxTotal?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PER_SESSION = 16;
const DEFAULT_MAX_TOTAL = 512;

interface SequencedRecord extends OpenCallRecord {
  sequence: number;
}

/**
 * Bounded registry of open assistant calls, keyed per session by message id.
 *
 * Bounded in two dimensions: a per-session cap and a global cap, both
 * enforced by evicting the stalest record first, plus a TTL reaped on every
 * read. A session id must never be attacker-controlled input here — the
 * keys come from host events — but the caps keep a runaway host (or a
 * missed close storm) from growing the map without bound.
 */
export class InFlightCallTracker {
  private readonly bySession = new Map<string, Map<string, SequencedRecord>>();
  private sequence = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPerSession: number;
  private readonly maxTotal: number;

  constructor(options: InFlightCallTrackerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL;
  }

  /** Open (or refresh) the record for one assistant message row. */
  open(record: {
    sessionId: string;
    messageId: string;
    agent: string | null;
    providerID: string;
    modelID: string;
  }): void {
    let session = this.bySession.get(record.sessionId);
    if (!session) {
      session = new Map();
      this.bySession.set(record.sessionId, session);
    }
    const existing = session.get(record.messageId);
    const sequenced: SequencedRecord = {
      ...record,
      sequence: existing?.sequence ?? ++this.sequence,
      refreshedAt: this.now(),
    };
    session.set(record.messageId, sequenced);
    this.evict();
  }

  /**
   * chat.params confirm: refresh the recency of the open record matching
   * the request's model (and agent, when the record already carries one).
   * A record without an agent adopts the request's agent — the row is the
   * identity authority but chat.params carries the per-request agent even
   * for rows that never got one persisted. Returns true when a record was
   * confirmed.
   */
  confirm(
    sessionId: string,
    call: { agent?: string | null; providerID: string; modelID: string },
  ): boolean {
    const session = this.bySession.get(sessionId);
    if (!session) return false;
    const candidates = this.fresh(session).filter(
      (r) => r.providerID === call.providerID && r.modelID === call.modelID,
    );
    let match: SequencedRecord | undefined;
    if (call.agent) {
      match =
        candidates.find((r) => r.agent === call.agent) ??
        candidates.find((r) => r.agent === null);
      if (match && match.agent === null) match.agent = call.agent;
    } else {
      match = candidates[candidates.length - 1];
    }
    if (!match) return false;
    match.refreshedAt = this.now();
    return true;
  }

  /** Close the record for one message row (terminal update or removal). */
  closeMessage(sessionId: string, messageId: string): void {
    this.bySession.get(sessionId)?.delete(messageId);
  }

  /** Close every open record for a session (idle, deleted). */
  completeSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /**
   * Close a session's open records for one agent. session.compacted closes
   * the compaction agent's rows: the compaction call is over even when its
   * terminal row update never surfaced.
   */
  completeAgent(sessionId: string, agent: string): void {
    const session = this.bySession.get(sessionId);
    if (!session) return;
    for (const [key, record] of session) {
      if (record.agent === agent) session.delete(key);
    }
  }

  /** Fresh (non-expired) open records for a session, oldest first. */
  openCalls(sessionId: string): OpenCallRecord[] {
    const session = this.bySession.get(sessionId);
    if (!session) return [];
    return this.fresh(session)
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ sequence: _sequence, ...record }) => record);
  }

  /**
   * Attribution rule for model-less failure signals:
   *   - provider token present → the unique open call whose providerID
   *     matches; zero or multiple matches → unattributed;
   *   - no token → the single open call; zero or multiple → unattributed.
   *
   * Never synthesizes identity from the provider token itself.
   */
  attribute(
    sessionId: string,
    providerHint?: string | null,
  ): AttributedCall | undefined {
    const calls = this.openCalls(sessionId);
    const candidates = providerHint
      ? calls.filter((c) => c.providerID === providerHint)
      : calls;
    if (candidates.length !== 1) return undefined;
    const only = candidates[0]!;
    return {
      messageId: only.messageId,
      agent: only.agent,
      providerID: only.providerID,
      modelID: only.modelID,
    };
  }

  private fresh(session: Map<string, SequencedRecord>): SequencedRecord[] {
    const now = this.now();
    const out: SequencedRecord[] = [];
    for (const [key, record] of session) {
      if (now - record.refreshedAt >= this.ttlMs) {
        session.delete(key);
        continue;
      }
      out.push(record);
    }
    return out;
  }

  private evict(): void {
    let total = 0;
    for (const session of this.bySession.values()) total += session.size;
    while (total > this.maxTotal) {
      const victim = this.stalestAcrossSessions();
      if (!victim) break;
      this.removeVictim(victim);
      total -= 1;
    }
    for (const [sessionId, session] of this.bySession) {
      while (session.size > this.maxPerSession) {
        let stalest: SequencedRecord | undefined;
        for (const record of session.values()) {
          if (!stalest || record.sequence < stalest.sequence) stalest = record;
        }
        if (!stalest) break;
        session.delete(stalest.messageId);
      }
      if (session.size === 0) this.bySession.delete(sessionId);
    }
  }

  private stalestAcrossSessions(): SequencedRecord | undefined {
    let stalest: SequencedRecord | undefined;
    for (const session of this.bySession.values()) {
      for (const record of session.values()) {
        if (!stalest || record.sequence < stalest.sequence) stalest = record;
      }
    }
    return stalest;
  }

  private removeVictim(victim: SequencedRecord): void {
    this.bySession.get(victim.sessionId)?.delete(victim.messageId);
    const session = this.bySession.get(victim.sessionId);
    if (session && session.size === 0) this.bySession.delete(victim.sessionId);
  }
}
