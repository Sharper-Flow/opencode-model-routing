// Family disjointness constraint tests (family_disjoint_from_parent).
//
// Covers the operator-mandated cases:
//   - a candidate sharing a family with the requester is skipped, including
//     the cross-provider same-family case (GLM through opencode-go and
//     zai-coding-plan — two providers, one family);
//   - the unsatisfiable case: no rung provably disjoint → serve the
//     selection unchanged and emit family.no_disjoint_model;
//   - the unknown-parent-model case: routing unchanged and a distinct
//     family.parent_model_unknown warn;
//   - agents that did not opt in behave identically with no veto passed;
//   - the availability preflight target selection honors the veto without
//     touching the Claude Max veto itself;
//   - the config loader parses model_families and
//     family_disjoint_from_parent.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginContext,
  handleChatMessage,
} from "../src/plugin-internal.ts";
import { applyPreemptiveSkip } from "../src/preemptive.ts";
import { applyAvailabilityPreflight } from "../src/availability/preflight.ts";
import { loadFallbackChains } from "../src/config/loader.ts";
import { resolveFallbackModel } from "../src/resolution/fallback-resolver.ts";
import { familyVetoFor } from "../src/resolution/family.ts";
import { ModelHealthMap } from "../src/state/model-health.ts";
import { FallbackStore } from "../src/state/store.ts";
import { defaultConfig, type ModelKey } from "../src/types.ts";
import type { AvailabilitySnapshotV1 } from "../src/availability/snapshot.ts";
import { createLogger, type Logger } from "../src/logging/logger.ts";
import { MockClient } from "./helpers/mock-client.ts";

// ---------------------------------------------------------------------------
// Shared fixtures

const GO_GLM = "opencode-go/glm-5.3-flash" as ModelKey;
const ZAI_GLM = "zai-coding-plan/glm-5.3" as ModelKey;
const CLAUDE_OPUS = "anthropic/claude-opus-5" as ModelKey;
const OPENAI_SOL = "openai/gpt-5.6-sol" as ModelKey;
const OPENAI_TERRA = "openai/gpt-5.6-terra" as ModelKey;

const FAMILIES = new Map<ModelKey, string>([
  [GO_GLM, "glm"],
  [ZAI_GLM, "glm"],
  [CLAUDE_OPUS, "claude"],
  [OPENAI_SOL, "openai"],
  [OPENAI_TERRA, "openai"],
]);

const ADVISOR_CHAIN: ModelKey[] = [GO_GLM, ZAI_GLM, OPENAI_SOL];

interface Captured {
  events: { event: string; [k: string]: unknown }[];
  logger: Logger;
}

function capturingLogger(): Captured {
  const events: { event: string; [k: string]: unknown }[] = [];
  const logger = createLogger({
    minLevel: "info",
    write: (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore malformed
      }
    },
  });
  return { events, logger };
}

function warns(captured: Captured, event: string) {
  return captured.events.filter((e) => e.event === event && e.level === "warn");
}

function output(providerID: string, modelID: string) {
  return { message: { model: { providerID, modelID } } };
}

// ---------------------------------------------------------------------------
// familyVetoFor — pure family logic

describe("familyVetoFor", () => {
  test("cross-provider same-family GLM keys veto each other", () => {
    const veto = familyVetoFor(GO_GLM, FAMILIES);
    expect(veto).toBeDefined();
    expect(veto!(ZAI_GLM)).toBe(true); // different provider, same GLM family
    expect(veto!(GO_GLM)).toBe(true);
    expect(veto!(OPENAI_SOL)).toBe(false);
    expect(veto!(CLAUDE_OPUS)).toBe(false);
  });

  test("unmapped requester model yields no veto (config gap, not a guess)", () => {
    const veto = familyVetoFor(
      "some-provider/unknown-model" as ModelKey,
      FAMILIES,
    );
    expect(veto).toBeUndefined();
  });

  test("unmapped candidate is vetoed — disjointness must be proven", () => {
    const veto = familyVetoFor(CLAUDE_OPUS, FAMILIES);
    expect(veto!("minimax-coding-plan/MiniMax-M3" as ModelKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveFallbackModel — rotation scan honors the veto

describe("resolveFallbackModel with familyVeto", () => {
  test("skips same-family rungs across providers, lands on the disjoint rung", () => {
    const health = new ModelHealthMap(() => 1_000_000);
    // Requester serves zai GLM; the failed current is Go GLM — both the
    // same family through two different providers.
    const veto = familyVetoFor(ZAI_GLM, FAMILIES)!;
    const next = resolveFallbackModel(
      GO_GLM,
      ADVISOR_CHAIN,
      0,
      health,
      defaultConfig.maxDepth,
      undefined,
      undefined,
      veto,
    );
    expect(next).toBe(OPENAI_SOL);
  });

  test("no veto passed → scan is unchanged for non-opted-in agents", () => {
    const health = new ModelHealthMap(() => 1_000_000);
    const next = resolveFallbackModel(
      GO_GLM,
      ADVISOR_CHAIN,
      0,
      health,
      defaultConfig.maxDepth,
    );
    expect(next).toBe(ZAI_GLM);
  });

  test("unsatisfiable chain → null (caller fails open)", () => {
    const health = new ModelHealthMap(() => 1_000_000);
    const veto = familyVetoFor(ZAI_GLM, FAMILIES)!;
    const allGlm: ModelKey[] = [GO_GLM, ZAI_GLM];
    const next = resolveFallbackModel(
      GO_GLM,
      allGlm,
      0,
      health,
      defaultConfig.maxDepth,
      undefined,
      undefined,
      veto,
    );
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyPreemptiveSkip — the healthy same-family primary redirect

describe("applyPreemptiveSkip family redirect", () => {
  test("healthy same-family primary is redirected to the disjoint rung", () => {
    const captured = capturingLogger();
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["concord-advisor", ADVISOR_CHAIN],
    ]);
    const out = output("opencode-go", "glm-5.3-flash");
    const veto = familyVetoFor(ZAI_GLM, FAMILIES)!;
    applyPreemptiveSkip(
      { sessionId: "child", agentName: "concord-advisor", output: out },
      store,
      chains,
      defaultConfig,
      captured.logger,
      undefined,
      veto,
    );
    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    });
    expect(store.sessions.get("child").currentModel).toBe(OPENAI_SOL);
    // The routing step returns the redirect it made; handleChatMessage logs
    // the preemptive.redirected event once the redirect is applied.
    expect(
      captured.events.some((e) => e.event === "preemptive.redirected"),
    ).toBe(false);
    expect(
      applyPreemptiveSkip(
        {
          sessionId: "child-2",
          agentName: "concord-advisor",
          output: output("opencode-go", "glm-5.3-flash"),
        },
        store,
        chains,
        defaultConfig,
        captured.logger,
        undefined,
        veto,
      ),
    ).toEqual({ from: GO_GLM, to: OPENAI_SOL, reason: "family" });
  });

  test("unsatisfiable: every rung shares the requester family → serve and warn", () => {
    const captured = capturingLogger();
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["concord-advisor", [GO_GLM, ZAI_GLM]],
    ]);
    const out = output("opencode-go", "glm-5.3-flash");
    const veto = familyVetoFor(ZAI_GLM, FAMILIES)!;
    applyPreemptiveSkip(
      { sessionId: "child", agentName: "concord-advisor", output: out },
      store,
      chains,
      defaultConfig,
      captured.logger,
      undefined,
      veto,
    );
    expect(out.message.model).toEqual({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
    });
    expect(warns(captured, "family.no_disjoint_model").length).toBe(1);
  });

  test("no veto (agent not opted in) → healthy same-family selection untouched", () => {
    const captured = capturingLogger();
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["concord-advisor", ADVISOR_CHAIN],
    ]);
    const out = output("opencode-go", "glm-5.3-flash");
    applyPreemptiveSkip(
      { sessionId: "child", agentName: "concord-advisor", output: out },
      store,
      chains,
      defaultConfig,
      captured.logger,
    );
    expect(out.message.model).toEqual({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
    });
    expect(warns(captured, "family.no_disjoint_model").length).toBe(0);
    expect(
      captured.events.some((e) => String(e.event).startsWith("family.")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// availability preflight — target selection honors the veto; the Claude Max
// veto itself is untouched

describe("applyAvailabilityPreflight with familyVeto", () => {
  const T0 = 1_800_000_000_000;

  function unavailableSnapshot(): AvailabilitySnapshotV1 {
    return {
      schema: "opencode-claude-max/availability@1",
      version: 1,
      generated_at: new Date(T0).toISOString(),
      state: "unavailable",
      accounts: { configured: 2, enabled: 2, usable: 0 },
      retry_at: T0 + 300_000,
      marker: "CLAUDE_MAX_UNAVAILABLE",
    };
  }

  test("redirect target skips family-vetoed rungs, claude veto unchanged", () => {
    const captured = capturingLogger();
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      // Terra (openai) is cooled; the next non-anthropic rung is ZAI GLM,
      // which the family veto must reject for a GLM-family requester; Sol
      // is the first valid target.
      ["concord-advisor", [CLAUDE_OPUS, OPENAI_TERRA, ZAI_GLM, OPENAI_SOL]],
    ]);
    store.health.cooldown(OPENAI_TERRA, 60_000);
    const out = output("anthropic", "claude-opus-5");
    const veto = familyVetoFor(ZAI_GLM, FAMILIES)!;
    applyAvailabilityPreflight(
      {
        sessionId: "child",
        agentName: "concord-advisor",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      captured.logger,
      veto,
    );
    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    });
  });

  test("no veto → existing preflight behavior identical", () => {
    const captured = capturingLogger();
    const store = new FallbackStore();
    const chains = new Map<string, ModelKey[]>([
      ["concord-advisor", [CLAUDE_OPUS, ZAI_GLM, OPENAI_SOL]],
    ]);
    const out = output("anthropic", "claude-opus-5");
    applyAvailabilityPreflight(
      {
        sessionId: "child",
        agentName: "concord-advisor",
        output: out,
        snapshot: unavailableSnapshot(),
      },
      store,
      chains,
      captured.logger,
    );
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
  });
});

// ---------------------------------------------------------------------------
// handleChatMessage — end-to-end parent resolution and the unknown case

describe("handleChatMessage family disjointness", () => {
  let dir: string;
  let cooldownPath: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-family-"));
    cooldownPath = path.join(dir, "cooldown.json");
    origEnv = process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
    process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = cooldownPath;
  });

  afterEach(() => {
    if (origEnv === undefined)
      delete process.env.OPENCODE_MODEL_ROUTING_COOLDOWN;
    else process.env.OPENCODE_MODEL_ROUTING_COOLDOWN = origEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function advisorCtx(captured: Captured) {
    const ctx = createPluginContext({
      config: { ttftMs: 3_600_000 },
      logger: captured.logger,
    });
    ctx.chains.set("concord-advisor", ADVISOR_CHAIN);
    for (const [key, family] of FAMILIES) ctx.families.set(key, family);
    ctx.familyDisjoint.add("concord-advisor");
    return ctx;
  }

  test("cross-provider GLM: in-memory parent state redirects the healthy primary", async () => {
    const captured = capturingLogger();
    const ctx = advisorCtx(captured);
    ctx.store.sessions.get("ses_parent").lastServedModel = ZAI_GLM;
    const client = new MockClient({
      sessionInfo: { id: "ses_child", parentID: "ses_parent" },
    });
    const out = output("opencode-go", "glm-5.3-flash");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_child", agent: "concord-advisor" },
      out,
    );
    ctx.ttft.clear("ses_child");
    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    });
    expect(
      client
        .callsTo("session.messages")
        .filter(
          (c) =>
            (c.args as { path?: { id?: string } })?.path?.id === "ses_parent",
        ).length,
    ).toBe(0); // in-memory route; no parent fetch
  });

  test("parent model read from message history after a reload", async () => {
    const captured = capturingLogger();
    const ctx = advisorCtx(captured);
    const client = new MockClient({
      sessionInfo: { id: "ses_child", parentID: "ses_parent" },
      messagesBySession: {
        ses_parent: [
          {
            info: { id: "m1", role: "user", agent: "concord-1" },
            parts: [{ type: "text", text: "consult" }],
          },
          {
            info: {
              id: "m2",
              role: "assistant",
              providerID: "zai-coding-plan",
              modelID: "glm-5.3",
            },
            parts: [{ type: "text", text: "spawn" }],
          },
        ],
      },
    });
    // The healthy same-family primary (ZAI GLM serving the advisor while
    // the requester also serves GLM) is the exact defect this removes.
    const out = output("zai-coding-plan", "glm-5.3");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_child", agent: "concord-advisor" },
      out,
    );
    ctx.ttft.clear("ses_child");
    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    });
  });

  test("unknown parent model → routing unchanged, distinct warn", async () => {
    const captured = capturingLogger();
    const ctx = advisorCtx(captured);
    const client = new MockClient({
      sessionInfo: { id: "ses_child", parentID: "ses_parent" },
      messagesBySession: {
        // Parent exists but no assistant message names a model.
        ses_parent: [
          {
            info: { id: "m1", role: "user", agent: "concord-1" },
            parts: [{ type: "text", text: "hi" }],
          },
        ],
      },
    });
    const out = output("opencode-go", "glm-5.3-flash");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_child", agent: "concord-advisor" },
      out,
    );
    ctx.ttft.clear("ses_child");
    expect(out.message.model).toEqual({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
    });
    expect(warns(captured, "family.parent_model_unknown").length).toBe(1);
    expect(warns(captured, "family.no_disjoint_model").length).toBe(0);
  });

  test("transient modelless parent is not frozen: later turns resolve and redirect", async () => {
    const captured = capturingLogger();
    const ctx = advisorCtx(captured);
    const client = new MockClient({
      sessionInfo: { id: "ses_child", parentID: "ses_parent" },
      messagesBySession: {
        // First turn: parent's assistant turn has not committed a model yet.
        ses_parent: [
          {
            info: { id: "m1", role: "user", agent: "concord-1" },
            parts: [{ type: "text", text: "hi" }],
          },
        ],
      },
    });
    const first = output("opencode-go", "glm-5.3-flash");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_child", agent: "concord-advisor" },
      first,
    );
    ctx.ttft.clear("ses_child");
    expect(first.message.model).toEqual({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
    });
    expect(warns(captured, "family.parent_model_unknown").length).toBe(1);

    // The parent's assistant message lands; the same child's next turn must
    // resolve the parent model and enforce the constraint.
    client.setMessagesForSession("ses_parent", [
      {
        info: { id: "m1", role: "user", agent: "concord-1" },
        parts: [{ type: "text", text: "hi" }],
      },
      {
        info: {
          id: "m2",
          role: "assistant",
          providerID: "zai-coding-plan",
          modelID: "glm-5.3",
        },
        parts: [{ type: "text", text: "spawn" }],
      },
    ]);
    const second = output("opencode-go", "glm-5.3-flash");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_child", agent: "concord-advisor" },
      second,
    );
    ctx.ttft.clear("ses_child");
    expect(second.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    });
  });

  test("unmapped requester model → routing unchanged, unmapped warn", async () => {
    const captured = capturingLogger();
    const ctx = advisorCtx(captured);
    ctx.store.sessions.get("ses_parent").lastServedModel =
      "minimax-coding-plan/MiniMax-M3" as ModelKey;
    const client = new MockClient({
      sessionInfo: { id: "ses_child", parentID: "ses_parent" },
    });
    const out = output("opencode-go", "glm-5.3-flash");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_child", agent: "concord-advisor" },
      out,
    );
    ctx.ttft.clear("ses_child");
    expect(out.message.model).toEqual({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
    });
    expect(warns(captured, "family.parent_model_unmapped").length).toBe(1);
  });

  test("agent not opted in → identical routing, no family events", async () => {
    const captured = capturingLogger();
    const ctx = advisorCtx(captured);
    ctx.familyDisjoint.clear();
    ctx.store.sessions.get("ses_parent").lastServedModel = ZAI_GLM;
    const client = new MockClient({
      sessionInfo: { id: "ses_child", parentID: "ses_parent" },
    });
    const out = output("opencode-go", "glm-5.3-flash");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_child", agent: "concord-advisor" },
      out,
    );
    ctx.ttft.clear("ses_child");
    expect(out.message.model).toEqual({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
    });
    expect(
      captured.events.some((e) => String(e.event).startsWith("family.")),
    ).toBe(false);
  });

  test("primary session (no parent) → constraint vacuous, no events", async () => {
    const captured = capturingLogger();
    const ctx = advisorCtx(captured);
    const client = new MockClient({ sessionInfo: { id: "ses_solo" } });
    const out = output("opencode-go", "glm-5.3-flash");
    await handleChatMessage(
      ctx,
      client,
      { sessionID: "ses_solo", agent: "concord-advisor" },
      out,
    );
    ctx.ttft.clear("ses_solo");
    expect(out.message.model).toEqual({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
    });
    expect(
      captured.events.some((e) => String(e.event).startsWith("family.")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config loader

describe("loadFallbackChains family fields", () => {
  test("parses model_families and family_disjoint_from_parent", () => {
    const result = loadFallbackChains({}, undefined, {
      model_families: {
        "opencode-go/glm-5.3-flash": "glm",
        "zai-coding-plan/glm-5.3": "glm",
        "anthropic/claude-opus-5": "claude",
      },
      agents: {
        "concord-advisor": {
          fallback_models: ["openai/gpt-5.6-sol"],
          family_disjoint_from_parent: true,
        },
        scout: {
          fallback_models: ["openai/gpt-5.6-terra"],
          family_disjoint_from_parent: false,
        },
      },
    } as never);
    expect(result.families.get("opencode-go/glm-5.3-flash")).toBe("glm");
    expect(result.families.get("zai-coding-plan/glm-5.3")).toBe("glm");
    expect(result.families.size).toBe(3);
    expect(result.familyDisjoint.has("concord-advisor")).toBe(true);
    expect(result.familyDisjoint.has("scout")).toBe(false);
    expect(result.familyDisjoint.size).toBe(1);
  });

  test("drops invalid model_families entries with a warning", () => {
    const captured = capturingLogger();
    const result = loadFallbackChains({}, captured.logger, {
      model_families: {
        "not-a-model-key": "glm",
        "anthropic/claude-opus-5": "",
        "openai/gpt-5.6-sol": "openai",
      },
    } as never);
    expect(result.families.size).toBe(1);
    expect(result.families.get("openai/gpt-5.6-sol")).toBe("openai");
    expect(warns(captured, "loader.invalid_plugin_option_entries").length).toBe(
      1,
    );
  });

  test("non-boolean family_disjoint_from_parent values are ignored", () => {
    const result = loadFallbackChains({}, undefined, {
      agents: {
        scout: { family_disjoint_from_parent: "true" },
        scout2: { family_disjoint_from_parent: 1 },
        scout3: { family_disjoint_from_parent: true },
      },
    } as never);
    expect(result.familyDisjoint.size).toBe(1);
    expect(result.familyDisjoint.has("scout3")).toBe(true);
  });

  test("absent options → empty families and empty opt-in set", () => {
    const result = loadFallbackChains({});
    expect(result.families.size).toBe(0);
    expect(result.familyDisjoint.size).toBe(0);
  });
});
