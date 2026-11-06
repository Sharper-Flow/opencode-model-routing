import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginContext,
  handleChatMessage,
  handleChatParams,
  handleEvent,
  handleV2RetrySignal,
  type EventInputShape,
} from "../src/plugin-internal.ts";
import { createLogger } from "../src/logging/logger.ts";
import { MockClient } from "./helpers/mock-client.ts";

const logger = createLogger({ minLevel: "error", write: () => {} });
const primary = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const key = "anthropic/claude-opus-5-5";
const error = {
  name: "APIError",
  data: {
    statusCode: 400,
    isRetryable: false,
    message:
      "This model does not support assistant message prefill. The conversation must end with a user message.",
  },
};
const client = () =>
  new MockClient({
    messages: [
      { info: { id: "user-1", role: "user", agent: "advisor" }, parts: [] },
    ],
    sessionInfo: { id: "failed", parentID: "parent" },
  });
const contexts: ReturnType<typeof createPluginContext>[] = [];
let dir: string;
const originalPath = process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-request-error-"));
});

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    ctx.ttft.clear("failed");
    ctx.ttft.clear("other");
  }
  if (originalPath === undefined)
    delete process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  else process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

function context() {
  process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = path.join(dir, "cooldown.json");
  const ctx = createPluginContext({ logger });
  ctx.chains.set("advisor", [key, "openai/gpt-6.1-sol"]);
  contexts.push(ctx);
  return ctx;
}

for (const source of ["session.error", "message.updated"] as const) {
  test(`${source}: request-shape 400 leaves other sessions and processes on the primary`, async () => {
    const ctx = context();
    const failedClient = client();
    await handleChatMessage(
      ctx,
      failedClient,
      { sessionID: "failed", agent: "advisor" },
      { message: { model: { ...primary } } },
    );
    handleChatParams(ctx, failedClient, {
      sessionID: "failed",
      agent: "advisor",
    });
    expect(ctx.ttft.has("failed")).toBe(true);
    await handleEvent(ctx, failedClient, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          sessionID: "failed",
          role: "assistant",
          agent: "advisor",
          ...primary,
        },
      },
    });
    const event: EventInputShape =
      source === "session.error"
        ? { type: source, properties: { sessionID: "failed", error } }
        : {
            type: source,
            properties: {
              info: {
                id: "assistant-1",
                sessionID: "failed",
                role: "assistant",
                agent: "advisor",
                ...primary,
                error,
              },
            },
          };
    await handleEvent(ctx, failedClient, event);

    expect(ctx.ttft.has("failed")).toBe(false);
    for (const observer of [context(), ctx]) {
      const output = { message: { model: { ...primary } } };
      await handleChatMessage(
        observer,
        client(),
        { sessionID: "other", agent: "advisor" },
        output,
      );
      expect(output.message.model).toEqual(primary);
      expect(observer.store.health.isInCooldown(key)).toBe(false);
    }
    expect(failedClient.callsTo("session.abort")).toHaveLength(0);
    expect(failedClient.callsTo("session.prompt")).toHaveLength(0);
    expect(ctx.ttft.has("failed")).toBe(false);
    expect(fs.existsSync(path.join(dir, "cooldown.json"))).toBe(false);
  });
}

test("V2 request-shape 400 leaves host decision and other sessions unchanged", async () => {
  const ctx = context();
  const failedClient = client();
  await handleChatMessage(
    ctx,
    failedClient,
    { sessionID: "failed", agent: "advisor" },
    { message: { model: { ...primary } } },
  );
  handleChatParams(ctx, failedClient, {
    sessionID: "failed",
    agent: "advisor",
  });
  expect(ctx.ttft.has("failed")).toBe(true);
  const raw = {
    sessionID: "failed",
    agent: "advisor",
    model: { providerID: primary.providerID, id: primary.modelID },
    error: { type: "api", status: 400, message: error.data.message },
    decision: { retry: false },
  };
  await handleV2RetrySignal(ctx, failedClient, raw);
  expect(raw.decision).toEqual({ retry: false });
  expect(ctx.ttft.has("failed")).toBe(false);
  expect(failedClient.calls).toHaveLength(0);
  for (const observer of [context(), ctx]) {
    expect(observer.store.health.isInCooldown(key)).toBe(false);
    const output = { message: { model: { ...primary } } };
    await handleChatMessage(
      observer,
      client(),
      { sessionID: "other", agent: "advisor" },
      output,
    );
    expect(output.message.model).toEqual(primary);
  }
});
