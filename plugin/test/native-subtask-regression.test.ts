import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  createPluginHooks,
  handleChatMessage,
  handleChatParams,
} from "../src/plugin-internal.ts";
import { convertPartsForPrompt } from "../src/replay/message-converter.ts";
import { attemptFallback } from "../src/replay/orchestrator.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";
import { TtftRegistry } from "../src/ttft.ts";
import { MockClient } from "./helpers/mock-client.ts";

const logger = createLogger({ minLevel: "error", write: () => {} });
const subtask = {
  type: "subtask",
  id: "native-subtask-part",
  agent: "concord-research",
  prompt: "Investigate the assigned question",
  description: "Native research dispatch",
};
const model = { providerID: "a", modelID: "one" };
const chain: ModelKey[] = ["a/one", "b/two"];
const contexts: ReturnType<typeof createPluginContext>[] = [];

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.ttft.clear("parent");
});

describe("native subtask TTFT and replay", () => {
  test("the production params hook, not user text admission, starts the TTFT window", async () => {
    const client = new MockClient({
      messages: [
        {
          info: { id: "u1", role: "user", agent: "build" },
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    });
    const hooks = await createPluginHooks(
      { client },
      { agents: { build: { fallback_models: chain } } },
    );
    await hooks.config?.({});
    const arm = spyOn(TtftRegistry.prototype, "arm");
    try {
      await hooks["chat.message"]?.(
        { sessionID: "parent", agent: "build" },
        { message: { model }, parts: [{ type: "text", text: "hello" }] },
      );
      await hooks.event?.({
        event: {
          type: "message.part.updated",
          properties: {
            part: { type: "text", text: "hello", sessionID: "parent" },
          },
        },
      });
      expect(arm).not.toHaveBeenCalled();
      await hooks["chat.params"]?.(
        {
          sessionID: "parent",
          agent: "build",
          model: { providerID: "a", id: "one" },
        },
        { options: {} },
      );
      expect(arm).toHaveBeenCalledTimes(1);
    } finally {
      await hooks.event?.({
        event: { type: "session.idle", properties: { sessionID: "parent" } },
      });
      arm.mockRestore();
    }
  });

  test("compaction params cannot arm a conversation timer", async () => {
    const ctx = createPluginContext({ logger });
    contexts.push(ctx);
    ctx.store.sessions.get("parent").agentName = "build";
    handleChatParams(ctx, new MockClient(), {
      sessionID: "parent",
      agent: "compaction",
      model: { providerID: "a", id: "one" },
    });
    expect(ctx.ttft.has("parent")).toBe(false);
  });

  for (const [name, parts] of [
    ["subtask-only dispatch", [subtask]],
    [
      "noReply context-only text",
      [{ type: "text", text: "Context, not a request" }],
    ],
  ] as const) {
    test(`${name} does not arm TTFT at user-message admission`, async () => {
      const ctx = createPluginContext({ logger });
      contexts.push(ctx);
      ctx.chains.set("build", chain);
      // noReply is a prompt option, not a chat.message hook field. Until
      // chat.params runs, even a text-bearing user message may be context-only.
      const output = { message: { model }, parts: [...parts] };
      await handleChatMessage(
        ctx,
        new MockClient(),
        { sessionID: "parent", agent: "build" },
        output,
      );
      expect(ctx.ttft.has("parent")).toBe(false);
    });
  }

  test("replay strips native subtasks while preserving text and attachments", async () => {
    const text = { type: "text", text: "Continue the investigation" };
    const file = {
      type: "file",
      mime: "text/plain",
      url: "file:///fixture.txt",
    };
    const parts = [subtask, text, file];
    const store = new FallbackStore();
    store.sessions.get("parent").currentModel = "a/one";
    const client = new MockClient({
      messages: [
        { info: { id: "user-1", role: "user", agent: "build" }, parts },
      ],
    });
    const result = await attemptFallback({
      sessionId: "parent",
      reason: "server_error",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(true);
    const prompt = client.callsTo("session.prompt")[0]?.args as {
      body: { parts: unknown[] };
    };
    expect(prompt.body.parts).toEqual([text, file]);
    expect(parts).toEqual([subtask, text, file]);
    expect(convertPartsForPrompt([subtask])).toEqual([]);
  });

  test("a stale TTFT expiry on a subtask-only turn cannot cool or abort the parent", async () => {
    const store = new FallbackStore();
    const state = store.sessions.get("parent");
    state.currentModel = "a/one";
    state.lastServedModel = "a/one";
    const client = new MockClient({
      messages: [
        {
          info: { id: "native-user", role: "user", agent: "build" },
          parts: [subtask],
        },
      ],
    });
    const result = await attemptFallback({
      sessionId: "parent",
      reason: "ttft_timeout",
      chain,
      client,
      store,
      config: defaultConfig,
      logger,
      sleepMs: async () => {},
    });
    expect(store.health.isInCooldown("a/one")).toBe(false);
    expect(state.currentModel).toBe("a/one");
    expect(state.fallbackDepth).toBe(0);
    expect(result.success).toBe(false);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
  });
});
