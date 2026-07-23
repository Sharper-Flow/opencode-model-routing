import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginContext,
  handleChatMessage,
} from "../src/plugin-internal.ts";
import { createLogger } from "../src/logging/logger.ts";
import type { ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });
const AGENT = "adv-engineer";
const PRIMARY = "a/one" as ModelKey;
const FALLBACK = "b/two" as ModelKey;
const CHAIN: ModelKey[] = [PRIMARY, FALLBACK, "c/three"];

let dir: string;
let cooldownPath: string;
let originalCooldownPath: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-fresh-spawn-"));
  cooldownPath = path.join(dir, "cooldown.json");
  originalCooldownPath = process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = cooldownPath;
});

afterEach(() => {
  if (originalCooldownPath === undefined) {
    delete process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  } else {
    process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = originalCooldownPath;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function freshChildClient(sessionId: string) {
  return new MockClient({
    // Deliberately empty: first-hook production timing has no committed user
    // message, so this regression must never use messagesWithAgent(AGENT).
    messages: [],
    sessionInfo: { id: sessionId, parentID: "ses_parent", agent: AGENT },
  });
}

function primaryOutput() {
  return { message: { model: { providerID: "a", modelID: "one" } } };
}

async function routeFreshChild(
  ctx: ReturnType<typeof createPluginContext>,
  sessionId: string,
) {
  const client = freshChildClient(sessionId);
  const output = primaryOutput();
  await handleChatMessage(
    ctx,
    client,
    { sessionID: sessionId, agent: AGENT },
    output,
  );
  return { client, output };
}

describe("fresh sub-agent cooldown redirect through createPluginContext", () => {
  test("same-process active cooldown redirects before first provider dispatch", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);
    await ctx.store.health.cooldown(PRIMARY, 60_000, "quota_exhausted");

    const { client, output } = await routeFreshChild(
      ctx,
      "ses_fresh_same_process",
    );

    expect(output.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(client.callsTo("session.messages")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    expect(client.callsTo("session.abort")).toHaveLength(0);
    ctx.ttft.clear("ses_fresh_same_process");
  });

  test("fresh context reads persisted cooldown before first provider dispatch", async () => {
    const writer = createPluginContext({ logger: silentLogger });
    writer.chains.set(AGENT, CHAIN);
    await writer.store.health.cooldown(PRIMARY, 60_000, "quota_exhausted");
    expect(fs.existsSync(cooldownPath)).toBe(true);

    const reader = createPluginContext({ logger: silentLogger });
    reader.chains.set(AGENT, CHAIN);

    const { client, output } = await routeFreshChild(
      reader,
      "ses_fresh_readthrough",
    );

    expect(output.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(reader.store.health.isInCooldown(PRIMARY)).toBe(true);
    expect(client.callsTo("session.messages")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
    reader.ttft.clear("ses_fresh_readthrough");
  });

  test("resumed-child-shaped first hook retains structural agent redirect", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);
    await ctx.store.health.cooldown(PRIMARY, 60_000, "quota_exhausted");

    const { client, output } = await routeFreshChild(ctx, "ses_task_id_resume");

    expect(output.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(client.callsTo("session.messages")).toHaveLength(0);
    ctx.ttft.clear("ses_task_id_resume");
  });
});
