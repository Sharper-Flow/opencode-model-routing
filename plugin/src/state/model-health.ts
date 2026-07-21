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
//   - Persist failure is swallowed (fail-open per C1): the in-memory
//     update stands; siblings simply don't see the cooldown.

import type { ModelKey } from "../types.ts";

export type HealthState = "healthy" | "unhealthy" | "cooling";

export interface HealthRecord {
  state: HealthState;
  // Epoch ms at which the cooldown expires. 0 = no cooldown active.
  cooldownUntil: number;
  // Last error category seen (informational; surfaced in logs).
  lastCategory?: string;
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
    // Fire-and-forget from caller's perspective unless they await; but the
    // returned promise reflects persist settle. Wrap in .catch to enforce
    // fail-open (defensive — CooldownStore.persistCooldown should never
    // reject, but a misbehaving fake or future impl might).
    return this.cooldownStore
      .persistCooldown(key, cooldownUntil, reason, now)
      .catch(() => {
        // Fail-open: in-memory update stands, sibling visibility lost.
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
   * Side-effect: if the cooldown has expired (in-memory or persistent),
   * the record is upgraded to "healthy" so the caller sees a consistent
   * view.
   */
  isInCooldown(key: ModelKey): boolean {
    const r = this.records.get(key);
    if (r) {
      if (r.state !== "cooling") return false;
      if (r.cooldownUntil > this.now()) return true;
      // Cooldown expired — upgrade to healthy.
      this.records.set(key, { state: "healthy", cooldownUntil: 0 });
      return false;
    }

    // In-memory miss. Consult cooldownStore if configured (read-through).
    if (!this.cooldownStore) return false;

    const persistent = this.cooldownStore.readCooldowns().get(key);
    if (!persistent) return false;
    if (persistent.expiresAt <= this.now()) return false;

    // Write-back to in-memory Map so future reads are cache-local and
    // expiry side-effects fire uniformly.
    this.records.set(key, {
      state: "cooling",
      cooldownUntil: persistent.expiresAt,
      lastCategory: persistent.reason,
    });
    return true;
  }
}
