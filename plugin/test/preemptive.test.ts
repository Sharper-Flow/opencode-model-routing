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

describe("applyPreemptiveSkip — blocked_models", () => {
  function warnCapturingLogger(logs: string[]) {
    return createLogger({
      minLevel: "warn",
      write: (line) => logs.push(line),
    });
  }

  test("blocked current model redirects even while healthy (no cooldown)", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["a/one", "b/two", "c/three"]],
    ]);
    const blocked = new Map([["scout", new Set<ModelKey>(["x/cur"])]]);
    const out = output("x", "cur");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
      blocked,
    );
    // Redirect targets the first healthy non-blocked chain entry from the
    // top of the chain — regardless of the current model's cooldown state.
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    expect(store.sessions.get("s1").currentModel).toBe("a/one");
  });

  test("blocked current model redirects when it is also in cooldown", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("x/cur" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const blocked = new Map([["scout", new Set<ModelKey>(["x/cur"])]]);
    const out = output("x", "cur");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
      blocked,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
  });

  test("redirect skips blocked and cooled chain entries", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["a/one", "b/two", "c/three"]],
    ]);
    const blocked = new Map([["scout", new Set<ModelKey>(["x/cur", "b/two"])]]);
    const out = output("x", "cur");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
      blocked,
    );
    expect(out.message.model).toEqual({ providerID: "c", modelID: "three" });
  });

  test("all alternatives blocked or cooled → selection unchanged + preemptive.no_allowed_model", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const blocked = new Map([["scout", new Set<ModelKey>(["x/cur", "b/two"])]]);
    const logs: string[] = [];
    const out = output("x", "cur");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      warnCapturingLogger(logs),
      blocked,
    );
    expect(out.message.model).toEqual({ providerID: "x", modelID: "cur" });
    expect(logs.map((line) => JSON.parse(line).event)).toContain(
      "preemptive.no_allowed_model",
    );
  });

  test("blocklist with no configured chain → selection unchanged + preemptive.no_allowed_model", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>();
    const blocked = new Map([["scout", new Set<ModelKey>(["x/cur"])]]);
    const logs: string[] = [];
    const out = output("x", "cur");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      warnCapturingLogger(logs),
      blocked,
    );
    expect(out.message.model).toEqual({ providerID: "x", modelID: "cur" });
    expect(logs.map((line) => JSON.parse(line).event)).toContain(
      "preemptive.no_allowed_model",
    );
  });

  test("blocklist stays inactive when agent identity is unresolved", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    // Cooled current + exactly one matching chain → the cooldown path
    // redirects. The agent's blocklist would forbid the target (b/two),
    // but an unresolved identity must leave the blocklist inactive.
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const blocked = new Map([["scout", new Set<ModelKey>(["b/two"])]]);
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: null, output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
      blocked,
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("unresolved identity with blocked current model → no redirect, blocklist inactive", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const blocked = new Map([["scout", new Set<ModelKey>(["x/cur"])]]);
    const logs: string[] = [];
    const out = output("x", "cur");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: null, output: out },
      store,
      chains,
      defaultConfig,
      warnCapturingLogger(logs),
      blocked,
    );
    // Healthy current (cooldown-wise): no mutation; the blocklist must not
    // fire without a resolved agent identity.
    expect(out.message.model).toEqual({ providerID: "x", modelID: "cur" });
    expect(logs.map((line) => JSON.parse(line).event)).not.toContain(
      "preemptive.no_allowed_model",
    );
  });

  test("cooldown rotation of a non-blocked current also skips blocked targets", () => {
    const now = 1_000_000;
    const store = new FallbackStore(() => now);
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["a/one", "b/two", "c/three"]],
    ]);
    const blocked = new Map([["scout", new Set<ModelKey>(["b/two"])]]);
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
      blocked,
    );
    expect(out.message.model).toEqual({ providerID: "c", modelID: "three" });
  });

  test("redirect logs preemptive.redirected with a blocked reason", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const blocked = new Map([["scout", new Set<ModelKey>(["x/cur"])]]);
    const logs: string[] = [];
    const out = output("x", "cur");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      createLogger({ minLevel: "info", write: (line) => logs.push(line) }),
      blocked,
    );
    const redirected = logs
      .map((line) => JSON.parse(line))
      .find((e) => e.event === "preemptive.redirected");
    expect(redirected).toMatchObject({
      from: "x/cur",
      to: "a/one",
      agent: "scout",
      reason: "blocked",
    });
  });
});
