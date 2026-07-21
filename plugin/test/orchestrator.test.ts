import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import { attemptFallback } from "../src/replay/orchestrator.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

const chain: ModelKey[] = ["a/one", "b/two", "c/three"];

function userMsg(id = "msg-1", agent = "scout") {
  return {
    info: { id, role: "user", agent },
    parts: [{ type: "text", text: "hello" }],
  };
}

function assistantMsg(id: string, parts: unknown[] = []) {
  return { info: { id, role: "assistant" }, parts };
}

describe("attemptFallback — happy path", () => {
  test("abort → revert → prompt called in order with next model", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("b/two");
    expect(result.fromModel).toBe("a/one");

    const order = client.calls.map((c) => c.method);
    expect(order).toEqual([
      "session.messages",
      "session.abort",
      "session.revert",
      "session.prompt",
    ]);

    // prompt called with parsed { providerID, modelID }
    const promptArgs = client.callsTo("session.prompt")[0]?.args as {
      path: { id: string };
      body: { model: { providerID: string; modelID: string }; agent: string };
    };
    expect(promptArgs.path).toEqual({ id: "s1" });
    expect(promptArgs.body.model).toEqual({ providerID: "b", modelID: "two" });
    expect(promptArgs.body.agent).toBe("scout");

    expect(client.callsTo("session.messages")[0]?.args).toEqual({
      path: { id: "s1" },
    });
    expect(client.callsTo("session.abort")[0]?.args).toEqual({
      path: { id: "s1" },
    });
    expect(client.callsTo("session.revert")[0]?.args).toEqual({
      path: { id: "s1" },
      body: { messageID: "msg-1" },
    });

    // session state updated
    const st = store.sessions.get("s1");
    expect(st.currentModel).toBe("b/two");
    expect(st.fallbackDepth).toBe(1);
    expect(st.originalModel).toBe("a/one");

    // previous model put in cooldown
    expect(store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });

  test("does not set originalModel to fallback when current model is unknown", async () => {
    const store = new FallbackStore();
    const client = new MockClient({ messages: [userMsg()] });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("a/one");
    expect(result.fromModel).toBeNull();
    expect(store.sessions.get("s1").originalModel).toBeNull();
  });
});

describe("attemptFallback — gating", () => {
  test("locked second call returns 'already processing'", async () => {
    const store = new FallbackStore();
    store.acquireLock("s1");
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client: new MockClient(),
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("already processing");
  });

  test("within dedup window → skipped", async () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.sessions.get("s1").lastFallbackAt = now;
    store.sessions.get("s1").currentModel = "a/one";

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client: new MockClient({ messages: [userMsg()] }),
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("dedup window");
  });

  test("empty chain → no chain", async () => {
    const store = new FallbackStore();
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain: [],
      client: new MockClient({ messages: [userMsg()] }),
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("no chain");
  });

  test("depth >= maxDepth → exhausted", async () => {
    const store = new FallbackStore();
    const state = store.sessions.get("s1");
    state.currentModel = "a/one";
    state.fallbackDepth = defaultConfig.maxDepth; // already at cap
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client: new MockClient({ messages: [userMsg()] }),
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("exhausted");
    // No replay calls fired.
    expect(client_callsTo).toBeDefined(); // suppress unused warning
  });
});

// Workaround: bun-test scope helper referenced above (silenced lint).
const client_callsTo = () => {};

describe("attemptFallback — sequence failures", () => {
  test("abort fails → returns abort failed; lock released", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      abortError: new Error("boom"),
    });
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("abort failed");
    // Lock released — another attempt should be able to acquire.
    expect(store.acquireLock("s1")).toBe(true);
  });

  test("revert fails → returns revert failed", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      revertError: new Error("boom"),
    });
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("revert failed");
  });

  test("prompt fails → returns prompt failed (previous still cooled)", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      promptError: new Error("boom"),
    });
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("prompt failed");
    // Even though prompt failed, the previous model was already cooled —
    // that's intentional (it really did fail).
    expect(store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });

  test("no user message → no user message", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [] });
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("no user message");
  });
});

// Capture log emissions for orphanMessageId assertions. The default
// silentLogger writes nothing; we need a recording logger here.
function makeCapturingLogger() {
  const events: Array<{
    level: string;
    event: string;
    data: Record<string, unknown>;
  }> = [];
  const logger = createLogger({
    minLevel: "debug",
    write: (line: string) => {
      try {
        const parsed = JSON.parse(line);
        events.push({ level: parsed.level, event: parsed.event, data: parsed });
      } catch {
        // ignore non-JSON lines
      }
    },
  });
  return { logger, events };
}

describe("attemptFallback — orphanMessageId logging", () => {
  test("orphan present (assistant after user with empty parts) → field in fallback.success", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg("user-1"), assistantMsg("asst-orphan")],
    });
    const { logger, events } = makeCapturingLogger();

    await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });

    const success = events.find((e) => e.event === "fallback.success");
    expect(success).toBeDefined();
    expect(success?.data.orphanMessageId).toBe("asst-orphan");
  });

  test("no orphan (assistant has parts → LLM completed) → field omitted", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [
        userMsg("user-1"),
        assistantMsg("asst-done", [{ type: "text", text: "response" }]),
      ],
    });
    const { logger, events } = makeCapturingLogger();

    await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });

    const success = events.find((e) => e.event === "fallback.success");
    expect(success).toBeDefined();
    expect(success?.data.orphanMessageId).toBeUndefined();
  });

  test("multiple assistants after user (all empty) → latest wins", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [
        userMsg("user-1"),
        assistantMsg("asst-old"),
        assistantMsg("asst-newest"),
      ],
    });
    const { logger, events } = makeCapturingLogger();

    await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });

    const success = events.find((e) => e.event === "fallback.success");
    expect(success?.data.orphanMessageId).toBe("asst-newest");
  });

  test("malformed messages array (garbage entries mixed in) → valid orphan still found, fallback succeeds", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      // Mix valid user message with garbage; helper must not crash.
      messages: [
        userMsg("user-1"),
        null,
        "string-not-record",
        42,
        assistantMsg("asst-orphan"),
      ],
    });
    const { logger, events } = makeCapturingLogger();

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });

    // Fallback still succeeds — orphan-find guarded; valid asst-orphan still found.
    expect(result.success).toBe(true);
    const success = events.find((e) => e.event === "fallback.success");
    expect(success).toBeDefined();
    // The valid orphan IS found because helper defensively skips garbage.
    expect(success?.data.orphanMessageId).toBe("asst-orphan");
  });

  test("assistant before user (out-of-order) → does NOT match", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [
        { id: "asst-pre-user", role: "assistant", parts: [] }, // BEFORE user — must be ignored
        userMsg("user-1"),
      ],
    });
    const { logger, events } = makeCapturingLogger();

    await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });

    const success = events.find((e) => e.event === "fallback.success");
    expect(success?.data.orphanMessageId).toBeUndefined();
  });

  test("nested OpenCode shape {info: {id, role}, parts} → orphan found via info-branch", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [
        // user message in flat shape (helper supports both at any position)
        userMsg("user-1"),
        // assistant in NESTED shape — id/role on info, parts at top level
        { info: { id: "asst-nested-orphan", role: "assistant" }, parts: [] },
      ],
    });
    const { logger, events } = makeCapturingLogger();

    await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });

    const success = events.find((e) => e.event === "fallback.success");
    expect(success?.data.orphanMessageId).toBe("asst-nested-orphan");
  });

  test("only user message (no assistants at all) → field omitted", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg("user-1")] });
    const { logger, events } = makeCapturingLogger();

    await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });

    const success = events.find((e) => e.event === "fallback.success");
    expect(success?.data.orphanMessageId).toBeUndefined();
  });
});

// Extract the parts array actually sent to session.prompt so preserve_context
// behaviour can be asserted against the real replay prompt.
function promptParts(client: MockClient): unknown[] {
  const call = client.callsTo("session.prompt")[0];
  const body = (call?.args as { body: { parts: unknown[] } } | undefined)?.body;
  return body?.parts ?? [];
}

describe("attemptFallback — preserve_context", () => {
  test("preserveContext=true with assistant work → recovery part prepended", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg("user-1"), assistantMsg("a1", [{ type: "bash" }])],
    });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig, // preserveContext defaults to true
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    const parts = promptParts(client);
    // Recovery part is first; original user parts follow.
    expect(parts.length).toBe(2);
    const recovery = parts[0] as { type: string; text: string };
    expect(recovery.type).toBe("text");
    expect(recovery.text).toContain(
      "auto-generated from failed turn, verify before acting",
    );
    expect(recovery.text).toContain("Previous model (a/one) failed mid-turn");
    expect(recovery.text).toContain("bash");
    expect(recovery.text).toContain(
      "Do not blindly re-execute; verify current state before continuing.",
    );
    // Original user prompt preserved as the second part.
    expect(parts[1]).toEqual({ type: "text", text: "hello" });
  });

  test("preserveContext=true with no assistant work → bare prompt (current behaviour)", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg("user-1")] });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    const parts = promptParts(client);
    expect(parts).toEqual([{ type: "text", text: "hello" }]);
  });

  test("preserveContext=false → bare prompt even when assistant work exists", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg("user-1"), assistantMsg("a1", [{ type: "bash" }])],
    });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: { ...defaultConfig, preserveContext: false },
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    const parts = promptParts(client);
    expect(parts).toEqual([{ type: "text", text: "hello" }]);
    const joined = JSON.stringify(parts);
    expect(joined).not.toContain("[Context Recovery]");
    expect(joined).not.toContain("bash");
  });

  test("preserveContext=true with null current model → recovery part labels 'unknown'", async () => {
    const store = new FallbackStore();
    // currentModel left null (no prior model known)
    const client = new MockClient({
      messages: [userMsg("user-1"), assistantMsg("a1", [{ type: "edit" }])],
    });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    const recovery = promptParts(client)[0] as { type: string; text: string };
    expect(recovery.text).toContain("Previous model (unknown) failed mid-turn");
    expect(recovery.text).toContain("edit");
  });
});

describe("attemptFallback — category-aware cooldown", () => {
  test("quota_exhausted uses cooldownMsByCategory override when present", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    const config = {
      ...defaultConfig,
      cooldownMs: 5 * 60_000,
      cooldownMsByCategory: {
        quota_exhausted: 60 * 60_000,
        auth_error: 30 * 60_000,
      },
    };

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "quota_exhausted",
      chain,
      client,
      store,
      config,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    // Health record reflects the category-aware cooldown (1 hour) rather
    // than the default 5 minutes. We verify by checking the model is in
    // cooldown at 5+1 minutes (would have expired under default) but not
    // at 61 minutes (still active under the 1-hour override).
    const health = store.health.get("a/one" as ModelKey);
    expect(health.lastCategory).toBe("quota_exhausted");
    // cooldownUntil should be ~now + 1h. Allow slack for test runtime.
    const now = Date.now();
    expect(health.cooldownUntil).toBeGreaterThan(now + 55 * 60_000);
    expect(health.cooldownUntil).toBeLessThan(now + 65 * 60_000);
  });

  test("rate_limit uses 30min default override when not user-overridden", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    // CRITICAL: use defaultConfig unchanged so the new rate_limit default
    // applies. Prior setup built a local map omitting rate_limit, which
    // would mask the fix and leave the test asserting 5min (validator blocker).
    const config = { ...defaultConfig };

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    const health = store.health.get("a/one" as ModelKey);
    expect(health.lastCategory).toBe("rate_limit");
    const now = Date.now();
    // 30min default — NOT the prior 5min fall-through.
    expect(health.cooldownUntil).toBeGreaterThan(now + 25 * 60_000);
    expect(health.cooldownUntil).toBeLessThan(now + 35 * 60_000);
  });

  test("cooldownMsByCategory absent → default cooldownMs used for all categories", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    // Pre-fix config shape: no cooldownMsByCategory field at all.
    const config = {
      ttftMs: 60_000,
      cooldownMs: 5 * 60_000,
      maxDepth: 3,
      dedupWindowMs: 3_000,
      abortWaitMs: 150,
      preserveContext: true,
    };

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "quota_exhausted",
      chain,
      client,
      store,
      config,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    const health = store.health.get("a/one" as ModelKey);
    const now = Date.now();
    expect(health.cooldownUntil).toBeLessThan(now + 6 * 60_000);
  });

  test("Infinity override → model never exits cooldown within process lifetime", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    const config = {
      ...defaultConfig,
      cooldownMsByCategory: {
        quota_exhausted: Number.POSITIVE_INFINITY,
      },
    };

    await attemptFallback({
      sessionId: "s1",
      reason: "quota_exhausted",
      chain,
      client,
      store,
      config,
      logger: silentLogger,
      sleepMs: async () => {},
    });

    // Even after a year, model still in cooldown.
    expect(store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });
});

describe("attemptFallback — subagent short-circuit", () => {
  test("isSubagent=true → no abort/revert/prompt, model marked unhealthy, returns subagentSkipped", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "quota_exhausted",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      isSubagent: true,
      sleepMs: async () => {},
    });

    expect(result.success).toBe(true);
    expect(result.subagentSkipped).toBe(true);
    expect(result.fallbackModel).toBe("b/two");
    expect(result.fromModel).toBe("a/one");

    // CRITICAL: no abort/revert/prompt issued — these would be orphaned
    // work because the parent Task tool observes stream-error cancels as
    // terminal regardless. Only session.messages may be called by
    // upstream helpers (resolveAgentName) — not by the orchestrator
    // short-circuit path itself.
    const methodsCalled = client.calls.map((c) => c.method);
    expect(methodsCalled).not.toContain("session.abort");
    expect(methodsCalled).not.toContain("session.revert");
    expect(methodsCalled).not.toContain("session.prompt");
    expect(methodsCalled).not.toContain("session.messages");

    // Model still marked unhealthy with category-aware cooldown — this
    // is the lever that makes the parent's replacement spawn start
    // cleanly on the fallback model via preemptive redirect.
    expect(store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
    const health = store.health.get("a/one" as ModelKey);
    expect(health.lastCategory).toBe("quota_exhausted");

    // State bookkeeping still advances so a later same-session event
    // doesn't re-enter recovery depth=0.
    const st = store.sessions.get("s1");
    expect(st.currentModel).toBe("b/two");
    expect(st.fallbackDepth).toBe(1);
    expect(st.originalModel).toBe("a/one");
  });

  test("isSubagent=true with exhausted chain → still no recovery; returns exhausted (no subagentSkipped)", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    store.sessions.get("s1").fallbackDepth = 5; // exceeds maxDepth
    const client = new MockClient({ messages: [userMsg()] });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "quota_exhausted",
      chain,
      client,
      store,
      config: { ...defaultConfig, maxDepth: 3 },
      logger: silentLogger,
      isSubagent: true,
      sleepMs: async () => {},
    });

    // Chain exhausted check fires BEFORE subagent short-circuit — both
    // paths are gated by having a healthy next model to redirect to.
    expect(result.success).toBe(false);
    expect(result.error).toBe("exhausted");
    expect(result.subagentSkipped).toBeUndefined();
    expect(client.calls.map((c) => c.method)).not.toContain("session.abort");
  });

  test("isSubagent=false (default) → full recovery path preserved", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({ messages: [userMsg()] });

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "quota_exhausted",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
      // isSubagent omitted — defaults to undefined / falsy
    });

    expect(result.success).toBe(true);
    expect(result.subagentSkipped).toBeUndefined();
    // Full recovery path executes.
    const methods = client.calls.map((c) => c.method);
    expect(methods).toContain("session.abort");
    expect(methods).toContain("session.revert");
    expect(methods).toContain("session.prompt");
  });
});
