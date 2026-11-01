import { describe, expect, test } from "bun:test";
import { loadFallbackChains } from "../src/config/loader.ts";
import { createLogger } from "../src/logging/logger.ts";
import { createPluginHooks } from "../src/plugin-internal.ts";
import { applyPreemptiveSkip } from "../src/preemptive.ts";
import { attemptFallback } from "../src/replay/orchestrator.ts";
import { resolveFallbackModel } from "../src/resolution/fallback-resolver.ts";
import { ModelHealthMap } from "../src/state/model-health.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const sol: ModelKey = "openai/gpt-6.1-sol";
const opus: ModelKey = "anthropic/claude-opus-5-5";
const third: ModelKey = "other/third";
const logger = createLogger({ minLevel: "error", write: () => {} });
const options = { agents: { build: { fallback_models: [opus] } } };

describe("configured priority ladder", () => {
  test("loads the primary before fallbacks without requiring it in options", () => {
    const { chains } = loadFallbackChains(
      { agent: { build: { model: sol } } },
      logger,
      options,
    );
    expect(chains.get("build")).toEqual([sol, opus]);
  });

  test("deduplicates the primary and keeps the eight-fallback allowance", () => {
    const fallbacks = Array.from(
      { length: 8 },
      (_, i): ModelKey => `other/model-${i}`,
    );
    expect(
      loadFallbackChains({ agent: { build: { model: sol } } }, logger, {
        agents: { build: { fallback_models: fallbacks } },
      }).chains.get("build"),
    ).toEqual([sol, ...fallbacks]);
    expect(
      loadFallbackChains({ agent: { build: { model: sol } } }, logger, {
        agents: { build: { fallback_models: [opus, sol, opus] } },
      }).chains.get("build"),
    ).toEqual([sol, opus]);
  });

  test("includes primary with both legacy chain sources", () => {
    for (const source of [
      { options: { fallback_models: [opus] } },
      { fallback_models: [opus] },
    ]) {
      expect(
        loadFallbackChains({
          agent: { build: { model: sol, ...source } },
        }).chains.get("build"),
      ).toEqual([sol, opus]);
    }
  });

  test("does not enable routing for primary-only or empty fallback agents", () => {
    expect(
      loadFallbackChains({ agent: { build: { model: sol } } }).chains.size,
    ).toBe(0);
    expect(
      loadFallbackChains({ agent: { build: { model: sol } } }, logger, {
        agents: { build: { fallback_models: [] } },
      }).chains.size,
    ).toBe(0);
  });

  test("ignores malformed configured models", () => {
    for (const model of [null, 12, {}, "invalid", "a/../b"]) {
      expect(
        loadFallbackChains(
          { agent: { build: { model } } },
          logger,
          options,
        ).chains.get("build"),
      ).toEqual([opus]);
    }
  });

  test("V1 hooks recover a manual last rung and refresh the primary on config reload", async () => {
    const client = new MockClient({
      messages: [
        {
          info: { id: "u1", role: "user", agent: "build" },
          parts: [{ type: "text", text: "continue" }],
        },
      ],
    });
    const hooks = await createPluginHooks(
      { client },
      { ...options, abortWaitMs: 0 },
    );
    await hooks.config?.({ agent: { build: { model: sol } } });
    const output = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-opus-5-5" },
      },
    };
    await hooks["chat.message"]?.({ sessionID: "v1", agent: "build" }, output);
    expect(output.message.model.providerID).toBe("anthropic");
    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "a1",
            role: "assistant",
            sessionID: "v1",
            agent: "build",
            providerID: "anthropic",
            modelID: "claude-opus-5-5",
            error: {
              name: "APIError",
              data: { statusCode: 500, message: "upstream failed" },
            },
          },
        },
      },
    });
    expect(client.callsTo("session.prompt")).toHaveLength(1);
    expect(client.callsTo("session.prompt")[0]?.args).toMatchObject({
      body: { model: { providerID: "openai", modelID: "gpt-6.1-sol" } },
    });
    await hooks.config?.({ agent: { build: { model: third } } });
    await hooks["chat.message"]?.(
      { sessionID: "v1-reload", agent: "build" },
      output,
    );
    expect(output.message.model).toEqual({
      providerID: "other",
      modelID: "third",
    });
  });

  test("lower and off-ladder failures pick the highest eligible rung", () => {
    const health = new ModelHealthMap();
    for (const failed of [opus, third, "manual/other" as ModelKey]) {
      expect(
        resolveFallbackModel(failed, [sol, opus, third], 0, health, 3),
      ).toBe(sol);
    }
  });

  test("excludes the failed key even with zero cooldown or duplicate entries", () => {
    expect(
      resolveFallbackModel(opus, [opus, opus], 0, new ModelHealthMap(), 3),
    ).toBeNull();
  });

  test("all eligibility vetoes apply to higher rungs; depth still terminates", () => {
    const health = new ModelHealthMap(() => 1000);
    const ladder = [sol, third, opus];
    expect(
      resolveFallbackModel(opus, ladder, 0, health, 3, new Set([sol])),
    ).toBe(third);
    expect(
      resolveFallbackModel(
        opus,
        ladder,
        0,
        health,
        3,
        undefined,
        (m) => m === sol,
      ),
    ).toBe(third);
    expect(
      resolveFallbackModel(
        opus,
        ladder,
        0,
        health,
        3,
        undefined,
        undefined,
        (m) => m === sol,
      ),
    ).toBe(third);
    health.cooldown(sol, 5000);
    health.cooldown(third, 5000);
    expect(resolveFallbackModel(opus, ladder, 0, health, 3)).toBeNull();
    expect(resolveFallbackModel(opus, [sol, opus], 3, health, 3)).toBeNull();
  });

  test("preemptive handling preserves healthy manual selection and skips cooled last rung", async () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["build", [sol, opus]]]);
    const output = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-opus-5-5" },
      },
    };
    const input = { sessionId: "priority", agentName: "build", output };
    applyPreemptiveSkip(input, store, chains, defaultConfig, logger);
    expect(output.message.model.providerID).toBe("anthropic");
    await store.health.cooldown(opus, 5000);
    applyPreemptiveSkip(input, store, chains, defaultConfig, logger);
    expect(output.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-6.1-sol",
    });
  });

  test("recovery cools the served failure and selects primary, then stops without oscillation", async () => {
    const store = new FallbackStore();
    const state = store.sessions.get("priority");
    state.currentModel = opus;
    state.lastServedModel = opus;
    const client = new MockClient();
    const switched: ModelKey[] = [];
    const args = {
      sessionId: "priority",
      reason: "quota_exhausted" as const,
      chain: [sol, opus],
      client,
      store,
      config: { ...defaultConfig, dedupWindowMs: 0 },
      logger,
      replayTail: async ({ next }: { next: ModelKey }) => {
        expect(store.health.isInCooldown(opus)).toBe(true);
        switched.push(next);
      },
    };
    expect(
      (await attemptFallback({ ...args, failedModel: opus })).fallbackModel,
    ).toBe(sol);
    expect(store.health.isInCooldown(sol)).toBe(false);
    expect((await attemptFallback({ ...args, failedModel: sol })).error).toBe(
      "exhausted",
    );
    expect(switched).toEqual([sol]);
  });

  test("recovery excludes attributed failure instead of bookkeeping-advanced current", async () => {
    const store = new FallbackStore();
    const state = store.sessions.get("attribution");
    state.currentModel = sol;
    state.lastServedModel = opus;
    const result = await attemptFallback({
      sessionId: "attribution",
      reason: "unknown",
      chain: [sol, opus, third],
      client: new MockClient(),
      store,
      config: { ...defaultConfig, cooldownMs: 0 },
      logger,
      failedModel: opus,
      replayTail: async () => {},
    });
    expect(result.fallbackModel).toBe(sol);
  });
});
