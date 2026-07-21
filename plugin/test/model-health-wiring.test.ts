// Integration tests for ModelHealthMap + FallbackStore wiring to CooldownStore.
//
// Verifies backwards compatibility (no cooldownStore = current behavior) AND
// new cross-process behavior (with cooldownStore injected).
//
// RED/GREEN target for ADV task tk-520fd2a27486 (TDD inline).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FallbackStore } from "../src/state/store.ts";
import { ModelHealthMap } from "../src/state/model-health.ts";
import {
  CooldownStore,
  COOLDOWN_SCHEMA,
  COOLDOWN_VERSION,
} from "../src/state/cooldown-store.ts";
import type { ModelKey } from "../src/types.ts";

let dir: string;
let cooldownPath: string;
let baseNow: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-wire-"));
  cooldownPath = path.join(dir, "cooldown.json");
  baseNow = Date.now();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Backwards compatibility: no cooldownStore = current behavior ---

describe("ModelHealthMap without cooldownStore (backwards compat — DONT2)", () => {
  test("cooldown() returns a Promise that resolves", async () => {
    const m = new ModelHealthMap(() => baseNow);
    const result = m.cooldown("a/one" as ModelKey, 5_000, "rate_limit");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  test("isInCooldown unchanged from current behavior (sync mutation)", () => {
    let now = baseNow;
    const m = new ModelHealthMap(() => now);
    m.cooldown("a/one" as ModelKey, 5_000, "rate_limit");
    // Synchronous: in-memory state reflects cooldown immediately.
    expect(m.isInCooldown("a/one" as ModelKey)).toBe(true);
    now += 5_001;
    expect(m.isInCooldown("a/one" as ModelKey)).toBe(false);
  });

  test("unknown model returns false", () => {
    const m = new ModelHealthMap();
    expect(m.isInCooldown("never/seen" as ModelKey)).toBe(false);
  });
});

// --- New behavior: cooldownStore injected ---

describe("ModelHealthMap with cooldownStore — persist call (KD8, C5)", () => {
  test("cooldown() triggers persistCooldown with key, expiresAt=now+duration, category, now", async () => {
    const now = baseNow;
    const persisted: Array<{
      modelKey: ModelKey;
      expiresAt: number;
      reason: string;
      setAt: number;
    }> = [];
    const fakeStore = {
      persistCooldown: async (
        modelKey: ModelKey,
        expiresAt: number,
        reason: string,
        setAt: number,
      ): Promise<void> => {
        persisted.push({ modelKey, expiresAt, reason, setAt });
      },
      readCooldowns: () =>
        new Map<
          ModelKey,
          { expiresAt: number; reason: string; setAt: number }
        >(),
    };
    const m = new ModelHealthMap(() => now, fakeStore as any);
    await m.cooldown("kimi/kimi" as ModelKey, 60 * 60_000, "quota_exhausted");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].modelKey).toBe("kimi/kimi");
    expect(persisted[0].expiresAt).toBe(now + 60 * 60_000);
    expect(persisted[0].reason).toBe("quota_exhausted");
    expect(persisted[0].setAt).toBe(now);
  });

  test("cooldown() default category when none provided", async () => {
    const persisted: Array<{ reason: string }> = [];
    const fakeStore = {
      persistCooldown: async (
        _k: any,
        _e: any,
        reason: string,
      ): Promise<void> => {
        persisted.push({ reason });
      },
      readCooldowns: () => new Map(),
    };
    const m = new ModelHealthMap(() => baseNow, fakeStore as any);
    await m.cooldown("a/one" as ModelKey, 5_000);
    expect(persisted[0]?.reason).toBe("default");
  });

  test("in-memory state updated synchronously even when cooldownStore is set", async () => {
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {
        // Delay to confirm in-memory update doesn't wait on persist.
        await new Promise((r) => setTimeout(r, 50));
      },
      readCooldowns: () => new Map(),
    };
    const m = new ModelHealthMap(() => baseNow, fakeStore as any);
    const p = m.cooldown("a/one" as ModelKey, 5_000, "rate_limit");
    // In-memory state already updated (synchronous).
    expect(m.isInCooldown("a/one" as ModelKey)).toBe(true);
    // Persist still pending.
    await p;
  });

  test("persistCooldown rejection is swallowed; cooldown() still resolves", async () => {
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {
        throw new Error("simulated persist failure");
      },
      readCooldowns: () => new Map(),
    };
    const m = new ModelHealthMap(() => baseNow, fakeStore as any);
    // Should not throw — fail-open per C1.
    await expect(
      m.cooldown("a/one" as ModelKey, 5_000, "rate_limit"),
    ).resolves.toBeUndefined();
    // In-memory state still correct (persist failure doesn't roll back).
    expect(m.isInCooldown("a/one" as ModelKey)).toBe(true);
  });
});

describe("ModelHealthMap with cooldownStore — read-through (cross-process)", () => {
  test("isInCooldown consults cooldownStore when in-memory Map misses", () => {
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {},
      readCooldowns: () =>
        new Map([
          [
            "sibling/cooldown",
            {
              expiresAt: baseNow + 3_600_000,
              reason: "quota_exhausted",
              setAt: baseNow,
            },
          ],
        ]),
    };
    const m = new ModelHealthMap(() => baseNow, fakeStore as any);
    // In-memory Map has no entry for sibling/cooldown; read-through should find it.
    expect(m.isInCooldown("sibling/cooldown" as ModelKey)).toBe(true);
    // And write-back: in-memory Map now has the entry.
    expect(m.get("sibling/cooldown" as ModelKey).state).toBe("cooling");
  });

  test("isInCooldown falls through when cooldownStore has no entry either", () => {
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {},
      readCooldowns: () => new Map(),
    };
    const m = new ModelHealthMap(() => baseNow, fakeStore as any);
    expect(m.isInCooldown("never/seen" as ModelKey)).toBe(false);
  });

  test("isInCooldown skips cooldownStore read when in-memory already says cooling", () => {
    let readCallCount = 0;
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {},
      readCooldowns: () => {
        readCallCount++;
        return new Map();
      },
    };
    const m = new ModelHealthMap(() => baseNow, fakeStore as any);
    m.cooldown("a/one" as ModelKey, 5_000, "rate_limit");
    expect(m.isInCooldown("a/one" as ModelKey)).toBe(true);
    // No need to read from cooldownStore — in-memory had the answer.
    expect(readCallCount).toBe(0);
  });

  test("isInCooldown expires persistent entry same as in-memory (write-back then expire)", () => {
    let virtualNow = baseNow;
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {},
      readCooldowns: () =>
        new Map([
          [
            "sibling/cooldown",
            {
              expiresAt: virtualNow + 5_000,
              reason: "rate_limit",
              setAt: virtualNow,
            },
          ],
        ]),
    };
    const m = new ModelHealthMap(() => virtualNow, fakeStore as any);
    expect(m.isInCooldown("sibling/cooldown" as ModelKey)).toBe(true);
    // Advance clock past expiry.
    virtualNow += 5_001;
    expect(m.isInCooldown("sibling/cooldown" as ModelKey)).toBe(false);
    // After expiry, in-memory record should be upgraded to healthy.
    expect(m.get("sibling/cooldown" as ModelKey).state).toBe("healthy");
  });
});

// --- FallbackStore wiring ---

describe("FallbackStore — passes cooldownStore to ModelHealthMap", () => {
  test("FallbackStore with no cooldownStore: health is plain ModelHealthMap", () => {
    const s = new FallbackStore();
    expect(s.health).toBeInstanceOf(ModelHealthMap);
    // Existing behavior: cooldown() returns Promise that resolves.
    expect(s.health.cooldown("a/one" as ModelKey, 5_000)).toBeInstanceOf(
      Promise,
    );
  });

  test("FallbackStore with cooldownStore: persists through injected store", async () => {
    const cooldownStore = new CooldownStore(cooldownPath);
    const s = new FallbackStore(() => baseNow, cooldownStore);
    await s.health.cooldown(
      "kimi/kimi" as ModelKey,
      3_600_000,
      "quota_exhausted",
    );
    // The cooldown should have been persisted to disk.
    expect(fs.existsSync(cooldownPath)).toBe(true);
    const text = fs.readFileSync(cooldownPath, "utf-8");
    const parsed = JSON.parse(text);
    expect(parsed.schema).toBe(COOLDOWN_SCHEMA);
    expect(parsed.version).toBe(COOLDOWN_VERSION);
    expect(parsed.entries["kimi/kimi"]).toBeDefined();
    expect(parsed.entries["kimi/kimi"].reason).toBe("quota_exhausted");
  });

  test("FallbackStore with cooldownStore: two stores share state via file", async () => {
    const cooldownStoreA = new CooldownStore(cooldownPath);
    const cooldownStoreB = new CooldownStore(cooldownPath);
    const storeA = new FallbackStore(() => baseNow, cooldownStoreA);
    const storeB = new FallbackStore(() => baseNow, cooldownStoreB);

    // A observes failure, sets cooldown (persists to file).
    await storeA.health.cooldown(
      "kimi/kimi" as ModelKey,
      3_600_000,
      "quota_exhausted",
    );

    // B's in-memory Map has no entry; read-through should find A's persisted cooldown.
    expect(storeB.health.isInCooldown("kimi/kimi" as ModelKey)).toBe(true);
  });
});
