import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import { applyPreemptiveSkip } from "../src/preemptive.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

function output(providerID: string, modelID: string) {
  return { message: { model: { providerID, modelID } } };
}

describe("applyPreemptiveSkip", () => {
  test("current healthy → no mutation", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
  });

  test("current in cooldown → mutates to next healthy", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["a/one", "b/two", "c/three"]],
    ]);
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("no chain for agent → no mutation", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>();
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "no-chain", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
  });

  test("all alternatives cooled → no mutation, stays on cooled current", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    store.health.cooldown("b/two" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
  });

  test("missing identity redirects a cooled model when exactly one chain matches", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: null, output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("missing identity logs an error when no configured chain contains a cooled model", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const logs: string[] = [];
    const logger = createLogger({
      minLevel: "error",
      write: (line) => logs.push(line),
    });
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: null, output: out },
      store,
      new Map([["scout", ["b/two"]]]) as Map<string, ModelKey[]>,
      defaultConfig,
      logger,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    expect(logs.map((line) => JSON.parse(line).event)).toContain(
      "identity_unavailable.ambiguous_cooled_dispatch",
    );
  });

  test("missing identity logs an error instead of picking an ambiguous chain", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const logs: string[] = [];
    const logger = createLogger({
      minLevel: "error",
      write: (line) => logs.push(line),
    });
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: null, output: out },
      store,
      new Map([
        ["scout", ["a/one", "b/two"]],
        ["builder", ["a/one", "c/three"]],
      ]) as Map<string, ModelKey[]>,
      defaultConfig,
      logger,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    expect(logs.map((line) => JSON.parse(line).event)).toContain(
      "identity_unavailable.ambiguous_cooled_dispatch",
    );
  });

  test("tracks session.currentModel when healthy", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: output("a", "one") },
      store,
      chains,
      defaultConfig,
      silentLogger,
    );
    expect(store.sessions.get("s1").currentModel).toBe("a/one");
  });
});
