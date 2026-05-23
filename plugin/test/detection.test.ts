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
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            message: "Quota exceeded.",
            isRetryable: false,
            responseBody:
              '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
          },
        }),
      ).toBe("quota_exhausted");
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
});
