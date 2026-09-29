// v2-plugin.test.ts — OpenCode 2 integration fixture tests.
//
// Drives the V2 setup + adapters against a mock V2 plugin ctx (structural
// { options, session, event } host, flat session parameters, hook
// registration, event subscription). Covers the approved end-state checks:
// the V2 entrypoint loads and registers hooks, a classified failure advances
// the chain exactly once through the switchModel + interrupt(resume) tail
// with no duplicate replay, the context hook applies preemptive redirects
// via switchModel, and cleanup aborts the event subscription.

import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging/logger.ts";
import {
  applyLoadedChains,
  classifyV2RetryError,
  createPluginContext,
  createV2OrchestratorClient,
  createV2PluginDefinition,
  createV2ReplayTail,
  handleTtftTimeout,
  handleV2Context,
  isV2PluginHost,
  normalizeV2Event,
  PLUGIN_ID,
  setupV2Plugin,
} from "../src/plugin-internal.ts";
import { loadFallbackChains } from "../src/config/loader.ts";
import type { V2SessionDomain } from "../src/plugin-internal.ts";
import type { ModelKey } from "../src/types.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

interface RecordedCall {
  method: string;
  args: unknown;
}

const CHAIN: ModelKey[] = [
  "anthropic/claude-opus-4-1",
  "openai/gpt-5.2",
] as ModelKey[];

function createMockV2Session() {
  const calls: RecordedCall[] = [];
  const registeredHooks = new Map<string, (event: unknown) => unknown>();
  const sessions = new Map<string, Record<string, unknown>>();
  let contextMessages: unknown[] = [];
  const session: V2SessionDomain = {
    get: async (input) => {
      calls.push({ method: "session.get", args: input });
      const id = input.sessionID as string;
      return sessions.get(id) ?? { id };
    },
    context: async (input) => {
      calls.push({ method: "session.context", args: input });
      return contextMessages;
    },
    switchModel: async (input) => {
      calls.push({ method: "session.switchModel", args: input });
    },
    interrupt: async (input) => {
      calls.push({ method: "session.interrupt", args: input });
    },
    prompt: async (input) => {
      calls.push({ method: "session.prompt", args: input });
    },
    hook: async (name, callback) => {
      registeredHooks.set(name, callback);
      return { dispose: async () => {} };
    },
  };
  return {
    session,
    calls,
    registeredHooks,
    sessions,
    setContextMessages(messages: unknown[]) {
      contextMessages = messages;
    },
    callsTo(method: string): unknown[] {
      return calls.filter((c) => c.method === method).map((c) => c.args);
    },
  };
}

function createMockV2Host(options: unknown) {
  const mock = createMockV2Session();
  let subscriptionSignal: AbortSignal | undefined;
  const events: unknown[] = [];
  const host = {
    options,
    session: mock.session,
    event: {
      subscribe: (opts?: { signal?: AbortSignal }) => {
        subscriptionSignal = opts?.signal;
        const source = events.slice();
        return (async function* () {
          for (const event of source) {
            yield event;
          }
          // Hang after replaying recorded events, like a live stream would.
          await new Promise<void>(() => {});
        })();
      },
    },
  };
  return {
    host,
    mock,
    getSignal: () => subscriptionSignal,
    recordEvent(event: unknown) {
      events.push(event);
    },
  };
}

function retryEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionID: "s1",
    agent: "general",
    model: { providerID: "anthropic", id: "claude-opus-4-1" },
    error: { type: "APIError", status: 500, message: "upstream exploded" },
    attempt: 1,
    decision: { retry: true, delay: 1000 },
    ...overrides,
  };
}

describe("isV2PluginHost", () => {
  test("accepts the structural ctx and rejects anything missing the session domain", () => {
    const { host } = createMockV2Host({});
    expect(isV2PluginHost(host)).toBe(true);
    expect(isV2PluginHost({})).toBe(false);
    expect(isV2PluginHost({ session: {} })).toBe(false);
    expect(isV2PluginHost(null)).toBe(false);
    expect(isV2PluginHost({ session: { hook: () => {} } })).toBe(false);
  });
});

describe("setupV2Plugin — lifecycle", () => {
  test("registers context + retry hooks, loads chains from ctx.options, and cleanup aborts the event subscription", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
      model_families: { "openai/gpt-5.2": "gpt" },
    });
    fixture.recordEvent({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "hi", sessionID: "s1" } },
    });
    const cleanup = await setupV2Plugin(fixture.host);
    expect(typeof cleanup).toBe("function");
    expect(fixture.mock.registeredHooks.has("context")).toBe(true);
    expect(fixture.mock.registeredHooks.has("retry")).toBe(true);
    expect(fixture.getSignal()?.aborted).toBe(false);
    cleanup?.();
    expect(fixture.getSignal()?.aborted).toBe(true);
  });

  test("rejects a host without the session domain", async () => {
    await expect(setupV2Plugin({ options: {} })).rejects.toThrow(
      "invalid OpenCode 2 plugin context",
    );
  });

  test("classified failure advances through the V2 tail and never the V1 revert/prompt path", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
    });
    await setupV2Plugin(fixture.host);
    // Fire the context hook so the session state has a current model.
    await fixture.mock.registeredHooks.get("context")?.({
      sessionID: "s1",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
    });
    await fixture.mock.registeredHooks.get("retry")?.(retryEvent());
    const switches = fixture.mock.callsTo("session.switchModel");
    expect(switches.length).toBe(1);
    expect(switches[0]).toMatchObject({
      sessionID: "s1",
      model: { providerID: "openai", id: "gpt-5.2" },
    });
    // The replay tail switches the model; the rescheduled host retry is the
    // replay, so the tail never interrupts under V2, and the V1-only
    // revert/prompt surfaces must never fire.
    expect(fixture.mock.callsTo("session.interrupt").length).toBe(0);
    expect(fixture.mock.callsTo("session.prompt").length).toBe(0);
  });
});

describe("V2 retry hook — fallback once, no duplicate replay", () => {
  test("classified failure advances the chain and approves exactly one switched host retry", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
    });
    await setupV2Plugin(fixture.host);
    const retry = fixture.mock.registeredHooks.get("retry")!;

    const first = retryEvent();
    await retry(first);
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(1);
    // The replay is the host retry on the switched model: approve one
    // rescheduled attempt at a short delay.
    expect(first.decision).toEqual({ retry: true, delay: 250 });
    // The tail never interrupts; the V1 prompt surface never fires.
    expect(fixture.mock.callsTo("session.interrupt").length).toBe(0);
    expect(fixture.mock.callsTo("session.prompt").length).toBe(0);

    // A duplicate copy of the same failure (same type/status/message/attempt)
    // must not advance again — failure dedup collapses it before the replay.
    await retry(retryEvent());
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(1);
    expect(fixture.mock.callsTo("session.interrupt").length).toBe(0);
  });

  test("a later attempt of the same category is a distinct failure and advances again", async () => {
    const fixture = createMockV2Host({
      agents: {
        general: { fallback_models: ["openai/gpt-5.2", "google/gemini-3-pro"] },
      },
    });
    await setupV2Plugin(fixture.host);
    const retry = fixture.mock.registeredHooks.get("retry")!;
    // The context hook settles the session on the second chain entry so the
    // first retry advances from there.
    await fixture.mock.registeredHooks.get("context")?.({
      sessionID: "s1",
      agent: "general",
      model: { providerID: "openai", id: "gpt-5.2" },
    });
    await retry(retryEvent({ model: { providerID: "openai", id: "gpt-5.2" } }));
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(1);
    expect(fixture.mock.callsTo("session.switchModel")[0]).toMatchObject({
      model: { providerID: "google", id: "gemini-3-pro" },
    });
  });

  test("unclassified errors leave the host retry decision untouched", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
    });
    await setupV2Plugin(fixture.host);
    const event = retryEvent({
      error: { type: "MessageAbortedError", message: "user aborted" },
    });
    await fixture.mock.registeredHooks.get("retry")?.(event);
    expect((event.decision as { retry: boolean }).retry).toBe(true);
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(0);
  });

  test("no chain for the agent → no veto, no replay", async () => {
    const fixture = createMockV2Host({ agents: {} });
    await setupV2Plugin(fixture.host);
    const event = retryEvent({ agent: "scout" });
    await fixture.mock.registeredHooks.get("retry")?.(event);
    expect((event.decision as { retry: boolean }).retry).toBe(true);
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(0);
    expect(fixture.mock.callsTo("session.interrupt").length).toBe(0);
  });

  test("subagent failure short-circuits: cooldown + state advance, abort hands back to parent", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
    });
    fixture.mock.sessions.set("child", {
      id: "child",
      parentID: "parent",
      agent: "general",
    });
    await setupV2Plugin(fixture.host);
    await fixture.mock.registeredHooks.get("context")?.({
      sessionID: "child",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
    });
    const lastEvent = retryEvent({ sessionID: "child" });
    await fixture.mock.registeredHooks.get("retry")?.(lastEvent);
    // Subagent short-circuit: no in-place replay; the terminal abort hands
    // the parent Task wait back control (interrupt with resume:false) and
    // the host retry is vetoed so nothing re-serves the aborted child.
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(0);
    const interrupts = fixture.mock.callsTo("session.interrupt");
    expect(interrupts.length).toBe(1);
    expect(interrupts[0]).toMatchObject({
      sessionID: "child",
      resume: false,
    });
    expect((lastEvent.decision as { retry: boolean }).retry).toBe(false);
  });
});

describe("V2 context hook — preemptive redirect via switchModel", () => {
  test("cooled current model redirects to the first healthy chain entry", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
    });
    await setupV2Plugin(fixture.host);
    // The setup does not expose ctx, so the test rebuilds the same shared
    // context (identical options → identical chains) to cool a model and
    // drive handleV2Context directly. The cooldown store path is unwritable
    // under the test preload, so the cooldown stays in-process.
    const ctx = createPluginContext({
      logger: silentLogger,
      pluginOptions: { agents: { general: { fallback_models: CHAIN } } },
    });
    applyLoadedChains(
      ctx,
      loadFallbackChains(undefined, silentLogger, ctx.pluginOptions),
    );
    await ctx.store.health.cooldown(
      "anthropic/claude-opus-4-1",
      60_000,
      "rate_limit",
    );
    await handleV2Context(
      ctx,
      createV2OrchestratorClient(fixture.mock.session),
      fixture.mock.session,
      {
        sessionID: "s2",
        agent: "general",
        model: { providerID: "anthropic", id: "claude-opus-4-1" },
      },
    );
    const switches = fixture.mock.callsTo("session.switchModel");
    expect(switches.length).toBe(1);
    expect(switches[0]).toMatchObject({
      sessionID: "s2",
      model: { providerID: "openai", id: "gpt-5.2" },
    });
  });

  test("healthy model leaves routing untouched", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
    });
    await setupV2Plugin(fixture.host);
    await fixture.mock.registeredHooks.get("context")?.({
      sessionID: "s3",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
    });
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(0);
  });

  test("redirect applies to the session BEFORE the served model is recorded", async () => {
    const ctx = createPluginContext({
      logger: silentLogger,
      pluginOptions: { agents: { general: { fallback_models: CHAIN } } },
    });
    applyLoadedChains(
      ctx,
      loadFallbackChains(undefined, silentLogger, ctx.pluginOptions),
    );
    await ctx.store.health.cooldown(
      "anthropic/claude-opus-4-1",
      60_000,
      "rate_limit",
    );
    const mock = createMockV2Session();
    const seenAtSwitch: Array<string | null | undefined> = [];
    const originalSwitch = mock.session.switchModel;
    mock.session.switchModel = async (input) => {
      // At switch time the bookkeeping must not yet claim the redirect
      // target is serving — the request has not moved yet.
      seenAtSwitch.push(ctx.store.sessions.get("s9").lastServedModel);
      return originalSwitch(input);
    };
    await handleV2Context(
      ctx,
      createV2OrchestratorClient(mock.session),
      mock.session,
      {
        sessionID: "s9",
        agent: "general",
        model: { providerID: "anthropic", id: "claude-opus-4-1" },
      },
    );
    // The switch observed the pre-redirect state (no served-model record of
    // the target yet), and the record never claims the target: the host
    // serves this request on the model it fixed before the hook.
    expect(seenAtSwitch.length).toBe(1);
    expect(seenAtSwitch[0]).not.toBe("openai/gpt-5.2");
    expect(ctx.store.sessions.get("s9").lastServedModel).toBe(
      "anthropic/claude-opus-4-1",
    );
  });

  test("failed redirect rolls the served-model record back to the model that will serve", async () => {
    const ctx = createPluginContext({
      logger: silentLogger,
      pluginOptions: { agents: { general: { fallback_models: CHAIN } } },
    });
    applyLoadedChains(
      ctx,
      loadFallbackChains(undefined, silentLogger, ctx.pluginOptions),
    );
    await ctx.store.health.cooldown(
      "anthropic/claude-opus-4-1",
      60_000,
      "rate_limit",
    );
    const mock = createMockV2Session();
    mock.session.switchModel = async () => {
      throw new Error("host refused the switch");
    };
    await handleV2Context(
      ctx,
      createV2OrchestratorClient(mock.session),
      mock.session,
      {
        sessionID: "s10",
        agent: "general",
        model: { providerID: "anthropic", id: "claude-opus-4-1" },
      },
    );
    // The request still runs on the original model, so the record must name
    // the original model — never the redirect target that was not applied.
    expect(ctx.store.sessions.get("s10").lastServedModel).toBe(
      "anthropic/claude-opus-4-1",
    );
  });

  test("recovered original returns via switchModel and resets the fallback bookkeeping", async () => {
    const logs: string[] = [];
    const ctx = createPluginContext({
      logger: createLogger({
        minLevel: "info",
        write: (line) => logs.push(line),
      }),
      pluginOptions: { agents: { general: { fallback_models: CHAIN } } },
    });
    applyLoadedChains(
      ctx,
      loadFallbackChains(undefined, silentLogger, ctx.pluginOptions),
    );
    // Session state as the replay tail left it: OMR fell back to the openai
    // rung and the host was switched onto it.
    const state = ctx.store.sessions.get("s1");
    state.currentModel = "openai/gpt-5.2";
    state.originalModel = "anthropic/claude-opus-4-1";
    state.fallbackDepth = 1;
    state.lastFallbackAt = 1234;
    const mock = createMockV2Session();
    let recoveredBeforeSwitch: boolean | undefined;
    const originalSwitch = mock.session.switchModel;
    mock.session.switchModel = async (input) => {
      // A recovery the switch has not yet confirmed must not be logged.
      recoveredBeforeSwitch = logs.some(
        (l) => JSON.parse(l).event === "fallback.recovered",
      );
      return originalSwitch(input);
    };
    await handleV2Context(
      ctx,
      createV2OrchestratorClient(mock.session),
      mock.session,
      {
        sessionID: "s1",
        agent: "general",
        model: { providerID: "openai", id: "gpt-5.2" },
      },
    );
    // The next agent-loop request arrives on the fallback; the recovered
    // original must take over through switchModel.
    const switches = mock.callsTo("session.switchModel");
    expect(switches.length).toBe(1);
    expect(switches[0]).toMatchObject({
      sessionID: "s1",
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
    });
    expect(state.currentModel).toBe("anthropic/claude-opus-4-1");
    expect(state.fallbackDepth).toBe(0);
    expect(state.lastFallbackAt).toBe(0);
    // fallback.recovered logs only after the switch resolves — never before.
    expect(recoveredBeforeSwitch).toBe(false);
    const recovered = logs
      .map((line) => JSON.parse(line))
      .filter((e) => e.event === "fallback.recovered");
    expect(recovered.length).toBe(1);
    expect(recovered[0]).toMatchObject({
      sessionId: "s1",
      agent: "general",
      from: "openai/gpt-5.2",
      to: "anthropic/claude-opus-4-1",
      reason: "recovered",
    });
    // The host serves THIS request on the model it fixed before the hook —
    // the fallback. The return takes over from the next agent-loop request.
    expect(state.lastServedModel).toBe("openai/gpt-5.2");
  });

  test("a failed return switch leaves the routing state naming the fallback that serves", async () => {
    const logs: string[] = [];
    const ctx = createPluginContext({
      logger: createLogger({
        minLevel: "info",
        write: (line) => logs.push(line),
      }),
      pluginOptions: { agents: { general: { fallback_models: CHAIN } } },
    });
    applyLoadedChains(
      ctx,
      loadFallbackChains(undefined, silentLogger, ctx.pluginOptions),
    );
    const state = ctx.store.sessions.get("s1");
    state.currentModel = "openai/gpt-5.2";
    state.originalModel = "anthropic/claude-opus-4-1";
    state.fallbackDepth = 1;
    state.lastFallbackAt = 1234;
    const mock = createMockV2Session();
    mock.session.switchModel = async (input) => {
      // Record the refused attempt, then refuse it like a host would.
      mock.calls.push({ method: "session.switchModel", args: input });
      throw new Error("host refused the switch");
    };
    await handleV2Context(
      ctx,
      createV2OrchestratorClient(mock.session),
      mock.session,
      {
        sessionID: "s1",
        agent: "general",
        model: { providerID: "openai", id: "gpt-5.2" },
      },
    );
    // The switch was attempted and refused, so the request still serves the
    // fallback. Every routing field must go back to pre-return values — a
    // stale currentModel would read the next arrival as a manual change and
    // crown the fallback the new original.
    expect(mock.callsTo("session.switchModel").length).toBe(1);
    expect(state.currentModel).toBe("openai/gpt-5.2");
    expect(state.originalModel).toBe("anthropic/claude-opus-4-1");
    expect(state.fallbackDepth).toBe(1);
    expect(state.lastFallbackAt).toBe(1234);
    expect(state.lastServedModel).toBe("openai/gpt-5.2");
    // A rejected switch logs the failure and no redirect or recovery event:
    // the books must not record a return that never happened.
    const names = logs.map((line) => JSON.parse(line).event);
    expect(names).toContain("routing.redirect_apply_failed");
    expect(names).not.toContain("fallback.recovered");
    expect(names).not.toContain("preemptive.redirected");
  });

  test("a TTFT timeout on the request after a V2 return cools the fallback that served, not the original", async () => {
    const ctx = createPluginContext({
      logger: silentLogger,
      pluginOptions: { agents: { general: { fallback_models: CHAIN } } },
    });
    applyLoadedChains(
      ctx,
      loadFallbackChains(undefined, silentLogger, ctx.pluginOptions),
    );
    const state = ctx.store.sessions.get("s1");
    state.currentModel = "openai/gpt-5.2";
    state.originalModel = "anthropic/claude-opus-4-1";
    state.fallbackDepth = 1;
    state.lastFallbackAt = 1234;
    const mock = createMockV2Session();
    await handleV2Context(
      ctx,
      createV2OrchestratorClient(mock.session),
      mock.session,
      {
        sessionID: "s1",
        agent: "general",
        model: { providerID: "openai", id: "gpt-5.2" },
      },
    );
    // The return switch landed, but this request still serves the fallback
    // the host fixed before the hook ran.
    expect(state.lastServedModel).toBe("openai/gpt-5.2");
    // A model-less failure (TTFT) attributes through lastServedModel, so the
    // fallback cools — never the recovered original that did not serve.
    await handleTtftTimeout(
      ctx,
      createV2OrchestratorClient(mock.session),
      "s1",
      "general",
    );
    expect(ctx.store.health.isInCooldown("openai/gpt-5.2")).toBe(true);
    expect(ctx.store.health.isInCooldown("anthropic/claude-opus-4-1")).toBe(
      false,
    );
    // The chain is exhausted after the fallback cools, so no further switch
    // fires: only the return switch ran.
    expect(mock.callsTo("session.switchModel").length).toBe(1);
  });
});

describe("V2 adapters", () => {
  test("revert throws — the V2 tail owns recovery, the V1 tail must not run", async () => {
    const mock = createMockV2Session();
    const client = createV2OrchestratorClient(mock.session);
    await expect(
      client.session.revert({ path: { id: "s1" }, body: { messageID: "m1" } }),
    ).rejects.toThrow("V2 replay tail owns recovery");
  });

  test("wraps V2 reads in the { data } envelope the shared code unwraps", async () => {
    const mock = createMockV2Session();
    mock.sessions.set("s1", { id: "s1", parentID: "p1" });
    const client = createV2OrchestratorClient(mock.session);
    const info = await client.session.get({ path: { id: "s1" } });
    expect(info).toEqual({ data: { id: "s1", parentID: "p1" } });
    mock.setContextMessages([
      { info: { id: "m1", role: "user", agent: "general" }, parts: [] },
    ]);
    const messages = await client.session.messages({ path: { id: "s1" } });
    expect(messages).toEqual({
      data: [{ info: { id: "m1", role: "user", agent: "general" }, parts: [] }],
    });
  });

  test("replay tail maps model keys onto V2 { providerID, id } and switches without interrupting", async () => {
    const mock = createMockV2Session();
    const tail = createV2ReplayTail(mock.session);
    await tail({ sessionId: "s1", next: "openai/gpt-5.2" as ModelKey });
    expect(mock.callsTo("session.switchModel")[0]).toMatchObject({
      sessionID: "s1",
      model: { providerID: "openai", id: "gpt-5.2" },
    });
    // The rescheduled host retry re-drives the loop; the tail never
    // interrupts a settled turn.
    expect(mock.callsTo("session.interrupt").length).toBe(0);
  });

  test("a TTFT-timeout replay switches the model AND interrupts with resume:true", async () => {
    const mock = createMockV2Session();
    const tail = createV2ReplayTail(mock.session);
    await tail({
      sessionId: "s1",
      next: "openai/gpt-5.2" as ModelKey,
      reason: "ttft_timeout",
    });
    expect(mock.callsTo("session.switchModel")[0]).toMatchObject({
      sessionID: "s1",
      model: { providerID: "openai", id: "gpt-5.2" },
    });
    // The stalled request never reaches the retry hook, so nothing else
    // re-drives the loop: the tail aborts it and resumes on the new model.
    expect(mock.callsTo("session.interrupt")).toEqual([
      { sessionID: "s1", resume: true },
    ]);
    expect(mock.callsTo("session.prompt").length).toBe(0);
  });
});

describe("V2 TTFT recovery — end-to-end through the timer entrance", () => {
  // Builds the same shared context setupV2Plugin builds (identical options →
  // identical chains), wires the real V2 replay tail, settles the session on
  // the failing head model via the context hook, then drives the TTFT
  // entrance directly (the real timer fires at ttftMs=60s; the entrance is
  // what the timer invokes).
  async function ttftFixture(mock = createMockV2Session()) {
    const ctx = createPluginContext({
      logger: silentLogger,
      pluginOptions: { agents: { general: { fallback_models: CHAIN } } },
    });
    applyLoadedChains(
      ctx,
      loadFallbackChains(undefined, silentLogger, ctx.pluginOptions),
    );
    ctx.replayTail = createV2ReplayTail(mock.session);
    const client = createV2OrchestratorClient(mock.session);
    await handleV2Context(ctx, client, mock.session, {
      sessionID: "s1",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
    });
    return { ctx, client, mock };
  }

  test("TTFT timeout advances the chain via switchModel and aborts the stalled request with interrupt(resume:true)", async () => {
    const { ctx, client, mock } = await ttftFixture();
    await handleTtftTimeout(ctx, client, "s1", "general");
    expect(mock.callsTo("session.switchModel")[0]).toMatchObject({
      sessionID: "s1",
      model: { providerID: "openai", id: "gpt-5.2" },
    });
    // The stalled request never reaches the retry hook, so the tail itself
    // must free it: interrupt(resume:true) aborts the in-flight request.
    // Verified live (v2.0.14): this ends the hung turn and anchors the
    // session on the switched model; the host does NOT re-drive the turn
    // in-run (upstream limitation, documented in the contract research).
    expect(mock.callsTo("session.interrupt")).toEqual([
      { sessionID: "s1", resume: true },
    ]);
    // The fallback bookkeeping committed only because the tail succeeded.
    expect(ctx.store.sessions.get("s1").currentModel).toBe("openai/gpt-5.2");
    expect(ctx.store.sessions.get("s1").fallbackDepth).toBe(1);
    ctx.ttft.clear("s1");
  });

  test("a failed TTFT recovery leaves the bookkeeping unadvanced — no false success", async () => {
    const mock = createMockV2Session();
    mock.session.interrupt = async () => {
      throw new Error("host refused the resume");
    };
    const { ctx, client } = await ttftFixture(mock);
    await handleTtftTimeout(ctx, client, "s1", "general");
    // switchModel landed but the resume was refused, so the session never
    // moved: the bookkeeping must still name the original model and depth 0.
    expect(mock.callsTo("session.switchModel").length).toBe(1);
    expect(ctx.store.sessions.get("s1").currentModel).toBe(
      "anthropic/claude-opus-4-1",
    );
    expect(ctx.store.sessions.get("s1").fallbackDepth).toBe(0);
    ctx.ttft.clear("s1");
  });
});

describe("V2 classification and event narrowing", () => {
  test("classifyV2RetryError reuses the shared session.error policy", () => {
    expect(
      classifyV2RetryError({
        type: "APIError",
        status: 429,
        message: "slow down",
      }),
    ).toBe("rate_limit");
    expect(
      classifyV2RetryError({
        type: "APIError",
        status: 429,
        message: "The usage limit has been reached",
      }),
    ).toBe("quota_exhausted");
    expect(classifyV2RetryError({ type: "MessageAbortedError" })).toBeNull();
    expect(classifyV2RetryError(undefined)).toBeNull();
    expect(classifyV2RetryError("nope")).toBeNull();
  });

  test("normalizeV2Event accepts the V1 envelope shape and a flat encoding", () => {
    const enveloped = normalizeV2Event({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "x", sessionID: "s1" } },
    });
    expect(enveloped?.type).toBe("message.part.updated");
    const flat = normalizeV2Event({
      type: "message.part.updated",
      part: { type: "text", text: "x", sessionID: "s1" },
    });
    expect(flat?.type).toBe("message.part.updated");
    expect(normalizeV2Event("junk")).toBeUndefined();
  });

  test("normalizeV2Event maps the live V2 flat envelope onto the internal shapes", () => {
    // Verified live payload: {type, location, data: {sessionID, delta, ...}}.
    const delta = normalizeV2Event({
      id: "evt_1",
      created: 1790131523479,
      type: "session.text.delta",
      location: { directory: "/tmp" },
      data: {
        sessionID: "ses_x",
        assistantMessageID: "msg_1",
        ordinal: 0,
        delta: "PONG",
      },
    });
    expect(delta).toEqual({
      type: "message.part.updated",
      properties: {
        part: { type: "text", text: "PONG", sessionID: "ses_x" },
      },
    });
    // Empty deltas carry no tokens and must not clear TTFT.
    expect(
      normalizeV2Event({
        type: "session.text.delta",
        data: { sessionID: "ses_x", delta: "" },
      }),
    ).toBeUndefined();
    // V1 names do not exist on the live V2 stream; unmapped V2 events are
    // dropped so they can never enter the failure pipeline.
    expect(
      normalizeV2Event({
        type: "session.retry.scheduled",
        data: { sessionID: "ses_x", attempt: 2 },
      }),
    ).toBeUndefined();
    const removed = normalizeV2Event({
      type: "session.deleted",
      data: { sessionID: "ses_x" },
    });
    expect(removed?.type).toBe("session.deleted");
  });

  test("event stream drives the TTFT clear + cleanup handlers without touching failures", async () => {
    const fixture = createMockV2Host({
      agents: { general: { fallback_models: CHAIN } },
    });
    fixture.recordEvent({
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "APIError", data: { statusCode: 500, message: "x" } },
      },
    });
    fixture.recordEvent({
      type: "session.deleted",
      properties: { sessionID: "s1" },
    });
    await setupV2Plugin(fixture.host);
    // Give the subscription loop a tick to drain the recorded events.
    await new Promise((r) => setTimeout(r, 20));
    // The session.error copy must NOT have produced a replay.
    expect(fixture.mock.callsTo("session.switchModel").length).toBe(0);
  });
});

describe("createV2PluginDefinition", () => {
  test("exposes the shared plugin id and a setup function", () => {
    const def = createV2PluginDefinition();
    expect(def.id).toBe(PLUGIN_ID);
    expect(typeof def.setup).toBe("function");
  });
});
