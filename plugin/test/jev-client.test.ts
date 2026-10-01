import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildJevRequestBody,
  gradeTaskComplexity,
  JEV_ENDPOINT,
  JEV_MODEL,
  parseJevDecisionResponse,
} from "../src/routing/jev-client.ts";

function tempKeyFile(content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-jev-key-"));
  const file = path.join(dir, "openrouter.key");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { dir, file };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

const DECISION_BODY = {
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    complexity: {
      type: "choice",
      choice: "high",
      confidence: 0.81,
      probabilities: { low: 0.02, medium: 0.17, high: 0.78, extreme: 0.03 },
    },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

describe("buildJevRequestBody", () => {
  test("closed question with the four grades and bounded state", () => {
    const body = buildJevRequestBody("x".repeat(9000));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state.task.length).toBe(8000);
    const q = body.questions.complexity!;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria).sort()).toEqual([
      "extreme",
      "high",
      "low",
      "medium",
    ]);
  });
});

describe("parseJevDecisionResponse", () => {
  test("highest probability wins over the choice field", () => {
    const parsed = parseJevDecisionResponse({
      answers: {
        complexity: {
          type: "choice",
          choice: "low",
          probabilities: { low: 0.1, medium: 0.2, high: 0.65, extreme: 0.05 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0.5 },
    });
    expect(parsed?.grade).toBe("high");
    expect(parsed?.confidence).toBeNull();
    expect(parsed?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.5,
    });
  });

  test("falls back to choice when probabilities are absent", () => {
    const parsed = parseJevDecisionResponse({
      answers: { complexity: { type: "choice", choice: "extreme" } },
    });
    expect(parsed?.grade).toBe("extreme");
    expect(parsed?.usage.costUsd).toBeNull();
  });

  test("rejects non-choice answers, unknown grades, and junk shapes", () => {
    expect(
      parseJevDecisionResponse({
        answers: { complexity: { type: "score", score: 2 } },
      }),
    ).toBeNull();
    expect(
      parseJevDecisionResponse({
        answers: { complexity: { type: "choice", choice: "cosmic" } },
      }),
    ).toBeNull();
    expect(parseJevDecisionResponse({ answers: {} })).toBeNull();
    expect(parseJevDecisionResponse(null)).toBeNull();
    expect(parseJevDecisionResponse("nope")).toBeNull();
  });
});

describe("gradeTaskComplexity", () => {
  test("posts the closed question with the key from the key file", async () => {
    const { dir, file } = tempKeyFile("  sk-or-test \n");
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return okResponse(DECISION_BODY);
    }) as typeof fetch;

    const result = await gradeTaskComplexity("Grade me", {
      apiKeyFile: file,
      fetchImpl,
    });

    expect(capturedUrl).toBe(JEV_ENDPOINT);
    const headers = new Headers(
      capturedInit?.headers as Record<string, string>,
    );
    expect(headers.get("Authorization")).toBe("Bearer sk-or-test");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(capturedInit?.body)).model).toBe(JEV_MODEL);
    expect(result?.grade).toBe("high");
    expect(result?.usage.costUsd).toBeCloseTo(0.000019992, 12);
    expect(result?.responseModel).toBe("typesafe/jev-1.13-20260917");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("missing or empty key file fails open without a network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return okResponse(DECISION_BODY);
    }) as unknown as typeof fetch;

    expect(
      await gradeTaskComplexity("t", {
        apiKeyFile: "/nonexistent/omr-jev.key",
        fetchImpl,
      }),
    ).toBeNull();
    const { dir, file } = tempKeyFile("   \n");
    expect(
      await gradeTaskComplexity("t", { apiKeyFile: file, fetchImpl }),
    ).toBeNull();
    expect(called).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("HTTP failure, transport error, and malformed body fail open", async () => {
    const { dir, file } = tempKeyFile("sk-or-test");
    const base = { apiKeyFile: file };

    const notOk = (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;
    expect(
      await gradeTaskComplexity("t", { ...base, fetchImpl: notOk }),
    ).toBeNull();

    const throws = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(
      await gradeTaskComplexity("t", { ...base, fetchImpl: throws }),
    ).toBeNull();

    const badJson = (async () => ({
      ok: true,
      json: async () => {
        throw new Error("invalid json");
      },
    })) as unknown as typeof fetch;
    expect(
      await gradeTaskComplexity("t", { ...base, fetchImpl: badJson }),
    ).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
