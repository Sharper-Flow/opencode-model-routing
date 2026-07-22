// Production init path wiring tests.
//
// These tests drive the REAL createPluginContext() production entry (not an
// injected mock) and assert that a CooldownStore is wired so cooldown state
// persists to the file store. This is the regression guard for the
// "shipped-but-unwired" defect class: addPersistentCrossProcess shipped the
// CooldownStore behind optional injection, but the production entry never
// instantiated it → tree-shaken out → cross-process persistence dead.
//
// RED on current main: createPluginContext() does new FallbackStore() with no
// cooldownStore → cooldown stays in-memory → no file created → test fails.
// GREEN after wiring: createPluginContext() constructs new CooldownStore() →
// cooldown persists to file → test passes.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginContext } from "../src/plugin-internal.ts";
import { createLogger } from "../src/logging/logger.ts";
import type { ModelKey } from "../src/types.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

let dir: string;
let cooldownPath: string;
let origEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-prodwire-"));
  cooldownPath = path.join(dir, "cooldown.json");
  origEnv = process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = cooldownPath;
});

afterEach(() => {
  if (origEnv === undefined) delete process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  else process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = origEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Production init path wires CooldownStore (AC2)", () => {
  test("createPluginContext() persists cooldown to file via real init path", async () => {
    // The REAL production entry — not an injected mock.
    const ctx = createPluginContext({ logger: silentLogger });

    // Trigger a cooldown as the fallover path would (quota_exhausted, 1h).
    await ctx.store.health.cooldown(
      "kimi-for-coding/kimi-for-coding" as ModelKey,
      60 * 60_000,
      "quota_exhausted",
    );

    // If CooldownStore is wired, the file must exist on disk.
    expect(fs.existsSync(cooldownPath)).toBe(true);

    // And contain the expected entry with correct schema + reason.
    const raw = JSON.parse(fs.readFileSync(cooldownPath, "utf-8"));
    expect(raw.schema).toBe("opencode-model-routing/cooldown@1");
    expect(raw.entries["kimi-for-coding/kimi-for-coding"]).toBeDefined();
    expect(raw.entries["kimi-for-coding/kimi-for-coding"].reason).toBe("quota_exhausted");
  });

  test("fresh createPluginContext() reads persisted cooldown (cross-process read-through)", async () => {
    // Process A: write cooldown via real init path — await the persist
    // (KD8 ordering: persist settles before dependent reads).
    const ctxA = createPluginContext({ logger: silentLogger });
    await ctxA.store.health.cooldown(
      "kimi-for-coding/kimi-for-coding" as ModelKey,
      60 * 60_000,
      "quota_exhausted",
    );
    expect(fs.existsSync(cooldownPath)).toBe(true);

    // Process B: fresh context — should see the cooldown via read-through
    // (in-memory Map is empty in the fresh context, so isInCooldown must
    // consult the persistent file store).
    const ctxB = createPluginContext({ logger: silentLogger });
    expect(ctxB.store.health.isInCooldown("kimi-for-coding/kimi-for-coding" as ModelKey)).toBe(true);
  });

  test("fail-open: missing cooldown directory does not throw on init", () => {
    // Point at a path in a non-existent directory — construction must not throw
    // and cooldown must still work (in-memory fallback).
    const badPath = path.join(dir, "nonexistent-subdir", "cooldown.json");
    process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = badPath;
    const ctx = createPluginContext({ logger: silentLogger });
    // Construction succeeded — no throw. In-memory cooldown still works.
    expect(ctx.store.health.isInCooldown("any/model" as ModelKey)).toBe(false);
  });
});
