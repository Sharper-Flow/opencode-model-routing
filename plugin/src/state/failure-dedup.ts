export interface FailureIdentity {
  sessionId: string;
  messageId?: string;
  fingerprint: string;
  familyKey: string;
}

export interface FailureDeduplicatorOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

interface Entry {
  sessionId: string;
  expiresAt: number;
  sequence: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 512;

/**
 * Bounded, per-process idempotency registry for typed failure events.
 *
 * OpenCode emits a transient session.error without an assistant message ID,
 * then persists the same error in message.updated with a message ID. Retry
 * session.status events have a third payload shape. Three indexes correlate
 * those signals without relying on delivery order or a session-wide timer.
 */
export class FailureDeduplicator {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private sequence = 0;

  constructor(options: FailureDeduplicatorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get size(): number {
    return this.entries.size;
  }

  begin(identity: FailureIdentity): "new" | "duplicate" {
    const now = this.now();
    this.prune(now);

    const keys = this.keys(identity);
    const duplicate = keys.some((key) => this.entries.has(key));
    const entry: Entry = {
      sessionId: identity.sessionId,
      expiresAt: now + this.ttlMs,
      sequence: ++this.sequence,
    };

    // Record every available alias even when this delivery is a duplicate.
    // This lets a transient alias become an exact message identity once the
    // durable message.updated event arrives.
    for (const key of keys) this.entries.set(key, entry);
    this.enforceCapacity();
    return duplicate ? "duplicate" : "new";
  }

  clearSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(key);
    }
  }

  prune(now = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private keys(identity: FailureIdentity): string[] {
    const keys = [
      `alias\u0000${identity.sessionId}\u0000${identity.fingerprint}`,
      `family\u0000${identity.familyKey}`,
    ];
    if (identity.messageId) {
      keys.push(
        `exact\u0000${identity.sessionId}\u0000${identity.messageId}\u0000${identity.fingerprint}`,
      );
    }
    return keys;
  }

  private enforceCapacity(): void {
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.entries()].sort(
      ([, a], [, b]) => a.sequence - b.sequence,
    );
    for (const [key] of oldest) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
