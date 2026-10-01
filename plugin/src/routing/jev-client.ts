// routing/jev-client.ts — Jev task-complexity grader over the OpenRouter
// Decisions API.
//
// POST https://openrouter.ai/api/alpha/decisions with model
// `typesafe/jev-1.13`, one closed `choice` question grading the delegated
// task low | medium | high | extreme, and the task text as the `state`.
// Request shape and answer shape follow the OpenRouter Decisions API
// reference (2026-10-01): questions carry {type, instructions, criteria},
// answers carry {type, choice, confidence, probabilities}, and usage carries
// {input_tokens, output_tokens, cost}.
//
// Fail-open contract (D5): every fault — unreadable key file, transport
// error, timeout, non-2xx, malformed body, grade outside the closed set —
// resolves null. The caller leaves output.message.model untouched. The grade
// is the highest-probability answer, taken from `probabilities` when present
// and from `choice` otherwise.
//
// The API key is read from `jev.api_key_file` at call time; it never travels
// through an environment variable.

import fs from "node:fs";
import { expandHome } from "./live-registry.ts";
import type { JevGradeResult, RouterGrade } from "../types.ts";
import { isRecord } from "../utils/type-guards.ts";

export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_TIMEOUT_MS = 4_000;
// The grader sees the first 8000 chars of the joined prompt text.
export const JEV_MAX_PROMPT_CHARS = 8_000;

export const ROUTER_GRADES: readonly RouterGrade[] = [
  "low",
  "medium",
  "high",
  "extreme",
] as const;

const GRADE_SET = new Set<string>(ROUTER_GRADES);

const QUESTION_NAME = "complexity";

// Closed grading rubric. One question, four criteria, nothing generative —
// Jev returns probabilities over exactly these labels.
const CRITERIA: Record<RouterGrade, string> = {
  low: "A small, mechanical task: one file or one message, a few steps, no real design choices.",
  medium:
    "A bounded task: a handful of files or steps with some local decisions.",
  high: "A substantial task: many files or interacting parts, non-trivial design choices, likely iteration.",
  extreme:
    "A very large or deeply uncertain task: wide blast radius, hard reasoning, heavy coordination, or a long multi-phase effort.",
};

const INSTRUCTIONS =
  "Grade the complexity of the delegated engineering task described in the state.";

export interface JevClientOptions {
  apiKeyFile: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function buildJevRequestBody(taskText: string): {
  model: string;
  state: { task: string };
  questions: Record<
    string,
    {
      type: "choice";
      instructions: string;
      criteria: Record<RouterGrade, string>;
    }
  >;
} {
  return {
    model: JEV_MODEL,
    state: { task: taskText.slice(0, JEV_MAX_PROMPT_CHARS) },
    questions: {
      [QUESTION_NAME]: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria: CRITERIA,
      },
    },
  };
}

function isRouterGrade(value: unknown): value is RouterGrade {
  return typeof value === "string" && GRADE_SET.has(value);
}

// Parse one Decisions API success body into a JevGradeResult, or null when
// the shape does not carry a usable closed-set grade.
export function parseJevDecisionResponse(body: unknown): JevGradeResult | null {
  if (!isRecord(body)) return null;
  const answers = body.answers;
  if (!isRecord(answers)) return null;
  const answer = answers[QUESTION_NAME];
  if (!isRecord(answer)) return null;
  if (answer.type !== "choice") return null;

  let grade: RouterGrade | null = null;
  const probabilities: Partial<Record<RouterGrade, number>> = {};
  const rawProbabilities = answer.probabilities;
  if (isRecord(rawProbabilities)) {
    let best = -1;
    for (const [key, value] of Object.entries(rawProbabilities)) {
      if (!isRouterGrade(key)) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      probabilities[key] = value;
      if (value > best) {
        best = value;
        grade = key;
      }
    }
  }
  if (!grade && isRouterGrade(answer.choice)) {
    grade = answer.choice;
  }
  if (!grade) return null;

  const rawUsage = isRecord(body.usage) ? body.usage : {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const confidence = num(answer.confidence);
  return {
    grade,
    probabilities,
    confidence,
    usage: {
      inputTokens: num(rawUsage.input_tokens),
      outputTokens: num(rawUsage.output_tokens),
      costUsd: num(rawUsage.cost),
    },
    responseModel: typeof body.model === "string" ? body.model : null,
  };
}

function readApiKey(apiKeyFile: string): string | null {
  try {
    const expanded = expandHome(apiKeyFile) ?? apiKeyFile;
    const raw = fs.readFileSync(expanded, "utf8");
    const key = raw.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Grade the delegated task text with Jev. Resolves null on any fault
 * (fail-open, D5). Never throws.
 */
export async function gradeTaskComplexity(
  taskText: string,
  opts: JevClientOptions,
): Promise<JevGradeResult | null> {
  const apiKey = readApiKey(opts.apiKeyFile);
  if (!apiKey) return null;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? JEV_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildJevRequestBody(taskText)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    // Latency is measured by the caller around this call; the decision body
    // carries no transport time.
    return parseJevDecisionResponse(parsed);
  } catch {
    return null;
  }
}
