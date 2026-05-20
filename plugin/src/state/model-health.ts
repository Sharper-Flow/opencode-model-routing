// Per-model health tracking. Cooldown windows are stored as epoch-ms
// expiry timestamps; isInCooldown compares against `Date.now()` (or an
// injected clock for tests).

import type { ModelKey } from "../types.js";

export type HealthState = "healthy" | "unhealthy" | "cooling";

export interface HealthRecord {
  state: HealthState;
  // Epoch ms at which the cooldown expires. 0 = no cooldown active.
  cooldownUntil: number;
  // Last error category seen (informational; surfaced in logs).
  lastCategory?: string;
}

export type NowFn = () => number;

export class ModelHealthMap {
  private records = new Map<ModelKey, HealthRecord>();
  private now: NowFn;

  constructor(now: NowFn = () => Date.now()) {
    this.now = now;
  }

  get(key: ModelKey): HealthRecord {
    return this.records.get(key) ?? { state: "healthy", cooldownUntil: 0 };
  }

  set(key: ModelKey, record: HealthRecord): void {
    this.records.set(key, record);
  }

  // Mark a model unhealthy and start a cooldown window.
  cooldown(key: ModelKey, durationMs: number, category?: string): void {
    this.records.set(key, {
      state: "cooling",
      cooldownUntil: this.now() + durationMs,
      lastCategory: category,
    });
  }

  // Returns true if the model is currently within its cooldown window.
  // Side-effect: if the cooldown has expired, the record is upgraded to
  // "healthy" so the caller sees a consistent view.
  isInCooldown(key: ModelKey): boolean {
    const r = this.records.get(key);
    if (!r) return false;
    if (r.state !== "cooling") return false;
    if (r.cooldownUntil > this.now()) return true;
    // Cooldown expired — upgrade to healthy.
    this.records.set(key, { state: "healthy", cooldownUntil: 0 });
    return false;
  }
}
