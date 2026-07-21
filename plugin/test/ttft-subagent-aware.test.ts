// Tests for subagent-aware TTFT handler + KD8 await in attemptFallback.
//
// Verifies:
//   - handleTtftTimeout now passes isSubagent to attemptFallback (Part 2)
//   - attemptFallback awaits cooldown() persist settle before dispatching
//     the replacement spawn (KD8)
//
// RED/GREEN target for ADV task tk-02813db935e2 (TDD inline).

import { describe, test, expect } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  handleTtftTimeout,
} from "../src/plugin-internal.ts";
import { attemptFallback } from "../src/replay/orchestrator.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

function userMsg(id = "msg-1", agent = "scout") {
  return {
    info: { id, role: "user", agent },
    parts: [{ type: "text", text: "hello" }],
  };
}

// ---------------------------------------------------------------------------
// handleTtftTimeout — subagent-aware routing (Part 2).
// ---------------------------------------------------------------------------

describe("handleTtftTimeout — subagent-aware (Part 2, AC5)", () => {
  test("subagent session (parentID present) → short-circuit: NO messages/abort/revert/prompt", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    // MockClient returns a session with parentID → detectSubagent returns true.
    const client = new MockClient({
      messages: [userMsg()],
      sessionInfo: { parentID: "parent-session-1" },
    });

    await handleTtftTimeout(ctx, client, "s1", "scout");

    // detectSubagent fires session.get once.
    expect(client.callsTo("session.get")).toHaveLength(1);
    // Subagent short-circuit: NO recovery SDK calls.
    expect(client.callsTo("session.messages")).toHaveLength(0);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    // Cooldown WAS set on the failing model.
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });

  test("primary session (no parentID) → full recovery: messages/abort/revert/prompt", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    // MockClient returns a session with no parentID → detectSubagent returns false.
    const client = new MockClient({
      messages: [userMsg()],
      sessionInfo: {}, // no parentID
    });

    await handleTtftTimeout(ctx, client, "s1", "scout");

    // detectSubagent fires session.get once.
    expect(client.callsTo("session.get")).toHaveLength(1);
    // Full recovery path.
    expect(client.callsTo("session.messages")).toHaveLength(1);
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.revert")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    // Cooldown set on failing model.
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });

  test("detectSubagent throws (session.get error) → treated as primary (EC5)", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      getError: new Error("session.get failed (half-dead session)"),
    });

    await handleTtftTimeout(ctx, client, "s1", "scout");

    // EC5 mitigation: detectSubagent catches and returns false → primary path.
    expect(client.callsTo("session.get")).toHaveLength(1);
    expect(client.callsTo("session.messages")).toHaveLength(1);
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.revert")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });

  test("subagent detection is cached across TTFT retries on same session", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      sessionInfo: { parentID: "parent-1" },
    });

    await handleTtftTimeout(ctx, client, "s1", "scout");
    await handleTtftTimeout(ctx, client, "s1", "scout");

    // Second call: cached isSubagent=true, no second session.get.
    expect(client.callsTo("session.get")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// attemptFallback — KD8: await cooldown persist before dispatch.
// ---------------------------------------------------------------------------

describe("attemptFallback — KD8 await before dispatch (AC5, AC1)", () => {
  test("does NOT call prompt until cooldown persist promise resolves", async () => {
    // Construct a store with a fake cooldownStore whose persistCooldown
    // returns an unresolved promise we control.
    let resolvePersist: () => void = () => {};
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const persistCalls: Array<{ key: ModelKey; expiresAt: number }> = [];
    const fakeStore = {
      persistCooldown: async (
        key: ModelKey,
        expiresAt: number,
      ): Promise<void> => {
        persistCalls.push({ key, expiresAt });
        await persistPromise;
      },
      readCooldowns: () => new Map(),
    };
    const store = new FallbackStore(() => Date.now(), fakeStore as any);
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    // Kick off attemptFallback but don't await yet — it should stall at
    // the cooldown await before dispatching prompt.
    const fallbackPromise = attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain: ["a/one", "b/two"],
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    // Yield to the microtask queue so attemptFallback can run up to the
    // await on the persist promise.
    await new Promise((r) => setTimeout(r, 10));

    // Pre-resolve: persist was called, but prompt has NOT been dispatched.
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]?.key).toBe("a/one");
    expect(client.callsTo("session.prompt")).toHaveLength(0);

    // Release the persist; fallback should now proceed to prompt.
    resolvePersist();
    await fallbackPromise;

    expect(client.callsTo("session.prompt")).toHaveLength(1);
  });

  test("prompt still dispatches when persist promise rejects (fail-open)", async () => {
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {
        throw new Error("simulated persist failure");
      },
      readCooldowns: () => new Map(),
    };
    const store = new FallbackStore(() => Date.now(), fakeStore as any);
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    // Should NOT throw — fail-open swallows the rejection inside cooldown().
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain: ["a/one", "b/two"],
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
  });

  test("subagent short-circuit also awaits persist before returning (KD8 covers subagent path)", async () => {
    let resolvePersist: () => void = () => {};
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const fakeStore = {
      persistCooldown: async (): Promise<void> => {
        await persistPromise;
      },
      readCooldowns: () => new Map(),
    };
    const store = new FallbackStore(() => Date.now(), fakeStore as any);
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    const fallbackPromise = attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain: ["a/one", "b/two"],
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      isSubagent: true,
      sleepMs: async () => {},
    });

    await new Promise((r) => setTimeout(r, 10));
    // Pre-resolve: result not returned yet (subagent short-circuit awaits persist).
    // We can't easily check "not returned" without a flag, so just verify the
    // call hasn't released the lock by checking that another lock-acquire fails.
    // Actually: subagent path holds the lock until return. Easier check: verify
    // fallbackPromise is still pending.
    let resolved = false;
    fallbackPromise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);

    resolvePersist();
    await fallbackPromise;
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: handleTtftTimeout behavior unchanged for non-subagent cases
// without cooldownStore (DONT2).
// ---------------------------------------------------------------------------

describe("handleTtftTimeout — regression (no cooldownStore, DONT2)", () => {
  test("primary session without cooldownStore behaves as before: full recovery", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set("scout", ["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      sessionInfo: {},
    });

    await handleTtftTimeout(ctx, client, "s1", "scout");

    expect(client.callsTo("session.messages")).toHaveLength(1);
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.revert")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });
});
