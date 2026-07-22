// Sub-agent fallover flow reproduction test (AC3 diagnostic).
//
// Simulates the FULL sub-agent fallover path end-to-end to pin whether the
// CooldownStore wiring + classifier fix restore same-process fallover, or
// whether a second defect exists in the detection/redirect path.
//
// Driven through real handler functions (handleEvent, handleChatMessage) with
// a real createPluginContext() production path, not an injected mock.
//
// Key finding (AC4): the fallover path depends on state.currentModel being
// set by a prior chat.message (applyPreemptiveSkip). If chat.message fires
// but resolveAgentName returns null (e.g. messages not yet committed for a
// freshly-spawned sub-agent), applyPreemptiveSkip returns early WITHOUT
// setting currentModel. The subsequent session.error's attemptFallback then
// hits `if (current)` → false → cooldown NOT marked. See scenario 4.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginContext,
  handleEvent,
  handleChatMessage,
  type EventInputShape,
} from "../src/plugin-internal.ts";
import { createLogger } from "../src/logging/logger.ts";
import { MockClient } from "./helpers/mock-client.ts";
import type { ModelKey } from "../src/types.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

const AGENT = "adv-engineer";
const PRIMARY = "opencode-go/kimi-k2.7-code" as ModelKey;
const FALLBACK_1 = "openai/gpt-5.6-terra" as ModelKey;
const CHAIN: ModelKey[] = [PRIMARY, FALLBACK_1, "minimax-coding-plan/MiniMax-M3", "opencode-go/mimo-v2.5-pro"];

let dir: string;
let cooldownPath: string;
let origEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-fallover-"));
  cooldownPath = path.join(dir, "cooldown.json");
  origEnv = process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = cooldownPath;
});

afterEach(() => {
  if (origEnv === undefined) delete process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  else process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = origEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

function messagesWithAgent(agent: string) {
  return [
    {
      info: { id: "msg-1", role: "user", agent },
      parts: [{ type: "text", text: "implement the task" }],
    },
  ];
}

function subagentSessionInfo(sessionId: string, parent = "ses_parent") {
  return { id: sessionId, parentID: parent };
}

function quotaErrorEvent(sessionId: string): EventInputShape {
  return {
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: {
        name: "APIError",
        data: {
          message: "5 hour usage limit reached. It will reset in 4 hours 21 minutes.",
          statusCode: 429,
          isRetryable: false,
        },
      },
    },
  };
}

// Full sub-agent setup: chat.message (sets currentModel) + sub-agent session info.
async function setupSubagent(
  ctx: ReturnType<typeof createPluginContext>,
  sessionId: string,
): Promise<MockClient> {
  const client = new MockClient({
    messages: messagesWithAgent(AGENT),
    sessionInfo: subagentSessionInfo(sessionId),
  });
  // Fire chat.message FIRST — this sets state.currentModel via applyPreemptiveSkip.
  const output = {
    message: { model: { providerID: "opencode-go", modelID: "kimi-k2.7-code" } },
  };
  await handleChatMessage(ctx, client, { sessionID: sessionId }, output);
  return client;
}

describe("Sub-agent fallover flow (AC3 diagnostic reproduction)", () => {
  test("scenario 1: chat.message → session.error → cooldown marked + persisted", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);

    const sessionId = "ses_sub_1";
    const client = await setupSubagent(ctx, sessionId);

    // Now fire the session.error.
    await handleEvent(ctx, client, quotaErrorEvent(sessionId));

    // Cooldown must be marked in-memory for the primary model.
    expect(ctx.store.health.isInCooldown(PRIMARY)).toBe(true);

    // Cooldown must be persisted to the file.
    expect(fs.existsSync(cooldownPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(cooldownPath, "utf-8"));
    expect(raw.entries[PRIMARY]).toBeDefined();

    // Sub-agent short-circuit: no abort/revert/prompt.
    expect(client.callsTo("session.abort")).toHaveLength(0);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
  });

  test("scenario 2: same-process re-spawn → preemptive redirect (in-memory cooldown)", async () => {
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);

    // Sub-agent fails → cooldown marked (same ctx.store).
    const failSession = "ses_sub_fail";
    const failClient = await setupSubagent(ctx, failSession);
    await handleEvent(ctx, failClient, quotaErrorEvent(failSession));
    expect(ctx.store.health.isInCooldown(PRIMARY)).toBe(true);

    // Parent re-spawns sub-agent → new session, same process (same ctx).
    const respawnSession = "ses_sub_respawn";
    const respawnClient = new MockClient({
      messages: messagesWithAgent(AGENT),
      sessionInfo: subagentSessionInfo(respawnSession),
    });
    const output = {
      message: {
        model: { providerID: "opencode-go", modelID: "kimi-k2.7-code" },
      },
    };
    await handleChatMessage(ctx, respawnClient, { sessionID: respawnSession }, output);

    // Preemptive skip should redirect to the first healthy fallback.
    expect(output.message.model?.providerID).toBe("openai");
    expect(output.message.model?.modelID).toBe("gpt-5.6-terra");
  });

  test("scenario 3: cross-process re-spawn → redirect via file read-through", async () => {
    // Process A: sub-agent fails → cooldown persisted.
    const ctxA = createPluginContext({ logger: silentLogger });
    ctxA.chains.set(AGENT, CHAIN);
    const failSession = "ses_sub_xproc_a";
    const failClient = await setupSubagent(ctxA, failSession);
    await handleEvent(ctxA, failClient, quotaErrorEvent(failSession));
    expect(fs.existsSync(cooldownPath)).toBe(true);

    // Process B: fresh context — read-through from file.
    const ctxB = createPluginContext({ logger: silentLogger });
    ctxB.chains.set(AGENT, CHAIN);
    expect(ctxB.store.health.isInCooldown(PRIMARY)).toBe(true);

    const respawnSession = "ses_sub_xproc_b";
    const respawnClient = new MockClient({
      messages: messagesWithAgent(AGENT),
      sessionInfo: subagentSessionInfo(respawnSession),
    });
    const output = {
      message: {
        model: { providerID: "opencode-go", modelID: "kimi-k2.7-code" },
      },
    };
    await handleChatMessage(ctxB, respawnClient, { sessionID: respawnSession }, output);

    expect(output.message.model?.providerID).toBe("openai");
    expect(output.message.model?.modelID).toBe("gpt-5.6-terra");
  });

  test("scenario 4 (DEFECT): session.error WITHOUT prior chat.message currentModel → cooldown NOT marked", async () => {
    // Reproduces the same-process mystery: if chat.message didn't set
    // state.currentModel (e.g. resolveAgentName failed because messages
    // weren't committed yet for a freshly-spawned sub-agent), the
    // orchestrator's `if (current)` guard skips the cooldown entirely.
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);

    const sessionId = "ses_sub_no_currentmodel";
    // NO chat.message fired — simulating agentName resolution failure at
    // chat.message time (state.currentModel stays undefined).
    const client = new MockClient({
      messages: messagesWithAgent(AGENT),
      sessionInfo: subagentSessionInfo(sessionId),
    });
    await handleEvent(ctx, client, quotaErrorEvent(sessionId));

    // DEFECT: currentModel was never set → `if (current)` is false →
    // cooldown NOT marked. This is the gap that explains the production
    // same-process re-spawn hitting the exhausted model.
    expect(ctx.store.health.isInCooldown(PRIMARY)).toBe(false);
    expect(fs.existsSync(cooldownPath)).toBe(false);
  });
});
