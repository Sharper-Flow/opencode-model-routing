// Per-model health tracking. Cooldown windows are stored as epoch-ms
// expiry timestamps; isInCooldown compares against `Date.now()` (or an
// injected clock for tests).
//
// Optional CooldownStore integration (KD4 + KD8 from design.md):
//   - When cooldownStore is provided, cooldown() also persists the entry
//     to disk for cross-process visibility, and returns a Promise<void>
//     so callers (e.g. attemptFallback) can await persist settle before
//     dispatching replacement spawns (KD8).
//   - When cooldownStore is undefined, behavior is unchanged from the
//     original in-memory-only semantics: cooldown() returns Promise.resolve()
//     and isInCooldown() consults only the in-memory Map.
//   - isInCooldown() does read-through: when the in-memory Map misses,
//     consults cooldownStore; if a fresh entry is found, writes it back
//     to the in-memory Map so subsequent reads are cache-local.
//   - The store is authoritative for a cooling record it is known to hold
//     (`persisted`). Every isInCooldown() on such a record re-reads the
//     store (TTL-cached), so `omr-cooldown reset` from another process
//     frees this one, and a sibling's rewrite of expiresAt is adopted.
//   - Persist failure is swallowed (fail-open per C1): the in-memory
//     update stands and stays authoritative, because the store never held
//     the entry and its absence is not a clear.

import type { ModelKey } from "../types.ts";

export type HealthState = "healthy" | "unhealthy" | "cooling";

export interface HealthRecord {
  state: HealthState;
  // Epoch ms at which the cooldown expires. 0 = no cooldown active.
  cooldownUntil: number;
  // Last error category seen (informational; surfaced in logs).
  lastCategory?: string;
  // True once the cooldown store is known to hold this cooling record.
  // From then on the store's entry, or its absence, wins over this record.
  persisted?: boolean;
}

export type NowFn = () => number;

/**
 * Structural interface for the persistent cooldown backend.
 * `CooldownStore` from cooldown-store.ts satisfies this; tests may pass
 * lightweight fakes matching the same shape.
 */
export interface CooldownStoreLike {
  persistCooldown(
    modelKey: ModelKey,
    expiresAt: number,
    reason: string,
    setAt: number,
  ): Promise<void>;
  readCooldowns(): Map<
    ModelKey,
    { expiresAt: number; reason: string; setAt: number }
  >;
}

export class ModelHealthMap {
  private records = new Map<ModelKey, HealthRecord>();
  private now: NowFn;
  private readonly cooldownStore: CooldownStoreLike | undefined;

  constructor(
    now: NowFn = () => Date.now(),
    cooldownStore?: CooldownStoreLike,
  ) {
    this.now = now;
    this.cooldownStore = cooldownStore;
  }

  get(key: ModelKey): HealthRecord {
    return this.records.get(key) ?? { state: "healthy", cooldownUntil: 0 };
  }

  set(key: ModelKey, record: HealthRecord): void {
    this.records.set(key, record);
  }

  /**
   * Mark a model unhealthy and start a cooldown window.
   *
   * In-memory mutation is synchronous; callers may rely on isInCooldown()
   * returning true immediately after this call resolves synchronously
   * (the await is only required to ensure persist settle before spawn
   * dispatch per KD8).
   *
   * Returns a Promise that:
   *   - resolves immediately when no cooldownStore is configured
   *   - resolves after persistCooldown settles (success OR swallow-failure)
   *     when cooldownStore is configured
   * Never rejects (fail-open per C1).
   */
  cooldown(
    key: ModelKey,
    durationMs: number,
    category?: string,
  ): Promise<void> {
    const now = this.now();
    const cooldownUntil = now + durationMs;
    this.records.set(key, {
      state: "cooling",
      cooldownUntil,
      lastCategory: category,
    });

    if (!this.cooldownStore) {
      return Promise.resolve();
    }
    const reason = category ?? "default";
    const store = this.cooldownStore;
    // Fire-and-forget from caller's perspective unless they await; but the
    // returned promise reflects persist settle. Wrap in .catch to enforce
    // fail-open (defensive — CooldownStore.persistCooldown should never
    // reject, but a misbehaving fake or future impl might).
    return store
      .persistCooldown(key, cooldownUntil, reason, now)
      .catch(() => {
        // Fail-open: in-memory update stands, sibling visibility lost.
      })
      .then(() => {
        // persistCooldown resolves on failure too, so the store is read
        // back to learn whether it holds the entry. Only then does the
        // store become authoritative for this record. Max-merge may have
        // kept a sibling's longer window; adopt it.
        const current = this.records.get(key);
        if (
          !current ||
          current.state !== "cooling" ||
          current.cooldownUntil !== cooldownUntil
        ) {
          return;
        }
        const stored = store.readCooldowns().get(key);
        if (!stored || stored.expiresAt < cooldownUntil) return;
        current.persisted = true;
        current.cooldownUntil = stored.expiresAt;
      });
  }

  /**
   * Returns true if the model is currently within its cooldown window.
   *
   * Read-through semantics: when the in-memory Map misses AND a
   * cooldownStore is configured, consults the persistent Map. If a fresh
   * (non-expired) entry exists there, writes it back to the in-memory Map
   * so subsequent reads are cache-local and the existing side-effect
   * (expiry → upgrade to "healthy") applies uniformly.
   *
   * Store authority: a cooling record the store is known to hold
   * (`persisted`) is re-checked against the store on every call. The
   * store's read is TTL-cached, so this costs one file read per
   * COOLDOWN_CACHE_TTL_MS at most. An entry that is gone or expired in
   * the store clears the record; a different expiresAt is adopted. An
   * unpersisted record (persist pending or failed) stays in-memory-only.
   *
   * Side-effect: if the cooldown has expired (in-memory or persistent),
   * the record is upgraded to "healthy" so the caller sees a consistent
   * view.
   */
  isInCooldown(key: ModelKey): boolean {
    const now = this.now();
    const r = this.records.get(key);
    if (r) {
      if (r.state !== "cooling") return false;
      if (r.cooldownUntil <= now) return this.markHealthy(key);
      if (!r.persisted || !this.cooldownStore) return true;

      const stored = this.cooldownStore.readCooldowns().get(key);
      if (!stored || stored.expiresAt <= now) return this.markHealthy(key);
      r.cooldownUntil = stored.expiresAt;
      return true;
    }

    // In-memory miss. Consult cooldownStore if configured (read-through).
    if (!this.cooldownStore) return false;

    const persistent = this.cooldownStore.readCooldowns().get(key);
    if (!persistent) return false;
    if (persistent.expiresAt <= now) return false;

    // Write-back to in-memory Map so future reads are cache-local and
    // expiry side-effects fire uniformly. The entry came from the store,
    // so the store is authoritative for it from the start.
    this.records.set(key, {
      state: "cooling",
      cooldownUntil: persistent.expiresAt,
      lastCategory: persistent.reason,
      persisted: true,
    });
    return true;
  }

  private markHealthy(key: ModelKey): false {
    this.records.set(key, { state: "healthy", cooldownUntil: 0 });
    return false;
  }
}
