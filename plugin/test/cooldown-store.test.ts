// Unit tests for plugin/src/state/cooldown-store.ts
//
// Covers the CooldownStore class — persistent cross-process cooldown map
// using file-protocol + cooperative lock around read-merge-write.
//
// RED/GREEN target for ADV task tk-2941f5f79fd3 (TDD inline).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CooldownStore,
  getCooldownPath,
  COOLDOWN_SCHEMA,
  COOLDOWN_VERSION,
  MAX_COOLDOWN_BYTES,
  COOLDOWN_CACHE_TTL_MS,
  type CooldownEntry,
  type CooldownLogger,
} from "../src/state/cooldown-store.ts";

let dir: string;
let cooldownPath: string;
let baseNow: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-cool-"));
  cooldownPath = path.join(dir, "cooldown.json");
  baseNow = Date.now();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeCooldownFile(
  entries: Record<string, CooldownEntry>,
  opts: { mode?: number; path?: string } = {},
): void {
  const target = opts.path ?? cooldownPath;
  const mode = opts.mode ?? 0o600;
  const doc = { schema: COOLDOWN_SCHEMA, version: COOLDOWN_VERSION, entries };
  fs.writeFileSync(target, JSON.stringify(doc));
  fs.chmodSync(target, mode);
}

function captureLogger(): { logger: CooldownLogger; warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    logger: {
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    },
  };
}

describe("CooldownStore.readCooldowns — fail-open invariants (AC3, C1)", () => {
  test("returns empty Map when file is missing", () => {
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("returns empty Map when JSON is malformed", () => {
    fs.writeFileSync(cooldownPath, "{not valid json}", { mode: 0o600 });
    fs.chmodSync(cooldownPath, 0o600);
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("returns empty Map when schema is wrong", () => {
    fs.writeFileSync(
      cooldownPath,
      JSON.stringify({ schema: "wrong/schema@1", version: 1, entries: {} }),
    );
    fs.chmodSync(cooldownPath, 0o600);
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("returns empty Map when version is wrong", () => {
    fs.writeFileSync(
      cooldownPath,
      JSON.stringify({ schema: COOLDOWN_SCHEMA, version: 999, entries: {} }),
    );
    fs.chmodSync(cooldownPath, 0o600);
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("returns empty Map when file has group-readable perms (mode 0o640)", () => {
    writeCooldownFile(
      { "kimi/k": { expiresAt: baseNow + 3_600_000, reason: "quota_exhausted", setAt: baseNow } },
      { mode: 0o640 },
    );
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("returns empty Map when file has world-readable perms (mode 0o604)", () => {
    writeCooldownFile(
      { "kimi/k": { expiresAt: baseNow + 3_600_000, reason: "quota_exhausted", setAt: baseNow } },
      { mode: 0o604 },
    );
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("returns empty Map when top-level keys are unexpected", () => {
    fs.writeFileSync(
      cooldownPath,
      JSON.stringify({
        schema: COOLDOWN_SCHEMA,
        version: COOLDOWN_VERSION,
        entries: {},
        malicious_extra: "field",
      }),
    );
    fs.chmodSync(cooldownPath, 0o600);
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("returns empty Map when entry shape is malformed", () => {
    fs.writeFileSync(
      cooldownPath,
      JSON.stringify({
        schema: COOLDOWN_SCHEMA,
        version: COOLDOWN_VERSION,
        entries: {
          "kimi/k": { expiresAt: "not-a-number", reason: "x", setAt: 1 },
        },
      }),
    );
    fs.chmodSync(cooldownPath, 0o600);
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });

  test("rejects duplicate JSON keys (parseStrictJson guard)", () => {
    // Two "schema" keys — parseStrictJson should reject.
    fs.writeFileSync(
      cooldownPath,
      `{"schema":"${COOLDOWN_SCHEMA}","schema":"${COOLDOWN_SCHEMA}","version":1,"entries":{}}`,
    );
    fs.chmodSync(cooldownPath, 0o600);
    const store = new CooldownStore(cooldownPath);
    expect(store.readCooldowns().size).toBe(0);
  });
});

describe("CooldownStore.readCooldowns — happy path + prune (AC4)", () => {
  test("returns entries from valid V1 file", () => {
    writeCooldownFile({
      "kimi/kimi-for-coding": {
        expiresAt: baseNow + 3_600_000,
        reason: "quota_exhausted",
        setAt: baseNow,
      },
    });
    const store = new CooldownStore(cooldownPath);
    const result = store.readCooldowns();
    expect(result.size).toBe(1);
    expect(result.get("kimi/kimi-for-coding")).toEqual({
      expiresAt: baseNow + 3_600_000,
      reason: "quota_exhausted",
      setAt: baseNow,
    });
  });

  test("prunes expired entries on read", () => {
    writeCooldownFile({
      "kimi/expired": { expiresAt: baseNow - 1000, reason: "old", setAt: baseNow - 4000 },
      "openai/live": { expiresAt: baseNow + 3_600_000, reason: "rate_limit", setAt: baseNow },
    });
    const store = new CooldownStore(cooldownPath, { now: () => baseNow });
    const result = store.readCooldowns();
    expect(result.size).toBe(1);
    expect(result.has("openai/live")).toBe(true);
    expect(result.has("kimi/expired")).toBe(false);
  });

  test("returns fresh Map copy (caller mutations do not affect cache)", () => {
    writeCooldownFile({
      "kimi/k": { expiresAt: baseNow + 3_600_000, reason: "x", setAt: baseNow },
    });
    const store = new CooldownStore(cooldownPath);
    const r1 = store.readCooldowns();
    r1.set("mutated/by-caller" as any, { expiresAt: 1, reason: "x", setAt: 1 });
    const r2 = store.readCooldowns();
    expect(r2.has("mutated/by-caller" as any)).toBe(false);
  });
});

describe("CooldownStore.readCooldowns — TTL cache (KD4)", () => {
  test("cache hit within TTL returns same data without re-reading disk", () => {
    let virtualNow = baseNow;
    writeCooldownFile({
      "kimi/k": { expiresAt: virtualNow + 3_600_000, reason: "x", setAt: virtualNow },
    });
    const store = new CooldownStore(cooldownPath, { now: () => virtualNow });
    const r1 = store.readCooldowns();
    expect(r1.size).toBe(1);
    // Delete file; cached read should still return the entry.
    fs.rmSync(cooldownPath);
    const r2 = store.readCooldowns();
    expect(r2.size).toBe(1);
    expect(r2.get("kimi/k")).toEqual(r1.get("kimi/k"));
  });

  test("cache miss after TTL triggers fresh disk read", () => {
    let virtualNow = baseNow;
    writeCooldownFile({
      "kimi/k": { expiresAt: virtualNow + 3_600_000, reason: "x", setAt: virtualNow },
    });
    const store = new CooldownStore(cooldownPath, { now: () => virtualNow });
    store.readCooldowns();
    // Advance past COOLDOWN_CACHE_TTL_MS.
    virtualNow += COOLDOWN_CACHE_TTL_MS + 1;
    fs.rmSync(cooldownPath);
    const result = store.readCooldowns();
    expect(result.size).toBe(0);
  });
});

describe("CooldownStore.persistCooldown — happy path (AC2, AC4)", () => {
  test("persists a single entry then readCooldowns returns it", async () => {
    const store = new CooldownStore(cooldownPath, { now: () => baseNow });
    await store.persistCooldown("kimi/kimi", baseNow + 3_600_000, "quota_exhausted", baseNow);
    const result = store.readCooldowns();
    expect(result.size).toBe(1);
    expect(result.get("kimi/kimi")).toEqual({
      expiresAt: baseNow + 3_600_000,
      reason: "quota_exhausted",
      setAt: baseNow,
    });
  });

  test("creates file on first run when none exists (KD1 realpath:false)", async () => {
    expect(fs.existsSync(cooldownPath)).toBe(false);
    const store = new CooldownStore(cooldownPath);
    await store.persistCooldown("kimi/kimi", baseNow + 3_600_000, "quota_exhausted", baseNow);
    expect(fs.existsSync(cooldownPath)).toBe(true);
    const stat = fs.statSync(cooldownPath);
    expect(stat.mode & 0o077).toBe(0); // owner-only (0600)
  });

  test("writes valid V1 shape with correct schema + version", async () => {
    const store = new CooldownStore(cooldownPath);
    await store.persistCooldown("kimi/kimi", baseNow + 3_600_000, "quota_exhausted", baseNow);
    const text = fs.readFileSync(cooldownPath, "utf-8");
    const parsed = JSON.parse(text);
    expect(parsed.schema).toBe(COOLDOWN_SCHEMA);
    expect(parsed.version).toBe(COOLDOWN_VERSION);
    expect(parsed.entries["kimi/kimi"]).toBeDefined();
  });
});

describe("CooldownStore.persistCooldown — max-merge semantics (AC2)", () => {
  test("distinct model keys: persisting M1 then M2 preserves both", async () => {
    const store = new CooldownStore(cooldownPath);
    await store.persistCooldown("kimi/a", baseNow + 3_600_000, "quota_exhausted", baseNow);
    await store.persistCooldown("openai/b", baseNow + 1_800_000, "rate_limit", baseNow);
    const result = store.readCooldowns();
    expect(result.size).toBe(2);
    expect(result.has("kimi/a")).toBe(true);
    expect(result.has("openai/b")).toBe(true);
  });

  test("same model, second persist has SHORTER expiry: first entry preserved (max-wins)", async () => {
    const store = new CooldownStore(cooldownPath);
    await store.persistCooldown("kimi/k", baseNow + 3_600_000, "quota_exhausted", baseNow);
    await store.persistCooldown("kimi/k", baseNow + 1_800_000, "rate_limit", baseNow);
    const result = store.readCooldowns();
    expect(result.size).toBe(1);
    const entry = result.get("kimi/k");
    expect(entry?.expiresAt).toBe(baseNow + 3_600_000);
    expect(entry?.reason).toBe("quota_exhausted");
  });

  test("same model, second persist has LONGER expiry: second entry wins (max-wins)", async () => {
    const store = new CooldownStore(cooldownPath);
    await store.persistCooldown("kimi/k", baseNow + 1_800_000, "rate_limit", baseNow);
    await store.persistCooldown("kimi/k", baseNow + 3_600_000, "quota_exhausted", baseNow);
    const result = store.readCooldowns();
    const entry = result.get("kimi/k");
    expect(entry?.expiresAt).toBe(baseNow + 3_600_000);
    expect(entry?.reason).toBe("quota_exhausted");
  });

  test("prunes expired entries on write (KD7)", async () => {
    // Seed an already-expired entry directly to disk.
    writeCooldownFile({
      "kimi/expired": { expiresAt: baseNow - 1000, reason: "old", setAt: baseNow - 5000 },
      "kimi/live": { expiresAt: baseNow + 3_600_000, reason: "live", setAt: baseNow },
    });
    const store = new CooldownStore(cooldownPath, { now: () => baseNow });
    await store.persistCooldown("openai/new", baseNow + 3_600_000, "quota_exhausted", baseNow);
    const result = store.readCooldowns();
    expect(result.has("kimi/expired")).toBe(false);
    expect(result.has("kimi/live")).toBe(true);
    expect(result.has("openai/new")).toBe(true);
  });
});

describe("CooldownStore.persistCooldown — lock + concurrent writes (AC2, C2)", () => {
  test("two store instances concurrent persists preserve both entries", async () => {
    const storeA = new CooldownStore(cooldownPath);
    const storeB = new CooldownStore(cooldownPath);
    await Promise.all([
      storeA.persistCooldown("kimi/a", baseNow + 3_600_000, "quota_exhausted", baseNow),
      storeB.persistCooldown("kimi/b", baseNow + 3_600_000, "quota_exhausted", baseNow),
    ]);
    const reader = new CooldownStore(cooldownPath);
    const result = reader.readCooldowns();
    expect(result.has("kimi/a")).toBe(true);
    expect(result.has("kimi/b")).toBe(true);
    expect(result.size).toBe(2);
  });

  test("four concurrent persists all preserve their entries", async () => {
    const stores = [1, 2, 3, 4].map((n) => new CooldownStore(cooldownPath));
    await Promise.all(
      stores.map((s, i) =>
        s.persistCooldown(`kimi/m${i}`, baseNow + 3_600_000, "quota_exhausted", baseNow),
      ),
    );
    const reader = new CooldownStore(cooldownPath);
    const result = reader.readCooldowns();
    expect(result.size).toBe(4);
    expect(result.has("kimi/m0")).toBe(true);
    expect(result.has("kimi/m1")).toBe(true);
    expect(result.has("kimi/m2")).toBe(true);
    expect(result.has("kimi/m3")).toBe(true);
  });
});

describe("CooldownStore.persistCooldown — fail-open invariants (AC3, C1, DONT1)", () => {
  test("persistCooldown never rejects on outer failure (writes to unwritable path)", async () => {
    // /proc is read-only on Linux; cannot create files there.
    const store = new CooldownStore("/proc/cannot-create/cooldown.json");
    await expect(
      store.persistCooldown("k/k", baseNow + 1000, "r", baseNow),
    ).resolves.toBeUndefined();
  });

  test("logger.warn is called when lock acquisition fails", async () => {
    const { logger, warns } = captureLogger();
    const store = new CooldownStore("/proc/cannot-create/cooldown.json", { logger });
    await store.persistCooldown("k/k", baseNow + 1000, "r", baseNow);
    expect(warns.length).toBeGreaterThan(0);
  });

  test("persistCooldown resolves without throwing (smoke for onCompromised wiring)", async () => {
    const { logger } = captureLogger();
    const store = new CooldownStore(cooldownPath, { logger });
    await store.persistCooldown("kimi/k", baseNow + 3_600_000, "quota_exhausted", baseNow);
    expect(fs.existsSync(cooldownPath)).toBe(true);
  });
});

describe("getCooldownPath — path resolution (KD6)", () => {
  test("uses OPENCODE_MODEL_ROUTING_COOLDOWN env override when set", () => {
    const p = getCooldownPath({ OPENCODE_MODEL_ROUTING_COOLDOWN: "/tmp/custom-cooldown.json" });
    expect(p).toBe("/tmp/custom-cooldown.json");
  });

  test("expands ~ in env value", () => {
    const p = getCooldownPath({ OPENCODE_MODEL_ROUTING_COOLDOWN: "~/my-cooldown.json" });
    expect(p).toBe(path.join(os.homedir(), "my-cooldown.json"));
  });

  test("expands bare ~ in env value", () => {
    const p = getCooldownPath({ OPENCODE_MODEL_ROUTING_COOLDOWN: "~" });
    expect(p).toBe(os.homedir());
  });

  test("uses default path when env not set", () => {
    const p = getCooldownPath({});
    expect(p).toBe(
      path.join(os.homedir(), ".local", "share", "opencode-model-routing", "cooldown.json"),
    );
  });

  test("uses default path when env value is empty string", () => {
    const p = getCooldownPath({ OPENCODE_MODEL_ROUTING_COOLDOWN: "" });
    expect(p).toBe(
      path.join(os.homedir(), ".local", "share", "opencode-model-routing", "cooldown.json"),
    );
  });
});

describe("constants", () => {
  test("COOLDOWN_SCHEMA is the V1 string", () => {
    expect(COOLDOWN_SCHEMA).toBe("opencode-model-routing/cooldown@1");
  });

  test("COOLDOWN_VERSION is 1", () => {
    expect(COOLDOWN_VERSION).toBe(1);
  });

  test("MAX_COOLDOWN_BYTES is 16384", () => {
    expect(MAX_COOLDOWN_BYTES).toBe(16384);
  });

  test("COOLDOWN_CACHE_TTL_MS is 2000", () => {
    expect(COOLDOWN_CACHE_TTL_MS).toBe(2000);
  });
});
