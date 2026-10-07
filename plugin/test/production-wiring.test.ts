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
import {
  createPluginContext,
  createPluginHooks,
  PRODUCTION_QUOTA_BOUNDARY,
} from "../src/plugin-internal.ts";
import { resolveProviderReportedBoundary } from "../src/availability/quota-state.ts";
import { createLogger } from "../src/logging/logger.ts";
import type { ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

// Mirrors the optional Hooks.config shape from @opencode-ai/plugin SDK.
type HooksWithConfig = {
  config?: (input: unknown) => unknown | Promise<unknown>;
};

function userMsg(id = "msg-1", agent = "scout") {
  return { info: { id, role: "user", agent }, parts: [] };
}

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
    expect(raw.entries["kimi-for-coding/kimi-for-coding"].reason).toBe(
      "quota_exhausted",
    );
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
    expect(
      ctxB.store.health.isInCooldown(
        "kimi-for-coding/kimi-for-coding" as ModelKey,
      ),
    ).toBe(true);
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

describe("Production init path wires the provider-reported quota boundary", () => {
  test("PRODUCTION_QUOTA_BOUNDARY is the provider-state consumer", () => {
    expect(PRODUCTION_QUOTA_BOUNDARY).toBe(resolveProviderReportedBoundary);
  });

  test("createPluginHooks carries the resolver into the classified-failure path", async () => {
    // Drive the REAL production hook composition with a test resolver; the
    // refresh must fire exactly once per classified quota failure and never
    // on any other event class.
    const consulted: ModelKey[] = [];
    const hooks = await createPluginHooks(
      { client: new MockClient({ messages: [userMsg()] }) } as never,
      // plugin tuple options: chain for the agent the message carries.
      { agents: { scout: { fallback_models: ["a/one", "b/two"] } } },
      {
        quotaBoundary: async (key) => {
          consulted.push(key);
          return Date.now() + 40 * 3_600_000;
        },
      },
    );
    const configHook = (hooks as HooksWithConfig).config;
    if (configHook) await configHook({});

    // Production ordering: a chat.message dispatch records the session's
    // current model, the request's assistant row opens, then a classified
    // failure consults the boundary for it.
    await hooks["chat.message"]?.(
      { sessionID: "s1", agent: "scout" },
      { message: { model: { providerID: "a", modelID: "one" } } },
    );
    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "s1",
          info: {
            id: "assistant-1",
            sessionID: "s1",
            role: "assistant",
            agent: "scout",
            providerID: "a",
            modelID: "one",
          },
        },
      },
    });
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            action: { reason: "free_tier_limit" },
          },
        },
      },
    });

    expect(consulted.length).toBe(1);
  });
});
