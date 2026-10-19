// ttft-assistant-output.test.ts — the first-request TTFT timer clears on the
// first verified assistant-generated output (text, reasoning, or a tool call
// or its output), and on nothing else.
//
// A productive child that reasons and calls tools before writing any text
// is not silent. Before this contract, only a nonempty text part cleared the
// timer, so such a child was aborted at the TTFT deadline mid-work.
// Provenance is required: a part clears only when the host has identified
// its message as an assistant row of the same session (V1), or when the
// event type is itself assistant-generated output (V2).

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  handleChatMessage,
  handleChatParams,
  handleEvent,
  normalizeEventInput,
  setupV2Plugin,
  type PluginContext,
  type V2SessionDomain,
} from "../src/plugin-internal.ts";
import { TtftRegistry } from "../src/ttft.ts";
import type { ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const logger = createLogger({ minLevel: "error", write: () => {} });
const SESSION = "child";
const ASSISTANT = "msg_assistant_1";
const USER = "msg_user_1";
const contexts: PluginContext[] = [];

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.ttft.clear(SESSION);
});

function armedContext(): PluginContext {
  const ctx = createPluginContext({ logger });
  contexts.push(ctx);
  ctx.ttft.arm(SESSION, 60_000, () => {});
  return ctx;
}

async function deliver(ctx: PluginContext, event: unknown): Promise<void> {
  await handleEvent(ctx, new MockClient(), normalizeEventInput({ event }));
}

function messageRow(id: string, role: "user" | "assistant") {
  return {
    type: "message.updated",
    properties: {
      info: {
        id,
        sessionID: SESSION,
        role,
        agent: "scout",
        ...(role === "assistant"
          ? { providerID: "a", modelID: "one", time: { created: 1 } }
          : { time: { created: 1 } }),
      },
    },
  };
}

function partUpdated(part: Record<string, unknown>) {
  return {
    type: "message.part.updated",
    properties: { part: { id: "prt_1", sessionID: SESSION, ...part } },
  };
}

function partDelta(messageID: string, delta: string) {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: SESSION,
      messageID,
      partID: "prt_1",
      field: "text",
      delta,
    },
  };
}

describe("V1 TTFT clear — assistant-generated output clears", () => {
  const cases: Array<[string, unknown]> = [
    [
      "nonempty assistant text part",
      partUpdated({ messageID: ASSISTANT, type: "text", text: "Working" }),
    ],
    ["streamed assistant text delta", partDelta(ASSISTANT, "Work")],
    [
      "nonempty assistant reasoning part",
      partUpdated({
        messageID: ASSISTANT,
        type: "reasoning",
        text: "Plan the search",
        time: { start: 1 },
      }),
    ],
    [
      "assistant tool call before execution",
      partUpdated({
        messageID: ASSISTANT,
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: { status: "pending", input: {}, raw: "" },
      }),
    ],
    [
      "assistant tool output",
      partUpdated({
        messageID: ASSISTANT,
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/x" },
          output: "contents",
          title: "x",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }),
    ],
  ];

  for (const [name, event] of cases) {
    test(`${name} clears the armed timer`, async () => {
      const ctx = armedContext();
      await deliver(ctx, messageRow(ASSISTANT, "assistant"));
      expect(ctx.ttft.has(SESSION)).toBe(true);
      await deliver(ctx, event);
      expect(ctx.ttft.has(SESSION)).toBe(false);
    });
  }
});

describe("V1 TTFT clear — non-assistant or non-output events do not clear", () => {
  test("a user text part does not clear", async () => {
    const ctx = armedContext();
    await deliver(ctx, messageRow(USER, "user"));
    await deliver(
      ctx,
      partUpdated({ messageID: USER, type: "text", text: "Please do X" }),
    );
    expect(ctx.ttft.has(SESSION)).toBe(true);
  });

  test("a text part whose message was never identified does not clear", async () => {
    const ctx = armedContext();
    await deliver(
      ctx,
      partUpdated({ messageID: "msg_unknown", type: "text", text: "hello" }),
    );
    await deliver(ctx, partUpdated({ type: "text", text: "hello" }));
    expect(ctx.ttft.has(SESSION)).toBe(true);
  });

  test("an assistant row from another session does not verify this session's part", async () => {
    const ctx = armedContext();
    await deliver(ctx, {
      type: "message.updated",
      properties: {
        info: {
          id: ASSISTANT,
          sessionID: "other-session",
          role: "assistant",
          providerID: "a",
          modelID: "one",
          time: { created: 1 },
        },
      },
    });
    await deliver(
      ctx,
      partUpdated({ messageID: ASSISTANT, type: "text", text: "hello" }),
    );
    expect(ctx.ttft.has(SESSION)).toBe(true);
  });

  test("the model-request shell row alone does not clear", async () => {
    const ctx = armedContext();
    await deliver(ctx, messageRow(ASSISTANT, "assistant"));
    expect(ctx.ttft.has(SESSION)).toBe(true);
  });

  for (const type of ["step-start", "step-finish", "snapshot", "patch"]) {
    test(`an assistant ${type} metadata part does not clear`, async () => {
      const ctx = armedContext();
      await deliver(ctx, messageRow(ASSISTANT, "assistant"));
      await deliver(ctx, partUpdated({ messageID: ASSISTANT, type }));
      expect(ctx.ttft.has(SESSION)).toBe(true);
    });
  }

  test("empty assistant text, reasoning, and delta do not clear", async () => {
    const ctx = armedContext();
    await deliver(ctx, messageRow(ASSISTANT, "assistant"));
    await deliver(
      ctx,
      partUpdated({ messageID: ASSISTANT, type: "text", text: "" }),
    );
    await deliver(
      ctx,
      partUpdated({
        messageID: ASSISTANT,
        type: "reasoning",
        text: "",
        time: { start: 1 },
      }),
    );
    await deliver(ctx, partDelta(ASSISTANT, ""));
    expect(ctx.ttft.has(SESSION)).toBe(true);
  });

  test("a busy session status does not clear", async () => {
    const ctx = armedContext();
    await deliver(ctx, {
      type: "session.status",
      properties: { sessionID: SESSION, status: { type: "busy" } },
    });
    expect(ctx.ttft.has(SESSION)).toBe(true);
  });
});

describe("V1 native child — productive work survives the TTFT deadline", () => {
  const chain: ModelKey[] = ["a/one", "b/two"];
  const params = {
    sessionID: SESSION,
    agent: "scout",
    model: { providerID: "a", id: "one" },
  };

  async function armedChild(client: MockClient): Promise<PluginContext> {
    const ctx = createPluginContext({ logger, config: { ttftMs: 40 } });
    contexts.push(ctx);
    ctx.chains.set("scout", chain);
    await handleChatMessage(
      ctx,
      client,
      { sessionID: SESSION, agent: "scout" },
      { message: { model: { providerID: "a", modelID: "one" } } },
    );
    handleChatParams(ctx, client, params);
    expect(ctx.ttft.has(SESSION)).toBe(true);
    return ctx;
  }

  function childClient(): MockClient {
    return new MockClient({
      messages: [
        {
          info: { id: USER, role: "user", agent: "scout" },
          parts: [{ type: "text", text: "Investigate" }],
        },
      ],
      sessionInfo: { parentID: "parent-session" },
    });
  }

  test("a child that reasons and calls tools before any text is not aborted", async () => {
    const client = childClient();
    const ctx = await armedChild(client);
    await handleEvent(
      ctx,
      client,
      normalizeEventInput({ event: messageRow(ASSISTANT, "assistant") }),
    );
    await handleEvent(
      ctx,
      client,
      normalizeEventInput({
        event: partUpdated({
          messageID: ASSISTANT,
          type: "reasoning",
          text: "Search first",
          time: { start: 1 },
        }),
      }),
    );
    await handleEvent(
      ctx,
      client,
      normalizeEventInput({
        event: partUpdated({
          messageID: ASSISTANT,
          type: "tool",
          callID: "call_1",
          tool: "grep",
          state: { status: "running", input: {}, time: { start: 1 } },
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(false);
  });

  test("a truly silent child still hits the TTFT watchdog and is handed back", async () => {
    const client = childClient();
    const ctx = await armedChild(client);
    await handleEvent(
      ctx,
      client,
      normalizeEventInput({ event: messageRow(ASSISTANT, "assistant") }),
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expect(ctx.store.health.isInCooldown("a/one" as ModelKey)).toBe(true);
  });
});

// A V2 host whose event stream yields only what the test pushes, after the
// context hook has armed the timer.
function controllableV2Host() {
  const hooks = new Map<string, (event: unknown) => unknown>();
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  const session: V2SessionDomain = {
    get: async (input) => ({ id: input.sessionID }),
    context: async () => [],
    switchModel: async () => {},
    interrupt: async () => {},
    prompt: async () => {},
    hook: async (name, callback) => {
      hooks.set(name, callback);
      return { dispose: async () => {} };
    },
  };
  const host = {
    options: {
      agents: { general: { fallback_models: ["a/one", "b/two"] } },
    },
    session,
    event: {
      subscribe: () =>
        (async function* () {
          for (;;) {
            while (pending.length > 0) yield pending.shift();
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
    },
  };
  return {
    host,
    hooks,
    async push(event: unknown) {
      pending.push(event);
      wake?.();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

describe("V2 TTFT clear — assistant-generated stream events", () => {
  const v2 = (type: string, data: Record<string, unknown>) => ({
    id: "evt_1",
    type,
    data: { sessionID: SESSION, assistantMessageID: ASSISTANT, ...data },
  });

  async function armedV2() {
    const fixture = controllableV2Host();
    const cleanup = await setupV2Plugin(fixture.host);
    const clear = spyOn(TtftRegistry.prototype, "clear");
    await fixture.hooks.get("context")?.({
      sessionID: SESSION,
      agent: "general",
      model: { providerID: "a", id: "one" },
    });
    // Arming replaces any prior timer through clear(); count from here.
    const armed = clear.mock.calls.length;
    const clearedSinceArm = () =>
      clear.mock.calls
        .slice(armed)
        .filter(([sessionId]) => sessionId === SESSION).length;
    return { fixture, cleanup, clear, clearedSinceArm };
  }

  const clearing: Array<[string, unknown]> = [
    ["text delta", v2("session.text.delta", { ordinal: 0, delta: "PONG" })],
    [
      "reasoning delta",
      v2("session.reasoning.delta", { ordinal: 0, delta: "think" }),
    ],
    [
      "tool input start",
      v2("session.tool.input.started", { id: "call_1", name: "read" }),
    ],
    [
      "tool call",
      v2("session.tool.called", { id: "call_1", input: {}, executed: true }),
    ],
  ];

  for (const [name, event] of clearing) {
    test(`${name} clears the armed timer`, async () => {
      const { fixture, cleanup, clear, clearedSinceArm } = await armedV2();
      try {
        await fixture.push(event);
        expect(clearedSinceArm()).toBeGreaterThanOrEqual(1);
      } finally {
        await fixture.push(
          v2("session.text.delta", { ordinal: 0, delta: "done" }),
        );
        clear.mockRestore();
        cleanup?.();
      }
    });
  }

  const inert: Array<[string, unknown]> = [
    [
      "step start",
      v2("session.step.started", {
        agent: "general",
        model: { providerID: "a", id: "one" },
      }),
    ],
    ["empty reasoning delta", v2("session.reasoning.delta", { delta: "" })],
    ["retry scheduled", v2("session.retry.scheduled", { attempt: 2 })],
  ];

  for (const [name, event] of inert) {
    test(`${name} does not clear the armed timer`, async () => {
      const { fixture, cleanup, clear, clearedSinceArm } = await armedV2();
      try {
        await fixture.push(event);
        expect(clearedSinceArm()).toBe(0);
      } finally {
        // Release the live 60 s timer through the already-supported path.
        await fixture.push(
          v2("session.text.delta", { ordinal: 0, delta: "done" }),
        );
        clear.mockRestore();
        cleanup?.();
      }
    });
  }
});
