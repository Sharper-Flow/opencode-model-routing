import { describe, expect, test } from "bun:test";
import type { AvailabilitySnapshotV1 } from "../src/availability/snapshot.ts";
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

describe("applyPreemptiveSkip — return to original model", () => {
  // Seeds the state a session carries after OMR fell back: original a/one,
  // current (fallback) b/two, one fallback step recorded.
  function fallenBackStore(): FallbackStore {
    const store = new FallbackStore();
    const state = store.sessions.get("s1");
    state.currentModel = "b/two" as ModelKey;
    state.originalModel = "a/one" as ModelKey;
    state.fallbackDepth = 1;
    state.lastFallbackAt = 999;
    return store;
  }

  function infoLogger(logs: string[]) {
    return createLogger({ minLevel: "info", write: (line) => logs.push(line) });
  }

  function events(logs: string[]): Array<Record<string, unknown>> {
    return logs.map((line) => JSON.parse(line));
  }

  test("recovered original returns: redirect, depth reset, fallback.recovered", () => {
    const store = fallenBackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const logs: string[] = [];
    const out = output("b", "two");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      infoLogger(logs),
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    const state = store.sessions.get("s1");
    expect(state.currentModel).toBe("a/one");
    expect(state.originalModel).toBe("a/one");
    expect(state.fallbackDepth).toBe(0);
    expect(state.lastFallbackAt).toBe(0);
    const recovered = events(logs).find(
      (e) => e.event === "fallback.recovered",
    );
    expect(recovered).toMatchObject({
      sessionId: "s1",
      agent: "scout",
      from: "b/two",
      to: "a/one",
    });
  });

  test("original still in cooldown → no return, session stays on the fallback", () => {
    const store = fallenBackStore();
    store.health.cooldown("a/one" as ModelKey, 5_000);
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const logs: string[] = [];
    const out = output("b", "two");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      infoLogger(logs),
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(store.sessions.get("s1").currentModel).toBe("b/two");
    expect(store.sessions.get("s1").fallbackDepth).toBe(1);
    expect(events(logs).some((e) => e.event === "fallback.recovered")).toBe(
      false,
    );
  });

  test("original blocked for the agent → no return", () => {
    const store = fallenBackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const blocked = new Map([["scout", new Set<ModelKey>(["a/one"])]]);
    const out = output("b", "two");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
      blocked,
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(store.sessions.get("s1").currentModel).toBe("b/two");
  });

  test("availability snapshot vetoes the original → no return", () => {
    const store = new FallbackStore();
    const state = store.sessions.get("s1");
    state.currentModel = "b/two" as ModelKey;
    state.originalModel = "anthropic/claude" as ModelKey;
    state.fallbackDepth = 1;
    state.lastFallbackAt = 999;
    const chains = new Map<string, ModelKey[]>([
      ["scout", ["anthropic/claude", "b/two"]],
    ]);
    const snapshot: AvailabilitySnapshotV1 = {
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date(1_800_000_000_000).toISOString(),
      state: "unavailable",
      accounts: { configured: 2, enabled: 2, usable: 0 },
      retry_at: 1_800_300_000_000,
      marker: "CLAUDE_MAX_UNAVAILABLE",
    };
    const out = output("b", "two");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out, snapshot },
      store,
      chains,
      defaultConfig,
      silentLogger,
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(store.sessions.get("s1").currentModel).toBe("b/two");
  });

  test("family veto rejects the original → no return", () => {
    const store = fallenBackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const out = output("b", "two");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      silentLogger,
      undefined,
      (key) => key === ("a/one" as ModelKey),
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
    expect(store.sessions.get("s1").currentModel).toBe("b/two");
  });

  test("arriving model equals neither field → manual change, not a return", () => {
    const store = fallenBackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const logs: string[] = [];
    const out = output("c", "manual");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      infoLogger(logs),
    );
    expect(out.message.model).toEqual({ providerID: "c", modelID: "manual" });
    const state = store.sessions.get("s1");
    expect(state.currentModel).toBe("c/manual");
    expect(state.originalModel).toBe("c/manual");
    const names = events(logs).map((e) => e.event);
    expect(names).toContain("manual_model_change.reset_depth");
    expect(names).not.toContain("fallback.recovered");
  });

  test("arriving equals original but differs from current → healthy-branch recovery", () => {
    // The OpenCode 1 TUI keeps the user's selection, so the turn after the
    // cooldown expires arrives on the original by itself.
    const store = fallenBackStore();
    const chains = new Map<string, ModelKey[]>([["scout", ["a/one", "b/two"]]]);
    const logs: string[] = [];
    const out = output("a", "one");
    applyPreemptiveSkip(
      { sessionId: "s1", agentName: "scout", output: out },
      store,
      chains,
      defaultConfig,
      infoLogger(logs),
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    const state = store.sessions.get("s1");
    expect(state.currentModel).toBe("a/one");
    expect(state.fallbackDepth).toBe(0);
    expect(state.lastFallbackAt).toBe(0);
    const recovered = events(logs).find(
      (e) => e.event === "fallback.recovered",
    );
    expect(recovered).toMatchObject({
      sessionId: "s1",
      agent: "scout",
      from: "b/two",
      to: "a/one",
    });
    expect(
      events(logs).some((e) => e.event === "manual_model_change.reset_depth"),
    ).toBe(false);
  });
});
