import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  handleChatMessage,
  handleEvent,
} from "../src/plugin.ts";
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
});
