import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  handleChatMessage,
  handleEvent,
} from "../src/plugin-internal.ts";
import pluginModule from "../src/plugin.ts";
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

async function createRuntimeHooks(client: MockClient, config: unknown) {
  return pluginModule.server({ client, config } as unknown as Parameters<typeof pluginModule.server>[0]);
}

async function callRuntimeChatMessage(
  hooks: Awaited<ReturnType<typeof createRuntimeHooks>>,
  input: unknown,
  output: unknown,
) {
  const hook = hooks["chat.message"] as
    | ((input: unknown, output: unknown) => unknown | Promise<unknown>)
    | undefined;
  await hook?.(input, output);
}

async function callRuntimeEvent(hooks: Awaited<ReturnType<typeof createRuntimeHooks>>, input: unknown) {
  const hook = hooks.event as ((input: unknown) => unknown | Promise<unknown>) | undefined;
  await hook?.(input);
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
        error: { name: "APIError", data: { statusCode: 429, isRetryable: false } },
      },
    });
    // Orchestrator should have been called → at least messages + abort + revert + prompt.
    expect(client.callsTo("session.abort").length).toBe(1);
    expect(client.callsTo("session.prompt").length).toBe(1);
    expect(ctx.store.sessions.get("s1").currentModel).toBe("b/two");
  });
});

describe("plugin event hook boundary", () => {
  test("returns chat.message and event hook functions", async () => {
    const hooks = await createRuntimeHooks(new MockClient(), {});

    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
  });

  test("malformed chat hook payload is a no-op", async () => {
    const client = new MockClient({ messages: [{ agent: "scout", role: "user" }] });
    const hooks = await createRuntimeHooks(
      client,
      {
        agent: {
          scout: { options: { fallback_models: ["a/one", "b/two"] } },
        },
      },
    );

    await callRuntimeChatMessage(
      hooks,
      { sessionID: "s1" },
      { message: { model: { providerID: 7, modelID: "one" } } },
    );

    expect(client.callsTo("session.messages").length).toBe(0);
  });

  test("unwraps canonical OpenCode { event } payload before dispatch", async () => {
    const client = new MockClient({
      messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
    });
    const hooks = await createRuntimeHooks(
      client,
      {
        agent: {
          scout: { options: { fallback_models: ["a/one", "b/two"] } },
        },
      },
    );

    await callRuntimeEvent(hooks, {
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "APIError", data: { statusCode: 429, isRetryable: false } },
        },
      },
    });

    expect(client.callsTo("session.prompt").length).toBe(1);
  });

  test("malformed event wrapper payload is a no-op", async () => {
    const client = new MockClient({
      messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
    });
    const hooks = await createRuntimeHooks(
      client,
      {
        agent: {
          scout: { options: { fallback_models: ["a/one", "b/two"] } },
        },
      },
    );

    await callRuntimeEvent(hooks, {
      event: {
        type: 7,
        properties: { sessionID: "s1", error: { name: "APIError", data: { statusCode: 429, isRetryable: false } } },
      },
    });

    expect(client.callsTo("session.prompt").length).toBe(0);
  });

  test("undefined event hook payload is a no-op", async () => {
    const client = new MockClient();
    const hooks = await createRuntimeHooks(client, {});

    await callRuntimeEvent(hooks, undefined);

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
        status: { type: "retry", message: "Rate limit exceeded; retrying..." },
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
        status: { type: "retry", message: "all is well" },
      },
    });
    expect(client.callsTo("session.abort").length).toBe(0);
  });

  // Structural action.reason path (P33: structural before heuristic). Reason
  // is a typed field on session.status retry events — see
  // packages/opencode/src/session/status.ts:8-30 + retry.ts:11.
  describe("structural action.reason", () => {
    test("account_rate_limit → fallback fires (rate_limit)", async () => {
      const ctx = ctxWithChain(["a/one", "b/two"]);
      ctx.store.sessions.get("s1").currentModel = "a/one";
      const client = new MockClient({
        messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
      });
      await handleEvent(ctx, client, {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            message: "any text — ignored when action.reason is present",
            action: {
              reason: "account_rate_limit",
              provider: "opencode-go",
              title: "Go limit reached",
              message: "Usage limit reached.",
              label: "open settings",
            },
          },
        },
      });
      expect(client.callsTo("session.prompt").length).toBe(1);
    });

    test("free_tier_limit → fallback fires (quota_exhausted)", async () => {
      const ctx = ctxWithChain(["a/one", "b/two"]);
      ctx.store.sessions.get("s1").currentModel = "a/one";
      const client = new MockClient({
        messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
      });
      await handleEvent(ctx, client, {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            message: "any",
            action: {
              reason: "free_tier_limit",
              provider: "opencode-go",
              title: "Free limit reached",
              message: "Subscribe to Go.",
              label: "subscribe",
            },
          },
        },
      });
      expect(client.callsTo("session.prompt").length).toBe(1);
    });

    test("unknown action.reason + matching usage-limit text → falls through to text pattern", async () => {
      const ctx = ctxWithChain(["a/one", "b/two"]);
      ctx.store.sessions.get("s1").currentModel = "a/one";
      const client = new MockClient({
        messages: [{ id: "msg-1", role: "user", agent: "scout", parts: [] }],
      });
      await handleEvent(ctx, client, {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            message: "5 hour usage limit reached. It will reset in 5 hours 23 minutes.",
            action: {
              reason: "some_future_reason_not_yet_mapped",
              provider: "x",
              title: "t",
              message: "m",
              label: "l",
            },
          },
        },
      });
      expect(client.callsTo("session.prompt").length).toBe(1);
    });

    test("unknown action.reason + non-matching text → no fallback", async () => {
      const ctx = ctxWithChain(["a/one", "b/two"]);
      const client = new MockClient({ messages: [] });
      await handleEvent(ctx, client, {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            message: "informational message",
            action: {
              reason: "some_future_reason",
              provider: "x",
              title: "t",
              message: "m",
              label: "l",
            },
          },
        },
      });
      expect(client.callsTo("session.abort").length).toBe(0);
    });
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
