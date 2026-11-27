import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  createV2OrchestratorClient,
  handleEvent,
  handleTtftTimeout,
  setupV2Plugin,
} from "../src/plugin-internal.ts";
import { MockClient, type MockClientOptions } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });
const message = "Rate limit reached for requests";

function fixture(options: MockClientOptions = {}, chain = ["a/one", "b/two"]) {
  const ctx = createPluginContext({
    logger: silentLogger,
    config: { ttftMs: 1200, cooldownMsByCategory: { rate_limit: 61_000 } },
  });
  ctx.chains.set("scout", chain as `${string}/${string}`[]);
  const state = ctx.store.sessions.get("child");
  state.currentModel = "a/one";
  state.agentName = "scout";
  ctx.calls.open({
    sessionId: "child",
    messageId: "m1",
    agent: "scout",
    providerID: "a",
    modelID: "one",
  });
  const client = new MockClient({
    sessionInfo: { parentID: "parent" },
    ...options,
  });
  return { ctx, client };
}

async function failRequest(
  ctx: ReturnType<typeof fixture>["ctx"],
  client: MockClient,
  providerMessage: string | null = message,
) {
  await handleEvent(ctx, client, {
    type: "session.error",
    properties: {
      sessionID: "child",
      error: {
        name: "APIError",
        data: {
          statusCode: 429,
          ...(providerMessage === null ? {} : { message: providerMessage }),
        },
      },
    },
  });
}

test("availability suppression notifies before abort without a cooldown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omr-notice-"));
  const previous = process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY;
  const path = join(dir, "availability.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        schema: "opencode-claude-max/availability@1",
        version: 1,
        generated_at: new Date().toISOString(),
        state: "unavailable",
        accounts: { configured: 2, enabled: 2, usable: 0 },
        retry_at: Date.now() + 300_000,
        marker: "CLAUDE_MAX_UNAVAILABLE",
      }),
      { mode: 0o600 },
    );
    process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = path;
    const { ctx, client } = fixture();
    ctx.chains.set("scout", ["anthropic/claude", "b/two"]);
    ctx.store.sessions.get("child").currentModel = "anthropic/claude";
    await failRequest(ctx, client);
    const notice = noticeBeforeAbort(client);
    expect(notice.body.text).toContain(
      "Cause: the availability snapshot marks the current model unavailable",
    );
    expect(notice.body.text).not.toContain("avoided for");
    expect(notice.body.metadata).toMatchObject({
      reason: "availability",
      failedModel: "anthropic/claude",
      nextModel: "b/two",
    });
  } finally {
    if (previous === undefined)
      delete process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY;
    else process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, input] of [
  ["single line", message],
  ["multiline", "first line\nsecond line"],
  ["missing", null],
] as const) {
  test(`provider error text never reaches the parent: ${name}`, async () => {
    const { ctx, client } = fixture();
    await failRequest(ctx, client, input);
    const notice = noticeBeforeAbort(client);
    expect(
      notice.body.text.split("\n").find((line) => line.startsWith("Cause:")),
    ).toBe("Cause: provider error classified as rate_limit");
    const serialized = JSON.stringify(notice);
    for (const line of (input ?? "").split("\n").filter(Boolean)) {
      expect(serialized).not.toContain(line);
    }
  });
}

type Notice = {
  path: { id: string };
  body: {
    id: string;
    text: string;
    description: string;
    resume: boolean;
    metadata: Record<string, unknown>;
  };
};

function noticeBeforeAbort(client: MockClient): Notice {
  const handoff = client.calls.filter((call) =>
    ["session.synthetic", "session.abort"].includes(call.method),
  );
  expect(handoff.map((call) => call.method)).toEqual([
    "session.synthetic",
    "session.abort",
  ]);
  expect(handoff[1]?.args).toEqual({ path: { id: "child" } });
  expect((handoff[0]?.args as Notice).body.resume).toBe(false);
  return handoff[0]?.args as Notice;
}

test("failed request identifies the routing handoff to the parent before abort", async () => {
  const { ctx, client } = fixture();
  await failRequest(ctx, client);
  const notice = noticeBeforeAbort(client);
  expect(notice.path.id).toBe("parent");
  expect(notice.body.id).toMatch(/^msg_omr_handoff_child_\d+-\d+$/);
  expect(notice.body.description).toBe(
    "Routing handoff: scout helper cancelled",
  );
  expect(notice.body.metadata).toEqual({
    source: "opencode-model-routing",
    childID: "child",
    agent: "scout",
    reason: "rate_limit",
    failedModel: "a/one",
    nextModel: "b/two",
  });
  const text = notice.body.text;
  expect(
    text.startsWith(
      "OpenCode Model Routing cancelled subagent session child (scout).",
    ),
  ).toBe(true);
  expect(text).toMatch(/automatic routing handoff/i);
  expect(text).toMatch(/not an operator request/i);
  expect(text).toContain("Subagent cancelled");
  expect(text).toMatch(/no reason/i);
  expect(text).toMatch(/this notice.*reason/i);
  expect(text).toContain("Cause: provider error classified as rate_limit");
  expect(text).toContain("a/one");
  expect(text).toContain("avoided for about 2 minutes");
  expect(text.endsWith("A relaunch of the same agent starts on b/two.")).toBe(
    true,
  );
});

for (const [cooldownMs, expected] of [
  [60_000, "avoided for about 1 minute."],
  [30_000, "avoided for under a minute."],
] as const) {
  test(`formats a ${cooldownMs} ms cooldown`, async () => {
    const { ctx, client } = fixture();
    ctx.config.cooldownMsByCategory = { rate_limit: cooldownMs };
    await failRequest(ctx, client);
    expect(noticeBeforeAbort(client).body.text).toContain(expected);
  });
}

test("first-token timeout notices the parent before abort", async () => {
  const { ctx, client } = fixture();
  await handleTtftTimeout(ctx, client, "child", "scout");
  const notice = noticeBeforeAbort(client);
  expect(notice.body.text).toContain(
    "Cause: no first token within 1200 ms (ttft_timeout)",
  );
  expect(notice.body.text).toContain("a/one");
  expect(notice.body.text).toContain("avoided for about 5 minutes");
  expect(notice.body.metadata).toMatchObject({
    reason: "ttft_timeout",
    failedModel: "a/one",
    nextModel: "b/two",
  });
});

test("exhausted chain explains that relaunch repeats the failure", async () => {
  const { ctx, client } = fixture({}, ["a/one"]);
  await failRequest(ctx, client);
  const notice = noticeBeforeAbort(client);
  expect(notice.body.metadata.nextModel).toBeNull();
  expect(
    notice.body.text.endsWith(
      "No model in the agent's fallback chain is healthy, so a relaunch now repeats the failure.",
    ),
  ).toBe(true);
});

test("primary without a fallback chain is neither notified nor aborted", async () => {
  const { ctx, client } = fixture({ sessionInfo: {} }, []);
  await failRequest(ctx, client);
  expect(client.callsTo("session.synthetic")).toHaveLength(0);
  expect(client.callsTo("session.abort")).toHaveLength(0);
});

test("notice success logs the handoff reason", async () => {
  const { ctx, client } = fixture();
  const lines: string[] = [];
  ctx.logger = createLogger({
    minLevel: "info",
    write: (line) => lines.push(line),
  });
  await failRequest(ctx, client);
  const notices = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "fallback.subagent_notice");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    sessionId: "child",
    reason: "rate_limit",
  });
});

test("notice failure is logged once and does not prevent abort", async () => {
  const { ctx, client } = fixture({
    syntheticError: new Error("notice refused"),
  });
  const lines: string[] = [];
  ctx.logger = createLogger({
    minLevel: "error",
    write: (line) => lines.push(line),
  });
  await failRequest(ctx, client);
  noticeBeforeAbort(client);
  const errors = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "fallback.subagent_notice_failed");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    sessionId: "child",
    reason: "rate_limit",
    err: expect.stringContaining("notice refused"),
  });
});

test("a client without synthetic still aborts", async () => {
  const { ctx, client } = fixture();
  const session = client.session as Partial<typeof client.session>;
  delete session.synthetic;
  await failRequest(ctx, client);
  expect(client.callsTo("session.abort")).toHaveLength(1);
});

test("an unknown parent does not prevent abort", async () => {
  const { ctx, client } = fixture({ sessionInfo: {} });
  ctx.store.sessions.get("child").isSubagent = true;
  await failRequest(ctx, client);
  expect(client.callsTo("session.synthetic")).toHaveLength(0);
  expect(client.callsTo("session.abort")).toHaveLength(1);
});

test("two handoffs of the same child receive distinct ids", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(100_000);
  try {
    const first = fixture();
    await failRequest(first.ctx, first.client);
    const second = fixture();
    await failRequest(second.ctx, second.client);
    expect(noticeBeforeAbort(first.client).body.id).not.toBe(
      noticeBeforeAbort(second.client).body.id,
    );
  } finally {
    clock.mockRestore();
  }
});

function v2Fixture() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const hooks = new Map<string, (event: unknown) => unknown>();
  const session = {
    get: async () => ({ id: "child", parentID: "parent", agent: "scout" }),
    context: async () => [],
    switchModel: async (args: unknown) => {
      calls.push({ method: "switchModel", args });
    },
    interrupt: async (args: unknown) => {
      calls.push({ method: "interrupt", args });
    },
    prompt: async () => {},
    synthetic: async (args: unknown) => {
      calls.push({ method: "synthetic", args });
    },
    hook: async (name: string, callback: (event: unknown) => unknown) => {
      hooks.set(name, callback);
    },
  };
  return { calls, hooks, session };
}

test("V2 adapter maps synthetic envelope to flat host input", async () => {
  const { session, calls } = v2Fixture();
  const client = createV2OrchestratorClient(session);
  const synthetic = (
    client.session as unknown as {
      synthetic?: (args: unknown) => Promise<unknown>;
    }
  ).synthetic;
  expect(typeof synthetic).toBe("function");
  const body = {
    id: "msg_1",
    text: "notice",
    description: "handoff",
    resume: false,
    metadata: { source: "test" },
  };
  await synthetic?.({ path: { id: "parent" }, body });
  expect(calls).toEqual([
    { method: "synthetic", args: { sessionID: "parent", ...body } },
  ]);
});

test("V2 retry hook posts to parent before interrupting child", async () => {
  const { session, calls, hooks } = v2Fixture();
  const cleanup = await setupV2Plugin({
    session,
    options: { agents: { scout: { fallback_models: ["a/one", "b/two"] } } },
  });
  try {
    await hooks.get("context")?.({
      sessionID: "child",
      agent: "scout",
      model: { providerID: "a", id: "one" },
    });
    await hooks.get("retry")?.({
      sessionID: "child",
      agent: "scout",
      model: { providerID: "a", id: "one" },
      error: { type: "APIError", status: 429, message },
      attempt: 1,
      decision: { retry: true, delay: 1000 },
    });
    const handoff = calls.filter((call) =>
      ["synthetic", "interrupt"].includes(call.method),
    );
    expect(handoff.map((call) => call.method)).toEqual([
      "synthetic",
      "interrupt",
    ]);
    expect(handoff[0]?.args).toMatchObject({
      sessionID: "parent",
      resume: false,
      text: expect.stringContaining(
        "OpenCode Model Routing cancelled subagent session",
      ),
    });
    expect(JSON.stringify(handoff[0]?.args)).not.toContain(message);
    expect(handoff[1]?.args).toEqual({ sessionID: "child", resume: false });
  } finally {
    cleanup?.();
  }
});

test("V2 host without synthetic still interrupts the child", async () => {
  const fixture = v2Fixture();
  const { synthetic: _synthetic, ...session } = fixture.session;
  void _synthetic;
  const cleanup = await setupV2Plugin({
    session,
    options: { agents: { scout: { fallback_models: ["a/one", "b/two"] } } },
  });
  try {
    await fixture.hooks.get("context")?.({
      sessionID: "child",
      agent: "scout",
      model: { providerID: "a", id: "one" },
    });
    await fixture.hooks.get("retry")?.({
      sessionID: "child",
      agent: "scout",
      model: { providerID: "a", id: "one" },
      error: { type: "APIError", status: 429, message },
      attempt: 1,
      decision: { retry: true, delay: 1000 },
    });
    expect(fixture.calls.filter((call) => call.method === "synthetic")).toEqual(
      [],
    );
    expect(fixture.calls.filter((call) => call.method === "interrupt")).toEqual(
      [{ method: "interrupt", args: { sessionID: "child", resume: false } }],
    );
  } finally {
    cleanup?.();
  }
});
