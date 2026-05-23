import { describe, expect, test } from "bun:test";
import {
  classifyRetryStatusText,
  classifySessionError,
} from "../src/detection/classifier.ts";

describe("classifySessionError", () => {
  // Fixtures use the real {name, data:{...}} shape OpenCode emits — per
  // @opencode-ai/sdk EventSessionError union (ApiError, ProviderAuthError,
  // MessageAbortedError, MessageOutputLengthError, UnknownError). Name-only
  // fixtures exercise the name-precedence path; data.* fixtures exercise the
  // statusCode/message/responseBody paths.
  test("APIError data.statusCode 429 → rate_limit", () => {
    expect(
      classifySessionError({ name: "APIError", data: { statusCode: 429, isRetryable: false } }),
    ).toBe("rate_limit");
  });
  test("APIError data.statusCode 503 → server_error", () => {
    expect(
      classifySessionError({ name: "APIError", data: { statusCode: 503, isRetryable: true } }),
    ).toBe("server_error");
  });
  test("APIError data.statusCode 401 → auth_error", () => {
    expect(
      classifySessionError({ name: "APIError", data: { statusCode: 401, isRetryable: false } }),
    ).toBe("auth_error");
  });
  test("APIError data.statusCode 403 → auth_error", () => {
    expect(
      classifySessionError({ name: "APIError", data: { statusCode: 403, isRetryable: false } }),
    ).toBe("auth_error");
  });
  test("ModelNotFoundError name → unknown_model", () => {
    expect(classifySessionError({ name: "ModelNotFoundError", data: {} })).toBe("unknown_model");
  });
  test("Quota in name → quota_exhausted", () => {
    expect(classifySessionError({ name: "QuotaExhaustedError", data: {} })).toBe("quota_exhausted");
  });
  test("auth keyword in name → auth_error", () => {
    expect(classifySessionError({ name: "AuthenticationError", data: {} })).toBe("auth_error");
  });
  test("404 + model in name → unknown_model", () => {
    expect(
      classifySessionError({
        name: "ModelLookupError",
        data: { statusCode: 404, isRetryable: false },
      }),
    ).toBe("unknown_model");
  });
  test("rate-limit in data.message text → rate_limit", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: { message: "Too Many Requests", isRetryable: false },
      }),
    ).toBe("rate_limit");
  });
  test("quota in data.message text → quota_exhausted", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: { message: "monthly quota exceeded", isRetryable: false },
      }),
    ).toBe("quota_exhausted");
  });
  test("no signals → unknown", () => {
    expect(classifySessionError({})).toBe("unknown");
  });

  // Extra fixtures for the responseBody scan + provider-specific cases not
  // covered by the canonical statusCode/message paths above.
  describe("responseBody scan + provider-specific shapes", () => {
    test("APIError data.responseBody insufficient_quota JSON → quota_exhausted", () => {
      // Use a non-matching `message` so this test exclusively exercises the
      // responseBody scan fallback path (message scan must not short-circuit).
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            message: "Request failed",
            isRetryable: false,
            responseBody:
              '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("APIError with non-matching message + non-matching responseBody → unknown", () => {
      // Sad-path coverage for the responseBody scan fallthrough.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            message: "Request failed",
            isRetryable: false,
            responseBody: '{"status":"ok"}',
          },
        }),
      ).toBe("unknown");
    });
    test("ProviderAuthError nested → auth_error (name precedence)", () => {
      expect(
        classifySessionError({
          name: "ProviderAuthError",
          data: { providerID: "openai", message: "Invalid API key" },
        }),
      ).toBe("auth_error");
    });
    test("APIError with empty data → unknown", () => {
      expect(classifySessionError({ name: "APIError", data: {} })).toBe("unknown");
    });
  });
});

describe("classifyRetryStatusText", () => {
  test("null/empty → null", () => {
    expect(classifyRetryStatusText(null)).toBeNull();
    expect(classifyRetryStatusText(undefined)).toBeNull();
    expect(classifyRetryStatusText("")).toBeNull();
  });
  test("rate limit hints", () => {
    expect(classifyRetryStatusText("Retrying due to rate limit...")).toBe("rate_limit");
    expect(classifyRetryStatusText("HTTP 429 Too Many Requests")).toBe("rate_limit");
  });
  test("quota hint", () => {
    expect(classifyRetryStatusText("monthly quota exhausted")).toBe("quota_exhausted");
  });
  test("model-not-found hint", () => {
    expect(classifyRetryStatusText("Model not found: foo/bar")).toBe("unknown_model");
  });
  test("auth hint", () => {
    expect(classifyRetryStatusText("Unauthorized: bad API key")).toBe("auth_error");
  });
  test("server-error hint", () => {
    expect(classifyRetryStatusText("Internal server error (502)")).toBe("server_error");
  });
  test("generic retrying → unknown (last resort)", () => {
    expect(classifyRetryStatusText("Retrying...")).toBe("unknown");
  });
  test("unrecognized text → null", () => {
    expect(classifyRetryStatusText("hello world")).toBeNull();
  });

  // Usage-cap pattern coverage — OpenCode Go/free-tier/Zen + raw OpenAI
  // insufficient_quota strings. See packages/opencode/src/session/retry.ts
  // for canonical message wording.
  describe("usage-cap patterns", () => {
    test("OpenCode Go usage-limit retry → quota_exhausted", () => {
      expect(
        classifyRetryStatusText(
          "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance",
        ),
      ).toBe("quota_exhausted");
    });
    test("Free usage exceeded (Go upsell) → quota_exhausted", () => {
      expect(classifyRetryStatusText("Free usage exceeded, subscribe to Go")).toBe("quota_exhausted");
    });
    test("OpenAI insufficient_quota literal → quota_exhausted", () => {
      expect(classifyRetryStatusText('Error: {"code":"insufficient_quota"}')).toBe("quota_exhausted");
    });
    test("generic 'usage limit' phrasing → quota_exhausted", () => {
      expect(classifyRetryStatusText("Daily usage limit hit")).toBe("quota_exhausted");
    });
    test("'usage cap' phrasing → quota_exhausted", () => {
      expect(classifyRetryStatusText("You have hit your usage cap")).toBe("quota_exhausted");
    });
    test("does NOT misclassify '5 hour' as server-error 5xx", () => {
      // Regression guard for \b(5\d{2})\b — must not match "5 hour"
      expect(
        classifyRetryStatusText("5 hour usage limit reached. Reset in 5 hours."),
      ).toBe("quota_exhausted");
    });

    // Verbatim strings observed in user's real session
    // (~/.local/share/opencode/log/2026-05-23T180338.log @ 18:04:02). ChatGPT
    // Pro `x-codex-plan-type: pro` HTTP 429 from chatgpt.com auth path:
    // responseBody: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached",...}}
    test("verbatim user-observed message → quota_exhausted", () => {
      expect(classifyRetryStatusText("The usage limit has been reached")).toBe(
        "quota_exhausted",
      );
    });
    test("verbatim ChatGPT Pro responseBody type literal → quota_exhausted", () => {
      // ChatGPT Pro 429 returns error.type:"usage_limit_reached" — the
      // underscore-snake form must match \busage[ _-]?(limit|cap|...)\b.
      expect(classifyRetryStatusText('{"type":"usage_limit_reached"}')).toBe(
        "quota_exhausted",
      );
    });
  });
});

describe("classifySessionError — verbatim ChatGPT Pro 429 payload", () => {
  // Real session.error payload shape constructed from observed AI_APICallError
  // (after OpenCode wraps via parseAPICallError → APIError NamedError).
  // Observed in log 2026-05-23T180338.log @ 18:04:02 ses_1a9fdfb70ffeExYV11DljnFqU0.
  test("APIError APIError with usage_limit_reached responseBody → rate_limit (statusCode precedence)", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: {
          message: "The usage limit has been reached",
          statusCode: 429,
          isRetryable: true,
          responseBody:
            '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":1779820400,"eligible_promo":null,"resets_in_seconds":260964}}',
        },
      }),
    ).toBe("rate_limit");
  });
  test("APIError with usage_limit_reached responseBody and NO statusCode → quota_exhausted (responseBody scan fallback)", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: {
          message: "The usage limit has been reached",
          isRetryable: true,
          responseBody:
            '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
        },
      }),
    ).toBe("quota_exhausted");
  });
});
