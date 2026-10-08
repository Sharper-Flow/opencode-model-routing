import { describe, expect, spyOn, test } from "bun:test";
import {
  createPluginContext,
  handleEvent,
  handleV2RetrySignal,
  type EventInputShape,
} from "../src/plugin-internal.ts";
import { createLogger } from "../src/logging/logger.ts";
import { FallbackStore } from "../src/state/store.ts";
import type { ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const RESET = NOW + 3 * 24 * 60 * 60 * 1000 + 817;
const PARENT = "openai/gpt-6.1-sol" as ModelKey;
const FAILED = "minimax-coding-plan/MiniMax-M3" as ModelKey;
const TEXT = `429: weekly usage limit reached. Your limit resets at ${new Date(RESET).toISOString()}`;
const silentLogger = createLogger({ minLevel: "error", write: () => {} });

function failureEvent(source: string): EventInputShape {
  const error = { name: "TransportFailureError", data: { message: TEXT } };
  if (source === "session.status") {
    return {
      type: source,
      properties: {
        sessionID: "s1",
        status: {
          type: "retry",
          message: TEXT,
          action: { provider: "minimax-coding-plan" },
        },
      },
    };
  }
  if (source === "session.error") {
    return { type: source, properties: { sessionID: "s1", error } };
  }
  return {
    type: "message.updated",
    properties: {
      sessionID: "s1",
      info: {
        id: "compact",
        role: "assistant",
        agent: "compaction",
        providerID: "minimax-coding-plan",
        modelID: "MiniMax-M3",
        error,
      },
    },
  };
}

describe("quota reset integration with in-flight attribution", () => {
  for (const source of ["session.status", "session.error", "message.updated"]) {
    for (const mode of ["message", "user-cap", "provider-cache"]) {
      test(`${source}: isolated compaction honors ${mode} without rotating the parent`, async () => {
        const clock = spyOn(Date, "now").mockReturnValue(NOW);
        const ctx = createPluginContext({
          logger: silentLogger,
          cooldownOverrides:
            mode !== "message" ? { quota_exhausted: 60_000 } : undefined,
        });
        ctx.store = new FallbackStore(() => NOW);
        const resolvedModels: ModelKey[] = [];
        ctx.quotaBoundary = async (model) => {
          resolvedModels.push(model);
          return mode === "provider-cache" ? RESET + 1000 : null;
        };
        const client = new MockClient({ sessionInfo: { id: "s1" } });
        const state = ctx.store.sessions.get("s1");
        state.agentName = "build";
        state.currentModel = PARENT;
        state.lastServedModel = PARENT;
        const before = { ...state };
        ctx.calls.open({
          sessionId: "s1",
          messageId: "compact",
          agent: "compaction",
          providerID: "minimax-coding-plan",
          modelID: "MiniMax-M3",
        });
        try {
          await handleEvent(ctx, client, failureEvent(source));
          expect(ctx.store.health.get(FAILED)).toMatchObject({
            lastCategory: "quota_exhausted",
            cooldownUntil:
              mode === "provider-cache"
                ? RESET + 1000
                : mode === "user-cap"
                  ? NOW + 60_000
                  : RESET,
          });
          expect(ctx.store.health.isInCooldown(PARENT)).toBe(false);
          expect(state).toEqual(before);
          expect(resolvedModels).toEqual([FAILED]);
          for (const method of [
            "session.abort",
            "session.revert",
            "session.prompt",
          ]) {
            expect(client.callsTo(method)).toHaveLength(0);
          }
        } finally {
          clock.mockRestore();
        }
      });
    }
  }

  test("V2 retry carries reset text through the shared cooldown owner", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(NOW);
    const ctx = createPluginContext({ logger: silentLogger });
    ctx.store = new FallbackStore(() => NOW);
    ctx.chains.set("build", [FAILED, PARENT]);
    const state = ctx.store.sessions.get("s1");
    state.currentModel = FAILED;
    state.lastServedModel = FAILED;
    ctx.replayTail = async () => {};
    const client = new MockClient({ sessionInfo: { id: "s1" } });
    try {
      await handleV2RetrySignal(ctx, client, {
        sessionID: "s1",
        agent: "build",
        model: { providerID: "minimax-coding-plan", id: "MiniMax-M3" },
        error: { type: "APIError", status: 429, message: TEXT },
        attempt: 1,
      });
      expect(ctx.store.health.get(FAILED).cooldownUntil).toBe(RESET);
      expect(state.currentModel).toBe(PARENT);
    } finally {
      clock.mockRestore();
    }
  });
});
