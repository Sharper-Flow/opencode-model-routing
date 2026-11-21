import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAvailabilityPreflight } from "../src/availability/preflight.ts";
import type { AvailabilitySnapshotV1 } from "../src/availability/snapshot.ts";
import { createLogger, type Logger } from "../src/logging/logger.ts";
import { loadFallbackChains } from "../src/config/loader.ts";
import {
  applyLoadedChains,
  createPluginContext,
  handleChatMessage,
} from "../src/plugin-internal.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";
import { applyPreemptiveSkip, applyResumeReturn } from "../src/preemptive.ts";
import { MockClient } from "./helpers/mock-client.ts";

const T0 = 1_800_000_000_000;
const silentLogger = createLogger({ minLevel: "error", write: () => {} });

function unavailableSnapshot(
  overrides: Partial<AvailabilitySnapshotV1> = {},
): AvailabilitySnapshotV1 {
  return {
    schema: "opencode-claude-max/availability@1",
    version: 1,
    generated_at: new Date(T0).toISOString(),
    state: "unavailable",
    accounts: { configured: 2, enabled: 2, usable: 0 },
    retry_at: T0 + 300_000,
    marker: "CLAUDE_MAX_UNAVAILABLE",
    ...overrides,
  };
}

function availableSnapshot(): AvailabilitySnapshotV1 {
  return {
    schema: "opencode-claude-max/availability@1",
    version: 1,
    generated_at: new Date(T0).toISOString(),
    state: "available",
    accounts: { configured: 2, enabled: 2, usable: 2 },
    retry_at: null,
  };
}

function output(providerID: string, modelID: string) {
  return { message: { model: { providerID, modelID } } };
}

function userMsg(id = "msg-1", agent = "scout") {
  return { info: { id, role: "user", agent }, parts: [] };
}

describe("applyAvailabilityPreflight", () => {
  test("degraded policy excludes Claude from preemptive scans", () => {
    const snapshot = unavailableSnapshot({
      state: "degraded",
      accounts: { configured: 2, enabled: 2, usable: 1 },
      retry_at: null,
      marker: undefined,
    });
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "openai/gpt-5", "google/gemini"]],
    ]);
    const store = new FallbackStore();
    const out = output("openai", "gpt-5");
    applyPreemptiveSkip(
      {
        sessionId: "scan",
        agentName: "scout",
        output: out,
        snapshot,
        fallbackOnClaudeDegraded: true,
      },
      store,
      chains,
      defaultConfig,
      silentLogger,
      new Map([["scout", new Set<ModelKey>(["openai/gpt-5"])]]),
    );
    expect(out.message.model.providerID).toBe("google");
  });
  test("degraded policy prevents resume return to Claude", () => {
    const snapshot = unavailableSnapshot({
      state: "degraded",
      accounts: { configured: 2, enabled: 2, usable: 1 },
      retry_at: null,
      marker: undefined,
    });
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "openai/gpt-5"]],
    ]);
    const store = new FallbackStore();
    const resumed = output("openai", "gpt-5");
    const returned = applyResumeReturn(
      {
        sessionId: "resume",
        agentName: "scout",
        output: resumed,
        snapshot,
        fallbackOnClaudeDegraded: true,
        marker: {
          served: "openai/gpt-5",
          original: "anthropic/claude",
          at: T0,
        },
      },
      store,
      chains,
      silentLogger,
    );
    expect(returned).toBe(false);
    expect(resumed.message.model.providerID).toBe("openai");
  });
  test("fresh unavailable + anthropic selection → first healthy non-anthropic chain entry", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      [
        "scout",
        [
          "anthropic/claude-sonnet-4-5",
          "openai/gpt-5",
          "google/gemini-2.5-pro",
        ],
      ],
    ]);
    const out = output("anthropic", "claude-sonnet-4-5");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
  });

  test("skips cooled and anthropic entries when picking the fallback", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("openai/gpt-5" as ModelKey, 60_000);
    const chains = new Map<string, ModelKey[]>([
      [
        "scout",
        [
          "anthropic/claude-sonnet-4-5",
          "openai/gpt-5",
          "google/gemini-2.5-pro",
        ],
      ],
    ]);
    const out = output("anthropic", "claude-sonnet-4-5");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({
      providerID: "google",
      modelID: "gemini-2.5-pro",
    });
  });

  test("chain with only anthropic entries → no-op", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4"]],
    ]);
    const out = output("anthropic", "claude-sonnet-4-5");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  test("non-anthropic selection + unavailable snapshot → no-op (non-Claude preserved)", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["z/glm-4.6", "openai/gpt-5"]],
    ]);
    const out = output("z", "glm-4.6");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({ providerID: "z", modelID: "glm-4.6" });
  });

  test("null snapshot → no-op", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "openai/gpt-5"]],
    ]);
    const out = output("anthropic", "claude");
    applyAvailabilityPreflight(
      { sessionId: "s1", agentName: "scout", output: out, snapshot: null },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });
  });

  test("available-state snapshot → no-op", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "openai/gpt-5"]],
    ]);
    const out = output("anthropic", "claude");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        snapshot: availableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });
  });

  test("missing agentName / chain / model → no-op", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "openai/gpt-5"]],
    ]);
    const out = output("anthropic", "claude");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: null,
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });

    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "no-chain",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });

    const noModel: {
      message: { model?: { providerID: string; modelID: string } };
    } = { message: {} };
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: noModel,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(noModel.message.model).toBeUndefined();
  });

  test("redirect records session currentModel", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "openai/gpt-5"]],
    ]);
    const out = output("anthropic", "claude");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      silentLogger,
    );
    expect(store.sessions.get("s1").currentModel).toBe("openai/gpt-5");
  });

  test("availability logs carry only fixed event, correlation id, kind, retry timestamp", () => {
    const lines: string[] = [];
    const logger: Logger = createLogger({
      minLevel: "debug",
      write: (l) => lines.push(l),
    });
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "openai/gpt-5"]],
    ]);
    const out = output("anthropic", "claude");
    applyAvailabilityPreflight(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      logger,
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        expect([
          "ts",
          "level",
          "plugin",
          "event",
          "sessionId",
          "availability",
          "retryAt",
        ]).toContain(key);
      }
      expect(record.event).toBe("availability.preflight_redirected");
      expect(record.sessionId).toBe("s1");
      expect(record.availability).toBe("unavailable");
      expect(record.retryAt).toBe(T0 + 300_000);
    }
  });
});

describe("chat.message preflight integration (descriptor-bound reader + redirect)", () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omr-preflight-"));
    savedEnv = process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY;
    } else {
      process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = savedEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSnapshot(doc: unknown, mode = 0o600): string {
    const p = join(dir, "availability.json");
    writeFileSync(p, JSON.stringify(doc));
    chmodSync(p, mode);
    process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = p;
    return p;
  }

  function freshUnavailable(): Record<string, unknown> {
    const now = Date.now();
    return {
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date(now).toISOString(),
      state: "unavailable",
      accounts: { configured: 2, enabled: 2, usable: 0 },
      retry_at: now + 300_000,
      marker: "CLAUDE_MAX_UNAVAILABLE",
    };
  }

  test("degraded availability redirects only opted-in agents without cooling Claude", async () => {
    writeSnapshot({
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date().toISOString(),
      state: "degraded",
      accounts: { configured: 2, enabled: 2, usable: 1 },
      retry_at: null,
    });
    const ctx = createPluginContext({ logger: silentLogger });
    applyLoadedChains(
      ctx,
      loadFallbackChains({}, silentLogger, {
        agents: {
          opted: {
            fallback_models: ["anthropic/claude", "openai/gpt-5"],
            fallback_on_claude_degraded: true,
          },
          other: { fallback_models: ["anthropic/claude", "openai/gpt-5"] },
        },
      }),
    );
    const opted = output("anthropic", "claude");
    await handleChatMessage(
      ctx,
      new MockClient(),
      { sessionID: "opted", agent: "opted" },
      opted,
    );
    expect(opted.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    const other = output("anthropic", "claude");
    await handleChatMessage(
      ctx,
      new MockClient(),
      { sessionID: "other", agent: "other" },
      other,
    );
    expect(other.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude",
    });
    expect(ctx.store.health.isInCooldown("anthropic/claude")).toBe(false);
    ctx.ttft.clear("opted");
    ctx.ttft.clear("other");
  });

  test("strict opt-in and fresh valid degraded snapshot are required", async () => {
    const degraded = {
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date().toISOString(),
      state: "degraded",
      accounts: { configured: 2, enabled: 2, usable: 1 },
      retry_at: null,
    };
    const agents = {
      yes: {
        fallback_models: ["anthropic/claude", "openai/gpt-5"],
        fallback_on_claude_degraded: true,
      },
      no: {
        fallback_models: ["anthropic/claude", "openai/gpt-5"],
        fallback_on_claude_degraded: false,
      },
      string: {
        fallback_models: ["anthropic/claude", "openai/gpt-5"],
        fallback_on_claude_degraded: "true",
      },
    };
    const ctx = createPluginContext({ logger: silentLogger });
    applyLoadedChains(ctx, loadFallbackChains({}, silentLogger, { agents }));
    for (const [name, doc, mode, redirected] of [
      ["yes", degraded, 0o600, true],
      ["no", degraded, 0o600, false],
      ["string", degraded, 0o600, false],
      [
        "yes",
        {
          ...degraded,
          state: "available",
          accounts: { configured: 2, enabled: 1, usable: 1 },
        },
        0o600,
        false,
      ],
      [
        "yes",
        {
          ...degraded,
          generated_at: new Date(Date.now() - 120_000).toISOString(),
        },
        0o600,
        false,
      ],
      ["yes", { ...degraded, version: 2 }, 0o600, false],
      ["yes", degraded, 0o644, false],
    ] as const) {
      writeSnapshot(doc, mode);
      const sessionID = `matrix-${name}-${Math.random()}`;
      const out = output("anthropic", "claude");
      await handleChatMessage(
        ctx,
        new MockClient(),
        { sessionID, agent: name },
        out,
      );
      expect(out.message.model.providerID).toBe(
        redirected ? "openai" : "anthropic",
      );
      ctx.ttft.clear(sessionID);
    }
  });

  test("fresh valid unavailable snapshot redirects anthropic before dispatch; zero fallback SDK calls", async () => {
    writeSnapshot(freshUnavailable());
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    // AC3: preflight redirect starts no Claude child attempt — no replay SDK
    // calls at all (only the agent-resolution messages read may occur).
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    ctx.ttft.clear("s1");
  });

  test("unavailable fallback never redirects onto a blocked configured primary", async () => {
    writeSnapshot(freshUnavailable());
    const ctx = createPluginContext({ logger: silentLogger });
    applyLoadedChains(
      ctx,
      loadFallbackChains(
        { agent: { scout: { model: "openai/gpt-5" } } },
        silentLogger,
        {
          agents: {
            scout: {
              fallback_models: ["anthropic/claude-sonnet-4-5"],
              blocked_models: ["openai/gpt-5"],
            },
          },
        },
      ),
    );
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(
      ctx,
      new MockClient(),
      { sessionID: "blocked-primary", agent: "scout" },
      out,
    );
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  test("availability preflight respects routing disabled by maxDepth zero", async () => {
    writeSnapshot(freshUnavailable());
    const ctx = createPluginContext({
      logger: silentLogger,
      config: { maxDepth: 0 },
    });
    ctx.chains.set("scout", ["openai/gpt-5", "anthropic/claude-sonnet-4-5"]);
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(
      ctx,
      new MockClient(),
      { sessionID: "disabled", agent: "scout" },
      out,
    );
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  test("fresh hook agent redirects unavailable Anthropic selection with empty history", async () => {
    writeSnapshot(freshUnavailable());
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("adv-engineer", [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
    const client = new MockClient({ messages: [] });
    const out = output("anthropic", "claude-sonnet-4-5");

    await handleChatMessage(
      ctx,
      client,
      { sessionID: "fresh-agent", agent: "adv-engineer" },
      out,
    );

    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    expect(client.callsTo("session.messages")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    ctx.ttft.clear("fresh-agent");
  });

  test("missing snapshot → no-op", async () => {
    process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = join(dir, "absent.json");
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    ctx.ttft.clear("s1");
  });

  test("stale snapshot (past retry_at) → no-op", async () => {
    const now = Date.now();
    writeSnapshot({
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date(now - 120_000).toISOString(),
      state: "unavailable",
      accounts: { configured: 2, enabled: 2, usable: 0 },
      retry_at: now - 60_000,
      marker: "CLAUDE_MAX_UNAVAILABLE",
    });
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    ctx.ttft.clear("s1");
  });

  test("wrong-permission snapshot → no-op", async () => {
    writeSnapshot(freshUnavailable(), 0o644);
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    ctx.ttft.clear("s1");
  });

  test("malformed snapshot → no-op", async () => {
    const p = join(dir, "availability.json");
    writeFileSync(p, '{"schema":"opencode-claude-max/availability@1",');
    chmodSync(p, 0o600);
    process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = p;
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    ctx.ttft.clear("s1");
  });

  test("unknown-version snapshot → no-op", async () => {
    writeSnapshot({ ...freshUnavailable(), version: 2 });
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    ctx.ttft.clear("s1");
  });

  test("non-anthropic selection with fresh unavailable snapshot → unchanged (SC4)", async () => {
    writeSnapshot(freshUnavailable());
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["z/glm-4.6", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("z", "glm-4.6");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({ providerID: "z", modelID: "glm-4.6" });
    ctx.ttft.clear("s1");
  });

  test("fresh available snapshot → unchanged", async () => {
    writeSnapshot({
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date().toISOString(),
      state: "available",
      accounts: { configured: 2, enabled: 2, usable: 2 },
      retry_at: null,
    });
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = output("anthropic", "claude-sonnet-4-5");
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    ctx.ttft.clear("s1");
  });
});
