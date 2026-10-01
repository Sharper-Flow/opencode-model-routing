// routing/router.ts — first-turn model router for designated child sessions.
//
// On the first chat.message of a child session whose agent carries a
// plugin-tuple `router` block, grade the prompt with Jev, take the grade's
// tier candidate list, and pick the first candidate that passes every
// deterministic filter: isModelAdmissible (cooldown, blocklist, availability
// veto, family veto), no fresh zero-remaining quota boundary (cache-only
// read — the refresh subprocess never runs on a routing decision), and a
// provider below its provider_session_caps entry in the host-wide
// live-session registry. The pick becomes output.message.model and the
// session's currentModel AND originalModel, so PR #16's cooldown-expiry
// revert returns to the pick.
//
// Route once (D2): a per-session flag stops later turns from grading again —
// per-turn model switches rewrite the prompt-cache prefix (ADR 0013), and
// later moves stay with the existing cooldown fallback chain.
//
// Fail open (D5): every fault — no router block, no hook model, prompt
// unreadable, missing key file, Jev error or timeout, no tier for the grade,
// every candidate filtered, registry read error — leaves output.message.model
// untouched so the existing preemptive skip and fallback chain run exactly as
// they did before this module existed. Jev failure never falls back to a
// capacity-only pick.
//
// The router is wired only on the OpenCode 1 chat.message path. Under the V2
// runtime it stays inactive; setupV2Plugin logs that once.
//
// Explicit caller models (D6): the installed OpenCode 1.18.34 Task tool
// exposes description, prompt, subagent_type, and task_id — verified against
// the installed binary's tool schema — and always dispatches the agent's
// configured model, so chat.message input.model cannot mark caller intent and
// no detection code exists to write. If OpenCode later exposes a Task model
// parameter, detection belongs here before the grade call.

import type { Logger } from "../logging/logger.ts";
import { claudeUnavailableVeto } from "../availability/preflight.ts";
import type { AvailabilitySnapshotV1 } from "../availability/snapshot.ts";
import { isModelAdmissible } from "../resolution/fallback-resolver.ts";
import type { FallbackStore } from "../state/store.ts";
import type { JevGradeResult, RouterGrade, RouterTiers } from "../types.ts";
import type { ModelKey } from "../types.ts";
import { isRecord } from "../utils/type-guards.ts";
import type { LiveSessionRegistry } from "./live-registry.ts";

// The router sees the first 8000 chars of the joined prompt text (D3/D1:
// Jev grades the task text only — session counts and quota boundaries are
// deterministic OMR filters, never model inputs).
export const ROUTER_MAX_PROMPT_CHARS = 8_000;

export interface RouterRuntime {
  // Grade the task text. Null = Jev unavailable (fail open).
  grade: (taskText: string) => Promise<JevGradeResult | null>;
  // Cache-only fresh zero-remaining quota boundary for a candidate, or null.
  quotaRead: (modelKey: ModelKey) => number | null;
}

export interface RouterCandidateRejection {
  model: ModelKey;
  rejectedBy: "inadmissible" | "quota_boundary" | "provider_session_cap";
  // Live count that hit the cap, when rejectedBy is provider_session_cap.
  liveSessions?: number;
  cap?: number;
}

export interface RouterDecisionLog {
  sessionId: string;
  agent: string | null;
  grade: RouterGrade | null;
  jev: {
    latencyMs: number | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    responseModel: string | null;
  } | null;
  candidates: RouterCandidateRejection[];
  pick: ModelKey | null;
  failOpen: string | null;
}

export function providerOf(modelKey: ModelKey): string {
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(0, slash) : "";
}

// Join the text parts of the chat.message output into one prompt string,
// bounded to ROUTER_MAX_PROMPT_CHARS. Non-text parts and non-string text are
// skipped; an empty join yields "" (the caller fails open).
export function joinPromptText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type !== "text") continue;
    if (typeof part.text !== "string") continue;
    if (part.text.length === 0) continue;
    texts.push(part.text);
  }
  return texts.join("\n").slice(0, ROUTER_MAX_PROMPT_CHARS);
}

export interface RouteFirstTurnInput {
  sessionId: string;
  agentName: string | null;
  // Pre-resolved by the caller (detectSubagent): the router serves child
  // sessions only — the main agent and every undesignated session route
  // exactly as before this module existed.
  isSubagent: boolean;
  // Chat.message output; mutated in place on a pick.
  output: { message: { model?: { providerID: string; modelID: string } } };
  parts: unknown;
  store: FallbackStore;
  tiers: RouterTiers;
  providerSessionCaps: ReadonlyMap<string, number>;
  runtime: RouterRuntime;
  registry: LiveSessionRegistry | undefined;
  blocked: ReadonlySet<ModelKey> | undefined;
  unavailable: ((key: ModelKey) => boolean) | undefined;
  familyVeto: ((key: ModelKey) => boolean) | undefined;
  snapshot: AvailabilitySnapshotV1 | null;
  logger: Logger;
}

function outputModelOf(key: ModelKey): { providerID: string; modelID: string } {
  const slash = key.indexOf("/");
  return {
    providerID: key.slice(0, slash),
    modelID: key.slice(slash + 1),
  };
}

function logDecision(logger: Logger, decision: RouterDecisionLog): void {
  logger.info("router.decision", { ...decision });
}

/**
 * Run the first-turn router for one chat.message. The caller guards the
 * per-session `routed` flag before invoking this; every outcome — pick or
 * fail-open — logs exactly one structured router.decision line and never
 * throws.
 */
export async function routeFirstTurn(
  input: RouteFirstTurnInput,
): Promise<void> {
  const decision: RouterDecisionLog = {
    sessionId: input.sessionId,
    agent: input.agentName,
    grade: null,
    jev: null,
    candidates: [],
    pick: null,
    failOpen: null,
  };

  try {
    const hookModel = input.output.message.model;
    if (!hookModel) {
      decision.failOpen = "no_hook_model";
      return;
    }

    if (!input.isSubagent) {
      decision.failOpen = "not_subagent";
      return;
    }

    const taskText = joinPromptText(input.parts);
    if (taskText.length === 0) {
      decision.failOpen = "empty_prompt";
      return;
    }

    const startedAt = Date.now();
    const graded = await input.runtime.grade(taskText);
    const latencyMs = Date.now() - startedAt;
    if (!graded) {
      decision.failOpen = "jev_unavailable";
      return;
    }
    decision.grade = graded.grade;
    decision.jev = {
      latencyMs,
      costUsd: graded.usage.costUsd,
      inputTokens: graded.usage.inputTokens,
      outputTokens: graded.usage.outputTokens,
      responseModel: graded.responseModel,
    };

    const candidates = input.tiers[graded.grade];
    if (!candidates || candidates.length === 0) {
      decision.failOpen = "no_tier_for_grade";
      return;
    }

    const unavailable =
      input.unavailable ??
      claudeUnavailableVeto(input.snapshot ?? null) ??
      undefined;

    for (const candidate of candidates) {
      if (
        !isModelAdmissible(
          candidate,
          input.store.health,
          input.blocked,
          unavailable,
          input.familyVeto,
        )
      ) {
        decision.candidates.push({
          model: candidate,
          rejectedBy: "inadmissible",
        });
        continue;
      }
      if (input.runtime.quotaRead(candidate) !== null) {
        decision.candidates.push({
          model: candidate,
          rejectedBy: "quota_boundary",
        });
        continue;
      }
      const provider = providerOf(candidate);
      const cap = input.providerSessionCaps.get(provider);
      if (cap !== undefined) {
        const live = input.registry?.countByProvider(provider);
        if (live === null || live === undefined) {
          decision.failOpen = "registry_unavailable";
          return;
        }
        if (live >= cap) {
          decision.candidates.push({
            model: candidate,
            rejectedBy: "provider_session_cap",
            liveSessions: live,
            cap,
          });
          continue;
        }
      }
      decision.pick = candidate;
      break;
    }

    if (!decision.pick) {
      decision.failOpen = "no_admissible_candidate";
      return;
    }

    // The apply: rewrite the dispatch model and anchor all three routing
    // fields on the pick — currentModel and originalModel so the PR #16
    // cooldown-expiry revert returns to it, and routedModel so later turns
    // re-assert the pick (route once grades once; the pick holds).
    input.output.message.model = outputModelOf(decision.pick);
    const state = input.store.sessions.get(input.sessionId);
    state.currentModel = decision.pick;
    state.originalModel = decision.pick;
    state.routedModel = decision.pick;
  } catch {
    // The router must never break dispatch (D5): swallow and fail open.
    decision.failOpen = decision.failOpen ?? "router_error";
  } finally {
    logDecision(input.logger, decision);
  }
}
