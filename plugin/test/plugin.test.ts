import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  extractCooldownOverrides,
  handleChatMessage,
  handleEvent,
} from "../src/plugin-internal.ts";
import pluginModule from "../src/plugin.ts";
import type { ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

// Shared type for hook-introspection assertions in test helpers. Mirrors
// the optional Hooks.config shape from @opencode-ai/plugin SDK.
type HooksWithConfig = {
  config?: (input: unknown) => unknown | Promise<unknown>;
};

function ctxWithChain(chain: ModelKey[]) {
  // Production chain population happens via the Hooks.config callback (see
  // createPluginHooks). For unit tests that exercise handler behavior with a
  // pre-populated chain, mutate ctx.chains directly — equivalent end state
  // without the full hook lifecycle. Lifecycle tests live in the dedicated
  // "createPluginHooks — Hooks.config lifecycle" describe block below.
  const ctx = createPluginContext({ logger: silentLogger });
  ctx.chains.set("scout", chain);
  return ctx;
}

function userMsg(id = "msg-1", agent = "scout") {
  return { info: { id, role: "user", agent }, parts: [] };
}

async function createRuntimeHooks(client: MockClient, config: unknown, pluginOptions?: unknown) {
  // PluginInput no longer carries config (real OpenCode shape). To preserve
  // existing test semantics, we invoke pluginModule.server then explicitly
  // call the Hooks.config callback to deliver the synthetic config — matching
  // the real lifecycle (init → config → events).
  const hooks = await pluginModule.server(
    { client } as unknown as Parameters<typeof pluginModule.server>[0],
    pluginOptions as Parameters<typeof pluginModule.server>[1],
  );
  const configHook = (hooks as HooksWithConfig).config;
  if (configHook) await configHook(config);
  return hooks;
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

describe("plugin entry — context init", () => {
  test("ctx.chains starts empty (populated later by Hooks.config)", () => {
    const ctx = createPluginContext({ logger: silentLogger });
    expect(ctx.chains.size).toBe(0);
  });

  test("default plugin config values applied", () => {
    const ctx = createPluginContext({ logger: silentLogger });
    expect(ctx.config.ttftMs).toBe(60_000);
    expect(ctx.config.cooldownMs).toBe(5 * 60_000);
    expect(ctx.config.maxDepth).toBe(3);
    expect(ctx.config.dedupWindowMs).toBe(3_000);
  });

  // Chain loader integration (loader unit tests live in config.test.ts).
  // Verifies the Map identity invariant: ctxWithChain helper mutates the
  // existing Map rather than replacing it, matching production behavior.
  test("direct chain mutation preserves Map identity", () => {
    const ctx = createPluginContext({ logger: silentLogger });
    const ref = ctx.chains;
    ctx.chains.set("scout", ["a/one"]);
    expect(ctx.chains).toBe(ref);
    expect(ref.get("scout")).toEqual(["a/one"]);
  });
});

describe("handleChatMessage", () => {
  test("preemptive skip + TTFT arm on cooled current", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    // Cool current model
    ctx.store.health.cooldown("a/one" as ModelKey, 60_000);
    const client = new MockClient({ messages: [userMsg()] });
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

    const client = new MockClient({ messages: [userMsg()] });
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
      messages: [userMsg()],
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

  test("does not fallback on MessageAbortedError from user cancel", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
    });

    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: {
          name: "MessageAbortedError",
          data: { message: "The operation was aborted." },
        },
      },
    });

    expect(client.callsTo("session.abort").length).toBe(0);
    expect(client.callsTo("session.prompt").length).toBe(0);
    expect(ctx.store.sessions.get("s1").currentModel).toBe("a/one");
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(false);
  });

  test("subagent session (parentID present) → skip recovery, mark unhealthy only", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      // session.get returns a session with parentID → detectSubagent = true.
      sessionInfo: { id: "s1", parentID: "ses_parent_abc" },
    });

    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "APIError", data: { statusCode: 429, isRetryable: false } },
      },
    });

    // session.get called once for subagent detection (cached thereafter).
    expect(client.callsTo("session.get").length).toBe(1);
    // CRITICAL: no abort/revert/prompt — parent Task tool already saw
    // the stream-error cancel as terminal; recovery would be orphaned.
    expect(client.callsTo("session.abort").length).toBe(0);
    expect(client.callsTo("session.revert").length).toBe(0);
    expect(client.callsTo("session.prompt").length).toBe(0);
    // Model still marked unhealthy — replacement spawn gets preemptive
    // redirect via chat.message on the parent's next Task call.
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
    // State advances so re-entry doesn't reset depth.
    expect(ctx.store.sessions.get("s1").currentModel).toBe("b/two");
    expect(ctx.store.sessions.get("s1").fallbackDepth).toBe(1);
    // Detection result cached on session state.
    expect(ctx.store.sessions.get("s1").isSubagent).toBe(true);
  });

  test("subagent detection cached — second error on same session skips session.get", async () => {
    const ctx = ctxWithChain(["a/one", "b/two", "c/three"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      sessionInfo: { id: "s1", parentID: "ses_parent_abc" },
    });

    // First error: detects subagent via session.get.
    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    });
    expect(client.callsTo("session.get").length).toBe(1);

    // Reset call log to verify cache hit on second error.
    client.calls.length = 0;
    // Manually advance time past dedup window so the second error isn't
    // collapsed (dedupWindowMs default = 3000ms).
    const original = Date.now;
    const baseTime = original();
    Date.now = () => baseTime + 10_000;
    try {
      await handleEvent(ctx, client, {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "APIError", data: { statusCode: 429 } },
        },
      });
    } finally {
      Date.now = original;
    }

    // Cached: session.get NOT called again.
    expect(client.callsTo("session.get").length).toBe(0);
    // Still no recovery (subagent).
    expect(client.callsTo("session.abort").length).toBe(0);
  });

  test("primary session (no parentID) → full recovery path", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      // No parentID → primary session → full recovery.
      sessionInfo: { id: "s1" },
    });

    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    });

    expect(client.callsTo("session.get").length).toBe(1);
    expect(client.callsTo("session.abort").length).toBe(1);
    expect(client.callsTo("session.revert").length).toBe(1);
    expect(client.callsTo("session.prompt").length).toBe(1);
    expect(ctx.store.sessions.get("s1").isSubagent).toBe(false);
  });

  test("session.get failure → degrades to full recovery (treat as primary)", async () => {
    const ctx = ctxWithChain(["a/one", "b/two"]);
    ctx.store.sessions.get("s1").currentModel = "a/one";
    const client = new MockClient({
      messages: [userMsg()],
      getError: new Error("network failure"),
    });

    await handleEvent(ctx, client, {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    });

    // Detection failed → fall through to full recovery.
    expect(client.callsTo("session.abort").length).toBe(1);
    expect(client.callsTo("session.revert").length).toBe(1);
    expect(client.callsTo("session.prompt").length).toBe(1);
    // isSubagent left undefined (cache miss) — retryable on next event.
    expect(ctx.store.sessions.get("s1").isSubagent).toBeUndefined();
  });
});

describe("plugin event hook boundary", () => {
  test("returns chat.message and event hook functions", async () => {
    const hooks = await createRuntimeHooks(new MockClient(), {});

    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["chat.params"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
  });

  test("chat.params strips legacy OMR fallback_models before provider transform", async () => {
    const hooks = await createRuntimeHooks(new MockClient(), {});
    const out: { options: Record<string, unknown> } = {
      options: { fallback_models: ["a/one"], thinking: { type: "enabled" } },
    };

    const hook = hooks["chat.params"] as ((input: unknown, output: unknown) => unknown | Promise<unknown>) | undefined;
    await hook?.({}, out);

    expect(out.options).toEqual({ thinking: { type: "enabled" } });
  });

  test("malformed chat hook payload is a no-op", async () => {
    const client = new MockClient({ messages: [userMsg()] });
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
      messages: [userMsg()],
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
      messages: [userMsg()],
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
      messages: [userMsg()],
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
        messages: [userMsg()],
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
        messages: [userMsg()],
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
        messages: [userMsg()],
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
  test("clears TTFT timer on message.part.updated", async () => {
    const ctx = ctxWithChain(["a/one"]);
    // Arm a timer manually
    ctx.ttft.arm("s1", 5_000, () => {});
    expect(ctx.ttft.has("s1")).toBe(true);
    await handleEvent(ctx, new MockClient(), {
      type: "message.part.updated",
      properties: {
        part: { sessionID: "s1", type: "text", text: "hi" },
      },
    });
    expect(ctx.ttft.has("s1")).toBe(false);
  });

  test("ignores empty parts", async () => {
    const ctx = ctxWithChain(["a/one"]);
    ctx.ttft.arm("s1", 5_000, () => {});
    await handleEvent(ctx, new MockClient(), {
      type: "message.part.updated",
      properties: {
        part: { sessionID: "s1", type: "", text: "" },
      },
    });
    expect(ctx.ttft.has("s1")).toBe(true);
    ctx.ttft.clear("s1");
  });

  test("does not clear TTFT timer on non-text metadata parts", async () => {
    const ctx = ctxWithChain(["a/one"]);
    ctx.ttft.arm("s1", 5_000, () => {});
    await handleEvent(ctx, new MockClient(), {
      type: "message.part.updated",
      properties: {
        part: { sessionID: "s1", type: "tool" },
      },
    });
    expect(ctx.ttft.has("s1")).toBe(true);
    ctx.ttft.clear("s1");
  });
});

// Lifecycle tests for the Hooks.config callback path — OpenCode delivers
// merged Config via Hooks.config (not via PluginInput.config which never
// existed). These tests codify the real bus contract and protect against
// regressions in hook-ordering or chain-loading.
describe("createPluginHooks — Hooks.config lifecycle", () => {
  async function makeHooks(client: MockClient, pluginOptions?: unknown) {
    return pluginModule.server(
      { client } as unknown as Parameters<typeof pluginModule.server>[0],
      pluginOptions as Parameters<typeof pluginModule.server>[1],
    );
  }

  async function callConfig(hooks: Awaited<ReturnType<typeof makeHooks>>, cfg: unknown) {
    const hook = (hooks as HooksWithConfig).config;
    if (!hook) throw new Error("config hook not registered on plugin hooks");
    await hook(cfg);
  }

  function usageRetryEvent(sessionID = "s1") {
    return {
      type: "session.status",
      properties: {
        sessionID,
        status: {
          type: "retry",
          attempt: 1,
          message: "The usage limit has been reached",
          next: Date.now() + 2000,
        },
      },
    };
  }

  test("config hook is registered on returned hooks", async () => {
    const hooks = await makeHooks(new MockClient());
    expect(typeof (hooks as HooksWithConfig).config).toBe("function");
  });

  test("init → config → event triggers fallback with chain from cfg", async () => {
    const client = new MockClient({
      messages: [userMsg("msg-1", "adv")],
    });
    const hooks = await makeHooks(client);
    // OpenCode-side: deliver merged Config via the hook
    await callConfig(hooks, {
      agent: {
        adv: { options: { fallback_models: ["anthropic/claude", "z/glm"] } },
      },
    });
    // Bus event arrives after config hook completed
    await callRuntimeEvent(hooks, { event: usageRetryEvent() });
    expect(client.callsTo("session.abort").length).toBe(1);
    const promptCalls = client.callsTo("session.prompt");
    expect(promptCalls.length).toBe(1);
    // Assert the SELECTED model is the first chain entry (resolver picks
    // first non-cooled model). Without this, the test passes even if the
    // resolver picked a different/wrong model.
    expect(promptCalls[0].args).toMatchObject({
      body: { model: { providerID: "anthropic", modelID: "claude" } },
    });
  });

  test("plugin tuple options supply chains without agent options config", async () => {
    const client = new MockClient({ messages: [userMsg("msg-1", "adv")] });
    const hooks = await makeHooks(client, {
      agents: { adv: { fallback_models: ["plugin/primary"] } },
    });
    await callConfig(hooks, {});

    await callRuntimeEvent(hooks, { event: usageRetryEvent() });

    const promptCalls = client.callsTo("session.prompt");
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0].args).toMatchObject({
      body: { model: { providerID: "plugin", modelID: "primary" } },
    });
  });

  test("ordering violation: event before config → no crash, no fallback; recovers after config", async () => {
    const client = new MockClient({
      messages: [userMsg("msg-1", "adv")],
    });
    const hooks = await makeHooks(client);
    // Fire event BEFORE config — codifies the ordering contract.
    // Chains are empty; handler must short-circuit cleanly (no abort, no prompt, no crash).
    await expect(callRuntimeEvent(hooks, { event: usageRetryEvent() })).resolves.toBeUndefined();
    expect(client.callsTo("session.abort").length).toBe(0);
    expect(client.callsTo("session.prompt").length).toBe(0);

    // Now deliver config and fire event again — fallback now fires.
    await callConfig(hooks, {
      agent: { adv: { options: { fallback_models: ["anthropic/claude"] } } },
    });
    await callRuntimeEvent(hooks, { event: usageRetryEvent() });
    expect(client.callsTo("session.prompt").length).toBe(1);
  });

  test("empty agent config → chains stay empty → fallback exits 'no chain'", async () => {
    const client = new MockClient({
      messages: [userMsg("msg-1", "adv")],
    });
    const hooks = await makeHooks(client);
    await callConfig(hooks, {}); // no `agent` key at all
    await callRuntimeEvent(hooks, { event: usageRetryEvent() });
    expect(client.callsTo("session.abort").length).toBe(0);
    expect(client.callsTo("session.prompt").length).toBe(0);
  });

  test("config hook re-invocation updates chain in-place (Map identity preserved + new chain used)", async () => {
    const client = new MockClient({
      messages: [userMsg("msg-1", "adv")],
    });
    const hooks = await makeHooks(client);
    await callConfig(hooks, {
      agent: { adv: { options: { fallback_models: ["initial/model"] } } },
    });
    // Re-deliver with different chain (simulates config update path)
    await callConfig(hooks, {
      agent: { adv: { options: { fallback_models: ["updated/model"] } } },
    });
    await callRuntimeEvent(hooks, { event: usageRetryEvent() });
    // Fallback fires AND uses the UPDATED chain (not the initial one).
    // Without the model assertion, the test would pass even if the
    // in-place mutation accidentally retained the old chain entries.
    const promptCalls = client.callsTo("session.prompt");
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0].args).toMatchObject({
      body: { model: { providerID: "updated", modelID: "model" } },
    });
  });

  test("config hook re-delivery removes stale agents (clear() before set())", async () => {
    // Regression guard for the .clear() step in the config hook — if it were
    // accidentally removed, agents from earlier config deliveries would leak
    // and produce phantom fallback routes.
    const advClient = new MockClient({
      messages: [userMsg("msg-1", "adv")],
    });
    const hooks = await makeHooks(advClient);
    // First delivery: agent "adv" has a chain
    await callConfig(hooks, {
      agent: { adv: { options: { fallback_models: ["x/y"] } } },
    });
    // Second delivery: only agent "scout" — "adv" must be removed
    await callConfig(hooks, {
      agent: { scout: { options: { fallback_models: ["a/b"] } } },
    });
    // Event for agent "adv" must NOT trigger fallback (chain removed)
    await callRuntimeEvent(hooks, { event: usageRetryEvent() });
    expect(advClient.callsTo("session.abort").length).toBe(0);
    expect(advClient.callsTo("session.prompt").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fixRateLimitCooldownThrash — cooldown plumbing tests
// ---------------------------------------------------------------------------

describe("extractCooldownOverrides — direct unit tests", () => {
  test("returns undefined when pluginOptions is not a record", () => {
    expect(extractCooldownOverrides(undefined, silentLogger)).toBeUndefined();
    expect(extractCooldownOverrides(null, silentLogger)).toBeUndefined();
    expect(extractCooldownOverrides("string", silentLogger)).toBeUndefined();
    expect(extractCooldownOverrides(42, silentLogger)).toBeUndefined();
  });

  test("returns undefined when cooldownMsByCategory is absent or wrong shape", () => {
    expect(extractCooldownOverrides({}, silentLogger)).toBeUndefined();
    expect(extractCooldownOverrides({ agents: {} }, silentLogger)).toBeUndefined();
    expect(extractCooldownOverrides({ cooldownMsByCategory: "not-a-record" }, silentLogger)).toBeUndefined();
    expect(extractCooldownOverrides({ cooldownMsByCategory: null }, silentLogger)).toBeUndefined();
  });

  test("returns undefined when all entries are invalid", () => {
    const result = extractCooldownOverrides(
      { cooldownMsByCategory: { not_a_category: 1000, rate_limit: "30" } },
      silentLogger,
    );
    expect(result).toBeUndefined();
  });

  test.each([
    ["finite positive", 5 * 60_000, true],
    ["zero (no cooldown)", 0, true],
    ["Number.POSITIVE_INFINITY (programmatic sentinel)", Number.POSITIVE_INFINITY, true],
  ] as const)("accepts %s", (_label, value, _accepted) => {
    const result = extractCooldownOverrides(
      { cooldownMsByCategory: { rate_limit: value } },
      silentLogger,
    );
    expect(result?.rate_limit).toBe(value);
  });

  test.each([
    ["string", "30"],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
  ] as const)("rejects %s for category value", (_label, value) => {
    const result = extractCooldownOverrides(
      { cooldownMsByCategory: { rate_limit: value } },
      silentLogger,
    );
    expect(result?.rate_limit).toBeUndefined();
  });

  test("rejects unknown category names with warn log", () => {
    const result = extractCooldownOverrides(
      { cooldownMsByCategory: { not_a_category: 1000, rate_limit: 5 * 60_000 } },
      silentLogger,
    );
    expect(result).toEqual({ rate_limit: 5 * 60_000 });
  });

  test("prototype-inherited names rejected (toString, constructor, __proto__)", () => {
    const result = extractCooldownOverrides(
      { cooldownMsByCategory: { toString: 1000, constructor: 1000, __proto__: 1000 } },
      silentLogger,
    );
    expect(result).toBeUndefined();
  });

  test("mixed valid and invalid entries — only valid applied", () => {
    const result = extractCooldownOverrides(
      {
        cooldownMsByCategory: {
          rate_limit: "30",                  // string → dropped
          not_a_category: 1000,              // unknown → dropped
          quota_exhausted: -1,               // negative → dropped
          auth_error: 0,                     // zero → accepted
          ttft_timeout: Number.NaN,          // NaN → dropped
          server_error: Number.NEGATIVE_INFINITY, // -Inf → dropped
          unknown_model: Number.POSITIVE_INFINITY, // +Inf → accepted (sentinel)
          unknown: 5 * 60_000,               // valid finite → accepted
        },
      },
      silentLogger,
    );
    expect(result).toEqual({
      auth_error: 0,
      unknown_model: Number.POSITIVE_INFINITY,
      unknown: 5 * 60_000,
    });
  });
});

describe("createPluginContext — cooldown override merge (3-layer)", () => {
  test("cooldownOverrides applied via opts.cooldownOverrides param", () => {
    const ctx = createPluginContext({
      cooldownOverrides: { rate_limit: 60 * 60_000 },
      logger: silentLogger,
    });
    expect(ctx.config.cooldownMsByCategory?.rate_limit).toBe(60 * 60_000);
  });

  test("unmentioned categories preserve default (additive merge)", () => {
    const ctx = createPluginContext({
      cooldownOverrides: { rate_limit: 60 * 60_000 },
      logger: silentLogger,
    });
    // Override rate_limit; default quota_exhausted + auth_error + rate_limit(30min) preserved
    expect(ctx.config.cooldownMsByCategory?.quota_exhausted).toBe(60 * 60_000);
    expect(ctx.config.cooldownMsByCategory?.auth_error).toBe(30 * 60_000);
    expect(ctx.config.cooldownMsByCategory?.rate_limit).toBe(60 * 60_000); // override wins
  });

  test("opts.config.cooldownMsByCategory + cooldownOverrides layered together", () => {
    const ctx = createPluginContext({
      config: { cooldownMsByCategory: { auth_error: 10 * 60_000 } },
      cooldownOverrides: { rate_limit: 60 * 60_000 },
      logger: silentLogger,
    });
    // 3 layers: default quota_exhausted(1hr) preserved; auth_error overridden by config(10min);
    // rate_limit overridden by pluginOptions(60min)
    expect(ctx.config.cooldownMsByCategory?.quota_exhausted).toBe(60 * 60_000);
    expect(ctx.config.cooldownMsByCategory?.auth_error).toBe(10 * 60_000);
    expect(ctx.config.cooldownMsByCategory?.rate_limit).toBe(60 * 60_000);
  });

  test("no overrides supplied — default cooldownMsByCategory intact", () => {
    const ctx = createPluginContext({ logger: silentLogger });
    expect(ctx.config.cooldownMsByCategory?.rate_limit).toBe(30 * 60_000);
    expect(ctx.config.cooldownMsByCategory?.quota_exhausted).toBe(60 * 60_000);
    expect(ctx.config.cooldownMsByCategory?.auth_error).toBe(30 * 60_000);
  });
});

describe("createPluginHooks — pluginOptions.cooldownMsByCategory plumbing", () => {
  test("pluginOptions.cooldownMsByCategory applies its override at failure time", async () => {
    const client = new MockClient({ messages: [userMsg("msg-1", "adv")] });
    const hooks = await createRuntimeHooks(
      client,
      { agent: { adv: { options: { fallback_models: ["a/one", "b/two"] } } } },
      { cooldownMsByCategory: { rate_limit: 60 * 60_000 } },
    );

    // Establish a/one as the active model, then fail it with rate_limit.
    await callRuntimeChatMessage(hooks, { sessionID: "s1" }, {
      message: { model: { providerID: "a", modelID: "one" } },
    });
    await callRuntimeEvent(hooks, {
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "APIError", data: { statusCode: 429 } },
        },
      },
    });
    expect(client.callsTo("session.prompt")[0]?.args).toMatchObject({
      body: { model: { providerID: "b", modelID: "two" } },
    });

    // At +45 minutes, the 60-minute tuple override must still redirect a/one.
    // This distinguishes it from the 30-minute default without reaching into
    // the hook closure's private context.
    const originalNow = Date.now;
    const baseTime = originalNow();
    Date.now = () => baseTime + 45 * 60_000;
    try {
      const output = { message: { model: { providerID: "a", modelID: "one" } } };
      await callRuntimeChatMessage(hooks, { sessionID: "s1" }, output);
      expect(output.message.model).toEqual({ providerID: "b", modelID: "two" });
    } finally {
      Date.now = originalNow;
    }
  });
});
