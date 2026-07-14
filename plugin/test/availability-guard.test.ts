import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  handleChatMessage,
  handleEvent,
  handleTtftTimeout,
} from "../src/plugin-internal.ts";
import type { ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

function userMsg(id = "msg-1", agent = "scout") {
  return { info: { id, role: "user", agent }, parts: [] };
}

function freshUnavailableDoc(): Record<string, unknown> {
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

function freshAvailableDoc(): Record<string, unknown> {
  return {
    schema: "opencode-claude-max/availability@1",
    version: 1,
    generated_at: new Date().toISOString(),
    state: "available",
    accounts: { configured: 2, enabled: 2, usable: 2 },
    retry_at: null,
  };
}

function rateLimitError() {
  return {
    type: "session.error",
    properties: {
      sessionID: "s1",
      error: { name: "APIError", data: { statusCode: 429, isRetryable: false } },
    },
  };
}

function retryStatus() {
  return {
    type: "session.status",
    properties: {
      sessionID: "s1",
      status: { type: "retry" as const, message: "rate limited", action: { reason: "account_rate_limit" } },
    },
  };
}

// AC4: on confirmed mid-task exhaustion the replay path performs ZERO SDK
// calls — including the agent-resolution session.messages read, which only
// happens if the guard failed to run before resolveAgentName.
function expectNoSdkCalls(client: MockClient) {
  expect(client.callsTo("session.messages")).toHaveLength(0);
  expect(client.callsTo("session.abort")).toHaveLength(0);
  expect(client.callsTo("session.revert")).toHaveLength(0);
  expect(client.callsTo("session.prompt")).toHaveLength(0);
}

describe("availability exhaustion guard — detached replay entrances", () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omr-guard-"));
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

  function absentSnapshot(): void {
    process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = join(dir, "absent.json");
  }

  // Session whose tracked current model is Anthropic/Claude, with a mixed
  // chain so an unsuppressed fallback has somewhere to go.
  function anthropicCtx(chain: ModelKey[] = ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]) {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", chain);
    ctx.store.sessions.get("s1").currentModel = "anthropic/claude-sonnet-4-5";
    return ctx;
  }

  test("session.error entrance: fresh unavailable + anthropic → suppress, zero SDK calls", async () => {
    writeSnapshot(freshUnavailableDoc());
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    expectNoSdkCalls(client);
    expect(ctx.guard.isSuppressed("s1")).toBe(true);
    expect(ctx.store.sessions.get("s1").currentModel).toBe("anthropic/claude-sonnet-4-5");
  });

  test("session.status retry entrance: fresh unavailable + anthropic → suppress, zero SDK calls", async () => {
    writeSnapshot(freshUnavailableDoc());
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, retryStatus());
    expectNoSdkCalls(client);
    expect(ctx.guard.isSuppressed("s1")).toBe(true);
  });

  test("TTFT timer entrance: fresh unavailable + anthropic → suppress, zero SDK calls after arm", async () => {
    writeSnapshot(freshUnavailableDoc());
    // All-anthropic chain → preflight cannot redirect, so the turn stays on
    // Claude and the mid-turn TTFT timeout is the first replay entrance.
    const ctx = createPluginContext({ logger: silentLogger, config: { ttftMs: 10 } });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = { message: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } };
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(out.message.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
    expect(ctx.ttft.has("s1")).toBe(true);
    const baseline = client.calls.length; // agent-resolution messages read only
    await new Promise((r) => setTimeout(r, 80));
    expect(client.calls.length).toBe(baseline);
    expect(ctx.guard.isSuppressed("s1")).toBe(true);
    ctx.ttft.clear("s1");
  });

  test("recorded per-turn guard cannot be bypassed by retry or TTFT after the snapshot flips", async () => {
    writeSnapshot(freshUnavailableDoc());
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    expect(ctx.guard.isSuppressed("s1")).toBe(true);
    // Producer publishes recovery mid-turn: the recorded guard still owns the
    // rest of this turn — retry status and TTFT must not start a replay.
    writeSnapshot(freshAvailableDoc());
    await handleEvent(ctx, client, retryStatus());
    await handleTtftTimeout(ctx, client, "s1", "scout");
    expectNoSdkCalls(client);
    expect(ctx.guard.isSuppressed("s1")).toBe(true);
  });

  test("next chat.message clears the per-turn guard → normal fallback resumes", async () => {
    writeSnapshot(freshUnavailableDoc());
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    expect(ctx.guard.isSuppressed("s1")).toBe(true);
    // Next valid user turn (snapshot now reports available again).
    writeSnapshot(freshAvailableDoc());
    const out = { message: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } };
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(ctx.guard.isSuppressed("s1")).toBe(false);
    await handleEvent(ctx, client, rateLimitError());
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    expect(ctx.store.sessions.get("s1").currentModel).toBe("openai/gpt-5");
    ctx.ttft.clear("s1");
  });

  test("suppression clears an armed TTFT timer (mid-task exhaustion landing after a healthy start)", async () => {
    absentSnapshot(); // healthy start: no snapshot at chat.message time
    const ctx = createPluginContext({ logger: silentLogger, config: { ttftMs: 60_000 } });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    const client = new MockClient({ messages: [userMsg()] });
    const out = { message: { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } };
    await handleChatMessage(ctx, client, { sessionID: "s1" }, out);
    expect(ctx.ttft.has("s1")).toBe(true);
    const baseline = client.calls.length;
    // Claude Max exhausts mid-task and publishes the unavailable snapshot.
    writeSnapshot(freshUnavailableDoc());
    await handleEvent(ctx, client, rateLimitError());
    expect(ctx.ttft.has("s1")).toBe(false);
    expect(ctx.guard.isSuppressed("s1")).toBe(true);
    expect(client.calls.length).toBe(baseline);
    ctx.ttft.clear("s1");
  });

  test("missing snapshot → normal fallback (C4 no-op)", async () => {
    absentSnapshot();
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    expect(ctx.guard.isSuppressed("s1")).toBe(false);
  });

  test("stale snapshot (past retry_at) → normal fallback", async () => {
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
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(ctx.guard.isSuppressed("s1")).toBe(false);
  });

  test("malformed snapshot → normal fallback", async () => {
    const p = join(dir, "availability.json");
    writeFileSync(p, '{"schema":"opencode-claude-max/availability@1",');
    chmodSync(p, 0o600);
    process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = p;
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(ctx.guard.isSuppressed("s1")).toBe(false);
  });

  test("fresh unavailable + non-anthropic current → normal fallback (SC4/AC6 unchanged)", async () => {
    writeSnapshot(freshUnavailableDoc());
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["z/glm-4.6", "openai/gpt-5"]);
    ctx.store.sessions.get("s1").currentModel = "z/glm-4.6";
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    expect(ctx.store.sessions.get("s1").currentModel).toBe("openai/gpt-5");
    expect(ctx.guard.isSuppressed("s1")).toBe(false);
  });

  test("MessageAbortedError user cancellation: unchanged, guard never records", async () => {
    writeSnapshot(freshUnavailableDoc());
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } },
      },
    });
    expectNoSdkCalls(client);
    expect(ctx.guard.isSuppressed("s1")).toBe(false);
    expect(ctx.store.sessions.get("s1").currentModel).toBe("anthropic/claude-sonnet-4-5");
    expect(ctx.store.health.isInCooldown("anthropic/claude-sonnet-4-5" as ModelKey)).toBe(false);
  });

  test("error text never authorizes suppression (DONT3): marker string without snapshot → fallback runs", async () => {
    absentSnapshot();
    const ctx = anthropicCtx();
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: {
          name: "APIError",
          data: { statusCode: 429, message: "CLAUDE_MAX_UNAVAILABLE: all accounts exhausted" },
        },
      },
    });
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    expect(ctx.guard.isSuppressed("s1")).toBe(false);
  });

  test("AC7: suppression log carries only fixed event, correlation id, kind, retry timestamp — and logs once per turn", async () => {
    writeSnapshot(freshUnavailableDoc());
    const lines: string[] = [];
    const logger = createLogger({ minLevel: "debug", write: (l) => lines.push(l) });
    const ctx = createPluginContext({ logger });
    ctx.chains.set("scout", ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
    ctx.store.sessions.get("s1").currentModel = "anthropic/claude-sonnet-4-5";
    const client = new MockClient({ messages: [userMsg()] });
    await handleEvent(ctx, client, rateLimitError());
    await handleEvent(ctx, client, retryStatus()); // idempotent: no second log
    const suppressed = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.event === "availability.replay_suppressed");
    expect(suppressed).toHaveLength(1);
    const record = suppressed[0]!;
    for (const key of Object.keys(record)) {
      expect(["ts", "level", "plugin", "event", "sessionId", "availability", "retryAt"]).toContain(key);
    }
    expect(record.sessionId).toBe("s1");
    expect(record.availability).toBe("unavailable");
    expect(typeof record.retryAt).toBe("number");
  });
});
