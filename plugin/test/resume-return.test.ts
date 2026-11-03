// resume-return.test.ts — CON-1686 regression coverage.
//
// End state under test: a session whose last turn was served on a fallback
// resumes (after a process restart, with empty in-memory state) on its
// original model when that original is admissible, and keeps serving on the
// fallback rung while the original is actually unavailable. The persisted
// routing marker ({served, original} per session, session-routing.json) is
// what lets a restarted process tell the re-imported fallback pin from a
// deliberate selection.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging/logger.ts";
import {
  createPluginContext,
  handleChatMessage,
} from "../src/plugin-internal.ts";
import { attemptFallback } from "../src/replay/orchestrator.ts";
import { applyResumeReturn } from "../src/preemptive.ts";
import { RoutingMarkerStore } from "../src/state/routing-marker-store.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

const silentLogger = createLogger({ minLevel: "error", write: () => {} });

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function tempStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omr-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

// Production-shaped context whose routing marker store points at a temp
// file: createPluginContext wiring, with only the persisted store swapped.
function ctxWithMarkers(markerFile: string): {
  ctx: ReturnType<typeof createPluginContext>;
  store: FallbackStore;
} {
  const ctx = createPluginContext({ logger: silentLogger });
  const store = new FallbackStore(
    () => Date.now(),
    undefined,
    new RoutingMarkerStore(markerFile, { logger: silentLogger }),
  );
  ctx.store = store;
  ctx.chains.set("scout", chain);
  return { ctx, store };
}

function userMsg(id = "msg-1", agent = "scout") {
  return {
    info: { id, role: "user", agent },
    parts: [{ type: "text", text: "hello" }],
  };
}

function output(providerID: string, modelID: string) {
  return { message: { model: { providerID, modelID } } };
}

const chain: ModelKey[] = ["a/one", "b/two", "c/three"];

// ---------------------------------------------------------------------------
// The end-state chain: a fallback-served turn, a restart, a resumed turn.
// ---------------------------------------------------------------------------

describe("CON-1686 end state: fallback-served turn then resume", () => {
  test("restart after a fallback-served turn resumes on the healthy original", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");

    // Process A: the turn fails on a/one, orchestrator replays on b/two,
    // marker {served: b/two, original: a/one} persists.
    const storeA = new FallbackStore(
      () => Date.now(),
      undefined,
      new RoutingMarkerStore(markerFile, { logger: silentLogger }),
    );
    storeA.sessions.get("s1").currentModel = "a/one";
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client: new MockClient({ messages: [userMsg()] }),
      store: storeA,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("b/two");
    await storeA.routing!.flush();

    // Process B (restart): fresh in-memory state, fresh health, same marker
    // file. The TUI re-imports the last user message's model — b/two.
    const { ctx, store: storeB } = ctxWithMarkers(markerFile);
    const out = output("b", "two");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg("msg-2")] }),
      { sessionID: "s1", agent: "scout" },
      out,
    );

    // The resumed turn serves on the configured primary again.
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    const state = storeB.sessions.get("s1");
    expect(state.currentModel).toBe("a/one");
    expect(state.originalModel).toBe("a/one");
    expect(state.lastServedModel).toBe("a/one");
    ctx.ttft.clear("s1");
  });

  test("resume keeps the fallback rung while the original is in cooldown", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");

    // Marker from a prior fallback: serving b/two, original a/one.
    const seeding = new RoutingMarkerStore(markerFile, {
      logger: silentLogger,
    });
    await seeding.writeMarker("s1", "b/two", "a/one");
    await seeding.flush();

    // Restarted process: a/one's cooldown survived too (persisted health is
    // modeled here by seeding the fresh store's in-memory health).
    const { ctx, store: storeB } = ctxWithMarkers(markerFile);
    storeB.health.cooldown("a/one", 60_000);
    const out = output("b", "two");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg("msg-2")] }),
      { sessionID: "s1", agent: "scout" },
      out,
    );

    // The fallback still applies while the primary is unavailable — and the
    // marker keeps naming the original for a later restart.
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
    await storeB.routing!.flush();
    const reRead = new RoutingMarkerStore(markerFile, {
      logger: silentLogger,
    });
    expect(reRead.readMarker("s1")).toEqual({
      served: "b/two",
      original: "a/one",
      at: expect.any(Number),
    });
    ctx.ttft.clear("s1");
  });
});

// ---------------------------------------------------------------------------
// applyResumeReturn guard matrix (pure routing step).
// ---------------------------------------------------------------------------

describe("applyResumeReturn guards", () => {
  const marker = {
    served: "b/two" as ModelKey,
    original: "a/one" as ModelKey,
    at: Date.now(),
  };

  function run(over: Partial<Parameters<typeof applyResumeReturn>[0]>) {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["scout", chain]]);
    const out = output("b", "two");
    const applied = applyResumeReturn(
      {
        sessionId: "s1",
        agentName: "scout",
        output: out,
        marker,
        ...over,
      },
      store,
      chains,
      silentLogger,
    );
    return { applied, out };
  }

  test("matching marker + admissible original → returns and resets state", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["scout", chain]]);
    const out = output("b", "two");
    const applied = applyResumeReturn(
      { sessionId: "s1", agentName: "scout", output: out, marker },
      store,
      chains,
      silentLogger,
    );
    expect(applied).toBe(true);
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    const state = store.sessions.get("s1");
    expect(state.currentModel).toBe("a/one");
    expect(state.originalModel).toBe("a/one");
    expect(state.fallbackDepth).toBe(0);
  });

  test("no marker → no return", () => {
    const { applied, out } = run({ marker: null });
    expect(applied).toBe(false);
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("marker.served differs from arriving model (deliberate selection) → no return", () => {
    const { applied, out } = run({
      marker: { served: "c/three", original: "a/one", at: Date.now() },
    });
    expect(applied).toBe(false);
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("original equals served (ordinary turn marker) → no return", () => {
    const { applied, out } = run({
      marker: { served: "b/two", original: "b/two", at: Date.now() },
    });
    expect(applied).toBe(false);
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("original no longer in the agent chain → no return", () => {
    const { applied, out } = run({
      marker: { served: "b/two", original: "x/gone", at: Date.now() },
    });
    expect(applied).toBe(false);
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("unresolved agent → no return", () => {
    const { applied, out } = run({ agentName: null });
    expect(applied).toBe(false);
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("original in cooldown → no return", () => {
    const store = new FallbackStore();
    store.health.cooldown("a/one", 60_000);
    const chains = new Map<string, ModelKey[]>([["scout", chain]]);
    const out = output("b", "two");
    const applied = applyResumeReturn(
      { sessionId: "s1", agentName: "scout", output: out, marker },
      store,
      chains,
      silentLogger,
    );
    expect(applied).toBe(false);
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });

  test("original blocked for the agent → no return", () => {
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([["scout", chain]]);
    const blocked = new Map([["scout", new Set<ModelKey>(["a/one"])]]);
    const out = output("b", "two");
    const applied = applyResumeReturn(
      { sessionId: "s1", agentName: "scout", output: out, marker },
      store,
      chains,
      silentLogger,
      blocked,
    );
    expect(applied).toBe(false);
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
  });
});

// ---------------------------------------------------------------------------
// Marker lifecycle on the hook path.
// ---------------------------------------------------------------------------

describe("routing marker writes on the orchestrator fallback commit", () => {
  test("successful fallback persists {served: fallback, original: pre-fallback}", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");
    const store = new FallbackStore(
      () => Date.now(),
      undefined,
      new RoutingMarkerStore(markerFile, { logger: silentLogger }),
    );
    store.sessions.get("s1").currentModel = "a/one";
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client: new MockClient({ messages: [userMsg()] }),
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(true);
    await store.routing!.flush();
    expect(new RoutingMarkerStore(markerFile).readMarker("s1")).toMatchObject({
      served: "b/two",
      original: "a/one",
    });
  });

  test("failed replay (prompt error) writes no marker", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");
    const store = new FallbackStore(
      () => Date.now(),
      undefined,
      new RoutingMarkerStore(markerFile, { logger: silentLogger }),
    );
    store.sessions.get("s1").currentModel = "a/one";
    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client: new MockClient({
        messages: [userMsg()],
        promptError: new Error("boom"),
      }),
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(false);
    await store.routing!.flush();
    expect(new RoutingMarkerStore(markerFile).readMarker("s1")).toBeNull();
  });

  // The live-log regression this guards: on 2026-10-09 the production log
  // shows fallback.success to=glm-5.3-flash followed 4.6s later by
  // manual_model_change.reset_depth model=glm-5.3-flash — the V1 host
  // dispatches the re-prompt's own chat.message inside session.prompt,
  // while the orchestrator still holds the session lock, and the healthy
  // branch used to reclassify that OMR-driven prompt as a manual change,
  // overwriting originalModel with the fallback rung (destroying the
  // marker's return information). The prompt here fires the hook exactly
  // like the host does.
  test("re-prompt's own chat.message (fired inside session.prompt) does not reclassify the fallback as manual", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");
    const { ctx, store } = ctxWithMarkers(markerFile);
    // The failing turn's earlier hook established the session on a/one.
    const first = output("a", "one");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg()] }),
      { sessionID: "s1", agent: "scout" },
      first,
    );
    ctx.ttft.clear("s1");

    // Host-realistic client: session.prompt dispatches chat.message for the
    // re-prompt body's model BEFORE resolving, inside the orchestrator's
    // lock window.
    const inner = new MockClient({ messages: [userMsg()] });
    const client = {
      session: {
        ...inner.session,
        prompt: async (args: unknown) => {
          const body = (
            args as {
              body: { model?: { providerID: string; modelID: string } };
            }
          ).body;
          if (body.model) {
            await handleChatMessage(
              ctx,
              inner,
              { sessionID: "s1", agent: "scout" },
              { message: { model: body.model } },
            );
            ctx.ttft.clear("s1");
          }
          return inner.session.prompt(args);
        },
      },
    } as unknown as MockClient;

    const result = await attemptFallback({
      sessionId: "s1",
      reason: "rate_limit",
      chain,
      client,
      store,
      config: defaultConfig,
      logger: silentLogger,
      sleepMs: async () => {},
    });
    expect(result.success).toBe(true);

    const state = store.sessions.get("s1");
    expect(state.originalModel).toBe("a/one");
    expect(state.currentModel).toBe("b/two");

    await store.routing!.flush();
    expect(new RoutingMarkerStore(markerFile).readMarker("s1")).toMatchObject({
      served: "b/two",
      original: "a/one",
    });

    // And a restarted process returns the session to the primary.
    const resumed = ctxWithMarkers(markerFile);
    const out = output("b", "two");
    await handleChatMessage(
      resumed.ctx,
      new MockClient({ messages: [userMsg("msg-2")] }),
      { sessionID: "s1", agent: "scout" },
      out,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    resumed.ctx.ttft.clear("s1");
  });
});

describe("routing marker writes on the chat.message hook", () => {
  test("ordinary healthy turn records original === served (deliberate picks stay safe)", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");
    const { ctx, store } = ctxWithMarkers(markerFile);
    const out = output("b", "two");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg()] }),
      { sessionID: "fresh", agent: "scout" },
      out,
    );
    await store.routing!.flush();
    const reRead = new RoutingMarkerStore(markerFile, {
      logger: silentLogger,
    });
    // No OMR routing moved this session: the marker names the arriving model
    // as both served and original, so no later resume treats it as stale.
    expect(reRead.readMarker("fresh")).toMatchObject({
      served: "b/two",
      original: "b/two",
    });
    ctx.ttft.clear("fresh");
  });

  test("preemptive redirect records the redirect target as served, arrival as original", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");
    const { ctx, store } = ctxWithMarkers(markerFile);
    store.health.cooldown("a/one", 60_000);
    const out = output("a", "one");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg()] }),
      { sessionID: "s2", agent: "scout" },
      out,
    );
    expect(out.message.model).toEqual({ providerID: "b", modelID: "two" });
    await store.routing!.flush();
    const reRead = new RoutingMarkerStore(markerFile, {
      logger: silentLogger,
    });
    expect(reRead.readMarker("s2")).toMatchObject({
      served: "b/two",
      original: "a/one",
    });
    ctx.ttft.clear("s2");
  });

  test("resume return rewrites the marker to the returned original", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");
    const seeding = new RoutingMarkerStore(markerFile, {
      logger: silentLogger,
    });
    await seeding.writeMarker("s3", "b/two", "a/one");
    await seeding.flush();

    const { ctx, store } = ctxWithMarkers(markerFile);
    const out = output("b", "two");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg()] }),
      { sessionID: "s3", agent: "scout" },
      out,
    );
    expect(out.message.model).toEqual({ providerID: "a", modelID: "one" });
    await store.routing!.flush();
    const reRead = new RoutingMarkerStore(markerFile, {
      logger: silentLogger,
    });
    // The healed turn persists the original; later restarts see a clean pin.
    expect(reRead.readMarker("s3")).toMatchObject({
      served: "a/one",
      original: "a/one",
    });
    ctx.ttft.clear("s3");
  });

  test("resume return is fresh-state only: later hooks are not redirected", async () => {
    const dir = tempStoreDir();
    const markerFile = join(dir, "session-routing.json");
    const { ctx, store } = ctxWithMarkers(markerFile);
    // First hook with no marker on disk: ordinary turn, state established.
    const first = output("a", "one");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg()] }),
      { sessionID: "s4", agent: "scout" },
      first,
    );
    // The session then falls back out-of-band (orchestrator wrote nothing
    // here); a marker naming b/two appears. The NEXT hook in this same
    // process is not fresh, so the in-process path governs instead.
    const seeding = new RoutingMarkerStore(markerFile, {
      logger: silentLogger,
    });
    await seeding.writeMarker("s4", "b/two", "a/one");
    await seeding.flush();
    await store.routing!.flush();
    const second = output("b", "two");
    await handleChatMessage(
      ctx,
      new MockClient({ messages: [userMsg()] }),
      { sessionID: "s4", agent: "scout" },
      second,
    );
    expect(second.message.model).toEqual({ providerID: "b", modelID: "two" });
    ctx.ttft.clear("s4");
  });
});
