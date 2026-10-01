import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/logging/logger.ts";
import { joinPromptText } from "../src/routing/router.ts";
import { LiveSessionRegistry } from "../src/routing/live-registry.ts";
import {
  createPluginContext,
  handleChatMessage,
  handleEvent,
  setupV2Plugin,
} from "../src/plugin-internal.ts";
import type { JevGradeResult, ModelKey } from "../src/types.ts";
import { MockClient } from "./helpers/mock-client.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omr-router-"));
}

function jevGrade(grade: JevGradeResult["grade"]): JevGradeResult {
  return {
    grade,
    probabilities: { [grade]: 0.9 },
    confidence: 0.9,
    usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001 },
    responseModel: "typesafe/jev-1.13-20260917",
  };
}

const HOUR = 3_600_000;

interface RouterHarness {
  ctx: ReturnType<typeof createPluginContext>;
  client: MockClient;
  grades: JevGradeResult["grade"][];
  registry: LiveSessionRegistry;
  dir: string;
  lines: string[];
}

function harness(opts: {
  sessionInfo?: Record<string, unknown>;
  tiers?: Record<string, ModelKey[]>;
  caps?: Record<string, number>;
  grades?: JevGradeResult["grade"][];
  gradeResult?: JevGradeResult | null;
  quotaReads?: (number | null)[];
}): RouterHarness {
  const dir = tmpDir();
  const lines: string[] = [];
  const logger = createLogger({
    minLevel: "debug",
    write: (l) => lines.push(l),
  });
  const ctx = createPluginContext({ logger });
  ctx.routers.set(
    "implement",
    opts.tiers ?? { medium: ["prov-b/two"], extreme: ["openai/gpt-6.1-sol"] },
  );
  for (const [provider, cap] of Object.entries(opts.caps ?? {})) {
    ctx.providerSessionCaps.set(provider, cap);
  }
  ctx.registry = new LiveSessionRegistry(path.join(dir, "live-sessions"));
  const grades = [...(opts.grades ?? ["medium"])];
  const quotaReads = [...(opts.quotaReads ?? [])];
  ctx.router = {
    grade: async () => {
      if (opts.gradeResult !== undefined) return opts.gradeResult;
      return jevGrade(grades.shift() ?? "medium");
    },
    quotaRead: () => quotaReads.shift() ?? null,
  };
  const client = new MockClient({ sessionInfo: opts.sessionInfo ?? {} });
  return { ctx, client, grades, registry: ctx.registry, dir, lines };
}

function chatOutput(parts?: unknown) {
  return {
    message: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } },
    parts: parts ?? [{ type: "text", text: "Implement the feature" }],
  };
}

async function turn(h: RouterHarness, sessionId: string, output?: unknown) {
  await handleChatMessage(
    h.ctx,
    h.client as never,
    { sessionID: sessionId, agent: "implement" },
    (output ?? chatOutput()) as never,
  );
}

function decisionEvents(h: RouterHarness) {
  return h.lines
    .map((line) => JSON.parse(line))
    .filter((parsed) => parsed.event === "router.decision");
}

describe("first-turn router — designated sessions only", () => {
  test("main session on a designated agent fails open without grading", async () => {
    const h = harness({ sessionInfo: {} });
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(h.ctx.store.sessions.get("s1").routed).toBe(true);
    const decisions = decisionEvents(h);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].failOpen).toBe("not_subagent");
  });

  test("undesignated agent never engages the router (no log, no grade)", async () => {
    const h = harness({ sessionInfo: { parentID: "p1" } });
    const out = chatOutput();
    await handleChatMessage(
      h.ctx,
      h.client as never,
      { sessionID: "s1", agent: "scout" },
      out as never,
    );
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(decisionEvents(h)).toHaveLength(0);
  });

  test("no router runtime wired (V2) leaves the model untouched", async () => {
    const h = harness({ sessionInfo: { parentID: "p1" } });
    h.ctx.router = undefined;
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(decisionEvents(h)).toHaveLength(0);
  });
});

describe("first-turn router — grade selects the tier", () => {
  test("medium grade routes to tiers.medium and anchors originalModel", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { low: ["prov-a/one"], medium: ["prov-b/two"] },
      grades: ["medium"],
    });
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({ providerID: "prov-b", modelID: "two" });
    const state = h.ctx.store.sessions.get("s1");
    expect(state.currentModel).toBe("prov-b/two");
    expect(state.originalModel).toBe("prov-b/two");
  });

  test("extreme grade routes to the premium rung", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: {
        medium: ["prov-b/two"],
        extreme: ["openai/gpt-6.1-sol", "prov-b/two"],
      },
      grades: ["extreme"],
    });
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-6.1-sol",
    });
  });

  test("routes once: the second turn never grades again", async () => {
    const h = harness({ sessionInfo: { parentID: "p1" } });
    const out1 = chatOutput();
    await turn(h, "s1", out1);
    expect(out1.message.model).toEqual({
      providerID: "prov-b",
      modelID: "two",
    });
    const out2 = chatOutput();
    await turn(h, "s1", out2);
    expect(decisionEvents(h)).toHaveLength(1);
    expect(out2.message.model).toEqual({
      providerID: "prov-b",
      modelID: "two",
    });
    expect(h.ctx.store.sessions.get("s1").originalModel).toBe("prov-b/two");
  });
});

describe("first-turn router — capacity and quota filters", () => {
  test("a provider at its live-session cap is skipped for the next candidate", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { medium: ["prov-a/one", "prov-b/two"] },
      caps: { "prov-a": 1 },
    });
    // Another host session already occupies prov-a's single slot.
    h.registry.upsert("busy-sibling", "prov-a/one");
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({ providerID: "prov-b", modelID: "two" });
    const decision = decisionEvents(h)[0];
    expect(decision.pick).toBe("prov-b/two");
    expect(decision.candidates).toEqual([
      {
        model: "prov-a/one",
        rejectedBy: "provider_session_cap",
        liveSessions: 1,
        cap: 1,
      },
    ]);
  });

  test("a provider with no configured cap is never cap-filtered", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { medium: ["prov-a/one"] },
    });
    h.registry.upsert("busy-sibling", "prov-a/one");
    h.registry.upsert("busy-sibling-2", "prov-a/one");
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({ providerID: "prov-a", modelID: "one" });
  });

  test("a fresh zero-remaining quota boundary skips the candidate", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { medium: ["prov-a/one", "prov-b/two"] },
      quotaReads: [Date.now() + HOUR, null],
    });
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({ providerID: "prov-b", modelID: "two" });
    const decision = decisionEvents(h)[0];
    expect(decision.candidates).toEqual([
      { model: "prov-a/one", rejectedBy: "quota_boundary" },
    ]);
  });

  test("admission, quota, and cap filters compose in order", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: {
        medium: [
          "prov-a/cooled",
          "prov-a/quota",
          "prov-a/capped",
          "prov-b/two",
        ],
      },
      caps: { "prov-a": 1 },
      quotaReads: [null, Date.now() + HOUR, null, null],
    });
    h.ctx.store.health.cooldown("prov-a/cooled", HOUR);
    h.registry.upsert("busy-sibling", "prov-a/anything");
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({ providerID: "prov-b", modelID: "two" });
    const decision = decisionEvents(h)[0];
    // Per-candidate filter order is admission → quota → cap: prov-a/quota
    // passes the quota read and dies on the cap; prov-a/capped carries the
    // fresh quota boundary and dies on quota.
    expect(decision.candidates).toEqual([
      { model: "prov-a/cooled", rejectedBy: "inadmissible" },
      {
        model: "prov-a/quota",
        rejectedBy: "provider_session_cap",
        liveSessions: 1,
        cap: 1,
      },
      { model: "prov-a/capped", rejectedBy: "quota_boundary" },
    ]);
  });
});

describe("first-turn router — fail open", () => {
  test("Jev failure leaves the model and the chain untouched", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      gradeResult: null,
    });
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(h.ctx.store.sessions.get("s1").originalModel).toBe(
      "zai-coding-plan/glm-5.3",
    );
    const decision = decisionEvents(h)[0];
    expect(decision.failOpen).toBe("jev_unavailable");
  });

  test("registry read failure leaves the configured model untouched", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { medium: ["prov-a/one"] },
      caps: { "prov-a": 1 },
    });
    h.ctx.registry = new LiveSessionRegistry(h.dir, {
      listDir: () => {
        throw new Error("registry unavailable");
      },
    });
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(decisionEvents(h)[0].failOpen).toBe("registry_unavailable");
  });

  test("a grade with no tier entry fails open", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { extreme: ["openai/gpt-6.1-sol"] },
      grades: ["high"],
    });
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(decisionEvents(h)[0].failOpen).toBe("no_tier_for_grade");
  });

  test("every candidate filtered fails open", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { medium: ["prov-a/capped"] },
      caps: { "prov-a": 1 },
    });
    h.registry.upsert("busy-sibling", "prov-a/one");
    const out = chatOutput();
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(decisionEvents(h)[0].failOpen).toBe("no_admissible_candidate");
  });

  test("an empty prompt fails open without a Jev call", async () => {
    const h = harness({ sessionInfo: { parentID: "p1" } });
    h.ctx.router = {
      grade: async () => {
        throw new Error("must not be called");
      },
      quotaRead: () => null,
    };
    const out = chatOutput([{ type: "text", text: "" }]);
    await turn(h, "s1", out);
    expect(out.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });
    expect(decisionEvents(h)[0].failOpen).toBe("empty_prompt");
  });
});

describe("first-turn router — decision log", () => {
  test("one structured line records grade, jev cost and latency, candidates, and the pick", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { medium: ["prov-a/capped", "prov-b/two"] },
      caps: { "prov-a": 1 },
    });
    h.registry.upsert("busy-sibling", "prov-a/one");
    await turn(h, "s1");
    const decisions = decisionEvents(h);
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    expect(d.sessionId).toBe("s1");
    expect(d.agent).toBe("implement");
    expect(d.grade).toBe("medium");
    expect(d.jev.costUsd).toBe(0.0001);
    expect(typeof d.jev.latencyMs).toBe("number");
    expect(d.pick).toBe("prov-b/two");
    expect(d.failOpen).toBeNull();
  });
});

describe("first-turn router — the pick holds across turns", () => {
  test("re-asserted while admissible; the existing machinery governs when it is not", async () => {
    const h = harness({
      sessionInfo: { parentID: "p1" },
      tiers: { medium: ["prov-b/two"] },
    });
    const out1 = chatOutput();
    await turn(h, "s1", out1);
    expect(out1.message.model).toEqual({
      providerID: "prov-b",
      modelID: "two",
    });

    // Turn 2: the host re-derives the configured model, the router does not
    // grade again, and the stored pick is re-asserted.
    const out2 = chatOutput();
    await turn(h, "s1", out2);
    expect(decisionEvents(h)).toHaveLength(1);
    expect(out2.message.model).toEqual({
      providerID: "prov-b",
      modelID: "two",
    });
    expect(h.ctx.store.sessions.get("s1").originalModel).toBe("prov-b/two");

    // Turn 3: the pick is now cooling — no re-assertion. The session stays
    // on the host's configured model for this turn and the pre-existing
    // cooldown fallback and PR #16 revert own any later move.
    h.ctx.store.health.cooldown("prov-b/two", 30);
    const out3 = chatOutput();
    await turn(h, "s1", out3);
    expect(out3.message.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3",
    });

    // Turn 4: the cooldown expired, the pick is admissible again, and the
    // session returns to it.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const out4 = chatOutput();
    await turn(h, "s1", out4);
    expect(out4.message.model).toEqual({
      providerID: "prov-b",
      modelID: "two",
    });
    expect(decisionEvents(h)).toHaveLength(1);
  });
});

describe("live-registry wiring in handleChatMessage / handleEvent", () => {
  test("turn start upserts the session entry; idle removes it", async () => {
    const h = harness({ sessionInfo: {} });
    await turn(h, "s1");
    expect(h.registry.countByProvider("zai-coding-plan")).toBe(1);
    await handleEvent(
      h.ctx,
      h.client as never,
      {
        type: "session.idle",
        properties: { sessionID: "s1" },
      } as never,
    );
    expect(h.registry.countByProvider("zai-coding-plan")).toBe(0);
  });

  test("session.status idle and session.deleted also remove the entry", async () => {
    const h = harness({ sessionInfo: {} });
    await turn(h, "s1");
    await handleEvent(
      h.ctx,
      h.client as never,
      {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "idle" } },
      } as never,
    );
    expect(h.registry.snapshot()).toHaveLength(0);
    await turn(h, "s1");
    await handleEvent(
      h.ctx,
      h.client as never,
      {
        type: "session.deleted",
        properties: { sessionID: "s1" },
      } as never,
    );
    expect(h.registry.snapshot()).toHaveLength(0);
  });

  test("main-agent sessions register too (capacity counts every session)", async () => {
    const h = harness({ sessionInfo: {} });
    await handleChatMessage(
      h.ctx,
      h.client as never,
      { sessionID: "main-1", agent: "build" },
      chatOutput() as never,
    );
    expect(h.registry.countByProvider("zai-coding-plan")).toBe(1);
  });
});

describe("V2 runtime keeps the router inactive", () => {
  test("setupV2Plugin logs the inactivity exactly once", async () => {
    const dir = tmpDir();
    const logFile = path.join(dir, "omr.log");
    const previous = process.env.OMR_LOG_FILE;
    process.env.OMR_LOG_FILE = logFile;
    try {
      const host = {
        options: {},
        session: {
          get: async () => ({}),
          context: async () => ({}),
          switchModel: async () => ({}),
          interrupt: async () => ({}),
          prompt: async () => ({}),
          hook: async () => ({}),
        },
      };
      await setupV2Plugin(host, {
        registry: new LiveSessionRegistry(path.join(dir, "live-sessions")),
      });
    } finally {
      process.env.OMR_LOG_FILE = previous;
    }
    const events = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).event);
    expect(
      events.filter((e: string) => e === "router.inactive_v2"),
    ).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("joinPromptText", () => {
  test("joins text parts, skips others, bounds to 8000 chars", () => {
    expect(
      joinPromptText([
        { type: "text", text: "one" },
        { type: "file", path: "x" },
        { type: "text", text: "two" },
        { type: "text" },
      ]),
    ).toBe("one\ntwo");
    expect(joinPromptText(undefined)).toBe("");
    expect(joinPromptText("not-an-array")).toBe("");
    expect(
      joinPromptText([{ type: "text", text: "y".repeat(9000) }]).length,
    ).toBe(8000);
  });
});
