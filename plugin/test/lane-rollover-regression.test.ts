// Lane-rollover regression tests (2026-09-18 incident).
//
// Reproduces the three defects observed live on Concord lane sessions
// (concord-review, omr.log 02:09–02:15Z):
//   D1 — chain resolution picked anthropic/claude-opus-5 as nextHealthy
//        while the Claude Max availability snapshot said `unavailable`
//        (0/2 accounts usable). Both the subagent skip and the preemptive
//        redirect steered sessions onto a provider already known dead.
//   D2 — once a session's current rung was Anthropic-unavailable, the
//        replay guard suppressed every later failure signal: the chain
//        never advanced, the session wedged.
//   D3 — the failure path never aborted subagent sessions, so a wedged
//        child sat in the host's retry loop and the parent Task wait
//        never regained control.
//
// Chain under test mirrors concord-review's live shape:
//   sol (primary) → opus (anthropic) → M3.

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

const AGENT = "concord-review";
const SOL = "openai/gpt-5.6-sol" as ModelKey;
const OPUS = "anthropic/claude-opus-5" as ModelKey;
const M3 = "minimax-coding-plan/MiniMax-M3" as ModelKey;
const CHAIN: ModelKey[] = [SOL, OPUS, M3];

let dir: string;
let savedEnv: string | undefined;
let savedCooldown: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-lane-regression-"));
  savedEnv = process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY;
  savedCooldown = process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = path.join(dir, "cooldown.json");
});

afterEach(() => {
  if (savedEnv === undefined)
    delete process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY;
  else process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = savedEnv;
  process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = savedCooldown;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeUnavailableSnapshot(): void {
  const now = Date.now();
  const p = path.join(dir, "availability.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date(now).toISOString(),
      state: "unavailable",
      accounts: { configured: 2, enabled: 2, usable: 0 },
      retry_at: now + 300_000,
      marker: "CLAUDE_MAX_UNAVAILABLE",
    }),
  );
  fs.chmodSync(p, 0o600);
  process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = p;
}

function absentSnapshot(): void {
  process.env.OPENCODE_CLAUDE_MAX_AVAILABILITY = path.join(dir, "absent.json");
}

function messagesWithAgent(agent: string) {
  return [
    {
      info: { id: "msg-1", role: "user", agent },
      parts: [{ type: "text", text: "review the change" }],
    },
  ];
}

function subagentClient(sessionId: string) {
  return new MockClient({
    messages: messagesWithAgent(AGENT),
    sessionInfo: { id: sessionId, parentID: "ses_parent" },
  });
}

function quotaErrorEvent(
  sessionId: string,
  provider: string,
  model: string,
): EventInputShape {
  return {
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: {
        name: "APIError",
        data: {
          message: `5 hour usage limit reached on ${provider}/${model}`,
          statusCode: 429,
          isRetryable: false,
        },
      },
    },
  };
}

async function serveOn(
  ctx: ReturnType<typeof createPluginContext>,
  client: MockClient,
  sessionId: string,
  model: ModelKey,
): Promise<void> {
  const [providerID, ...rest] = model.split("/");
  const output = {
    message: { model: { providerID, modelID: rest.join("/") } },
  };
  await handleChatMessage(ctx, client, { sessionID: sessionId }, output);
}

describe("lane rollover regression (2026-09-18 incident)", () => {
  test("D1: subagent failure skips the anthropic rung the snapshot marks dead", async () => {
    writeUnavailableSnapshot();
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);

    const sessionId = "ses_rev_d1";
    const client = subagentClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);

    await handleEvent(
      ctx,
      client,
      quotaErrorEvent(sessionId, "openai", "gpt-5.6-sol"),
    );

    // The skip must advance PAST opus (anthropic, snapshot-unavailable)
    // to M3. Pre-fix this landed on opus and the session died there.
    const state = ctx.store.sessions.get(sessionId);
    expect(state.currentModel).toBe(M3);
    // Sol cooled; opus NOT cooled (it never served — no false benching).
    expect(ctx.store.health.isInCooldown(SOL)).toBe(true);
    expect(ctx.store.health.isInCooldown(OPUS)).toBe(false);
    // D3: the child is aborted so the parent regains control.
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
  });

  test("D1: preemptive redirect on a fresh spawn skips the dead anthropic rung", async () => {
    writeUnavailableSnapshot();
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);
    ctx.store.health.cooldown(SOL, 60_000, "quota_exhausted");

    // Fresh spawn: opencode is about to serve sol, which is cooled.
    const sessionId = "ses_rev_respawn";
    const client = subagentClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);

    // Pre-fix the redirect landed on opus (twice, live: 02:12:32Z and
    // 02:13:47Z) while the snapshot said 0/2 usable. Must land on M3.
    const out = ctx.store.sessions.get(sessionId);
    expect(out.currentModel).toBe(M3);
    expect(client.callsTo("session.abort")).toHaveLength(0);
  });

  test("D2: failure on a legitimately-served anthropic rung advances instead of wedging", async () => {
    writeUnavailableSnapshot();
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);

    // Session legitimately serving opus (Max drained AFTER the redirect).
    const sessionId = "ses_rev_d2";
    const client = subagentClient(sessionId);
    await serveOn(ctx, client, sessionId, OPUS);

    await handleEvent(
      ctx,
      client,
      quotaErrorEvent(sessionId, "anthropic", "claude-opus-5"),
    );

    // Pre-fix: the replay guard suppressed this failure signal entirely —
    // state pinned to opus, no abort, session wedged (live: kQhzi3Iy,
    // x6TAiVIC, yETu7FFz). Post-fix: bookkeeping advances to M3 and the
    // subagent is handed back to its parent.
    const state = ctx.store.sessions.get(sessionId);
    expect(state.currentModel).toBe(M3);
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.revert")).toHaveLength(0);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
  });

  test("D3: subagent failure with an exhausted chain aborts instead of hanging", async () => {
    absentSnapshot();
    const ctx = createPluginContext({ logger: silentLogger });
    // Only one rung: after it fails there is nowhere to roll.
    ctx.chains.set(AGENT, [SOL]);

    const sessionId = "ses_rev_d3";
    const client = subagentClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);

    await handleEvent(
      ctx,
      client,
      quotaErrorEvent(sessionId, "openai", "gpt-5.6-sol"),
    );

    expect(ctx.store.health.isInCooldown(SOL)).toBe(true);
    // Chain exhausted: abort hands control back; no in-place recovery.
    expect(client.callsTo("session.abort")).toHaveLength(1);
    expect(client.callsTo("session.prompt")).toHaveLength(0);
  });

  test("no snapshot → resolver behavior unchanged (fail-open)", async () => {
    absentSnapshot();
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.chains.set(AGENT, CHAIN);

    const sessionId = "ses_rev_nosnap";
    const client = subagentClient(sessionId);
    await serveOn(ctx, client, sessionId, SOL);

    await handleEvent(
      ctx,
      client,
      quotaErrorEvent(sessionId, "openai", "gpt-5.6-sol"),
    );

    // Without a snapshot the anthropic rung is a legal target (its health
    // is unknown): the skip advances to opus exactly as before.
    expect(ctx.store.sessions.get(sessionId).currentModel).toBe(OPUS);
    expect(client.callsTo("session.abort")).toHaveLength(1);
  });
});
