import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  handleChatMessage,
  handleEvent,
} from "../src/plugin.ts";
import plugin from "../src/plugin.ts";
import type { ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

function ctxWithChain(chain: ModelKey[]) {
  return createPluginContext({
    rawConfig: {
      agent: {
        scout: { options: { fallback_models: chain } },
      },
    },
    logger: silentLogger,
  });
}

describe("plugin entry — config loading", () => {
  test("loads chains from agent.<name>.options.fallback_models", () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    expect(ctx.chains.get("scout")).toEqual(["a/one", "b/two"]);
  });

  test("default config values applied", () => {
    const ctx = createPluginContext({ rawConfig: {}, logger: silentLogger });
    expect(ctx.config.ttftMs).toBe(60_000);
    expect(ctx.config.cooldownMs).toBe(5 * 60_000);
    expect(ctx.config.maxDepth).toBe(3);
    expect(ctx.config.dedupWindowMs).toBe(3_000);
  });
});

describe("handleChatMessage", () => {
  test("preemptive skip + TTFT arm on cooled current", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    // Cool current model
    ctx.store.health.cooldown("a/one" as ModelKey, 60_000);
    const client = new MockClient({ messages: [{ agent: "scout", role: "user" }] });
    const output = { message: { model: { providerID: "a", modelID: "one" } } };
    await handleChatMessage(ctx, client, { sessionID: "s1" }, output);
    expect(output.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(ctx.ttft.has("s1")).toBe(true);
    ctx.ttft.clear("s1"); // cleanup
  });

  test("no sessionId → no-op", async () => {
    const ctx = ctxWithChain(["a/one"]);
    const client = new MockClient();
    const out = { message: { model: { providerID: "a", modelID: "one" } } };
    await handleChatMessage(ctx, client, {}, out);
    expect(ctx.ttft.has("")).toBe(false);
  });

  test("undefined input → no-op (OpenCode plugin-registration probe)", async () => {
    const ctx = ctxWithChain(["a/one"]);
    const client = new MockClient();
    // Regression: OpenCode 1.15.9 invokes chat.message with undefined args
    // during plugin registration. Previously threw
    // "undefined is not an object (evaluating 'input.sessionID')" which the
    // plugin loader reported as "failed to load plugin".
    await handleChatMessage(ctx, client, undefined, undefined);
    expect(ctx.ttft.has("")).toBe(false);
  });

  test("undefined output but defined input → no-op", async () => {
    const ctx = ctxWithChain(["a/one"]);
    const client = new MockClient();
    await handleChatMessage(ctx, client, { sessionID: "s1" }, undefined);
    expect(ctx.ttft.has("s1")).toBe(false);
  });

  test("manual model change resets fallback depth", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    const state = ctx.store.sessions.get("s1");
    state.currentModel = "b/two";
    state.originalModel = "a/one";
    state.fallbackDepth = 2;
    state.lastFallbackAt = Date.now();

    const client = new MockClient({ messages: [{ agent: "scout", role: "user" }] });
    const output = { message: { model: { providerID: "c", modelID: "manual" } } };
    await handleChatMessage(ctx, client, { sessionID: "s1" }, output);

    expect(state.currentModel).toBe("c/manual");
    expect(state.originalModel).toBe("c/manual");
    expect(state.fallbackDepth).toBe(0);
    expect(state.lastFallbackAt).toBe(0);
    ctx.ttft.clear("s1");
  });
});

describe("handleEvent — undefined input", () => {
  test("undefined event → no-op (OpenCode plugin-registration probe)", async () => {
    const ctx = ctxWithChain(["a/one"]);
    const client = new MockClient();
    // Regression: see handleChatMessage undefined-input test above.
    await handleEvent(ctx, client, undefined);
    // No state change, no throw.
    expect(ctx.ttft.has("")).toBe(false);
  });
});

describe("handleEvent — session.error", () => {
  test("dispatches attemptFallback with classified category", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
    });
    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { statusCode: 429 },
      },
    });
    // Orchestrator should have been called → at least messages + abort + revert + prompt.
    expect(client.callsTo("session.abort").length).toBe(1);
    expect(client.callsTo("session.prompt").length).toBe(1);
    expect(ctx.store.sessions.get("s1").currentModel).toBe("b/two");
  });
});

describe("plugin event hook boundary", () => {
  test("unwraps canonical OpenCode { event } payload before dispatch", async () => {
    const client = new MockClient({
      messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
    });
    const hooks = await plugin({
      client,
      config: {
        agent: {
          scout: { options: { fallback_models: ["a/one", "b/two"] } },
        },
      },
    });

    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { statusCode: 429 },
        },
      },
    });

    expect(client.callsTo("session.prompt").length).toBe(1);
  });

  test("undefined event hook payload is a no-op", async () => {
    const client = new MockClient();
    const hooks = await plugin({ client, config: {} });

    await hooks.event?.(undefined);

    expect(client.callsTo("session.prompt").length).toBe(0);
  });
});

describe("handleEvent — session.status retry", () => {
  test("dispatches when text matches retry pattern", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
    });
    await handleEvent(ctx, client, {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { message: "Rate limit exceeded; retrying..." },
      },
    });
    expect(client.callsTo("session.prompt").length).toBe(1);
  });

  test("no-op when text is unrecognized", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    const client = new MockClient({ messages: [] });
    await handleEvent(ctx, client, {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { message: "all is well" },
      },
    });
    expect(client.callsTo("session.abort").length).toBe(0);
  });
});

describe("handleEvent — token arrival", () => {
  test("clears TTFT timer on session.message.part.updated", async () => {
    const ctx = ctxWithChain(["a/one"]);
    // Arm a timer manually
    ctx.ttft.arm("s1", 5_000, () => {});
    expect(ctx.ttft.has("s1")).toBe(true);
    await handleEvent(ctx, new MockClient(), {
      type: "session.message.part.updated",
      properties: {
        sessionID: "s1",
        part: { type: "text", text: "hi" },
      },
    });
    expect(ctx.ttft.has("s1")).toBe(false);
  });

  test("ignores empty parts", async () => {
    const ctx = ctxWithChain(["a/one"]);
    ctx.ttft.arm("s1", 5_000, () => {});
    await handleEvent(ctx, new MockClient(), {
      type: "session.message.part.updated",
      properties: {
        sessionID: "s1",
        part: { type: "", text: "" },
      },
    });
    expect(ctx.ttft.has("s1")).toBe(true);
    ctx.ttft.clear("s1");
  });

  test("does not clear TTFT timer on non-text metadata parts", async () => {
    const ctx = ctxWithChain(["a/one"]);
    ctx.ttft.arm("s1", 5_000, () => {});
    await handleEvent(ctx, new MockClient(), {
      type: "session.message.part.updated",
      properties: {
        sessionID: "s1",
        part: { type: "tool" },
      },
    });
    expect(ctx.ttft.has("s1")).toBe(true);
    ctx.ttft.clear("s1");
  });
});
