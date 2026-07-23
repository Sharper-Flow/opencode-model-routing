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
      classifySessionError({
        name: "APIError",
        data: { statusCode: 429, isRetryable: false },
      }),
    ).toBe("rate_limit");
  });
  test("APIError data.statusCode 503 → server_error", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: { statusCode: 503, isRetryable: true },
      }),
    ).toBe("server_error");
  });
  test("APIError data.statusCode 401 → auth_error", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: { statusCode: 401, isRetryable: false },
      }),
    ).toBe("auth_error");
  });
  test("APIError data.statusCode 403 → auth_error", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: { statusCode: 403, isRetryable: false },
      }),
    ).toBe("auth_error");
  });
  test("ModelNotFoundError name → unknown_model", () => {
    expect(classifySessionError({ name: "ModelNotFoundError", data: {} })).toBe(
      "unknown_model",
    );
  });
  test("Quota in name → quota_exhausted", () => {
    expect(
      classifySessionError({ name: "QuotaExhaustedError", data: {} }),
    ).toBe("quota_exhausted");
  });
  test("auth keyword in name → auth_error", () => {
    expect(
      classifySessionError({ name: "AuthenticationError", data: {} }),
    ).toBe("auth_error");
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
  test("MessageAbortedError → null (user cancel, no fallback)", () => {
    expect(
      classifySessionError({
        name: "MessageAbortedError",
        data: { message: "The operation was aborted." },
      }),
    ).toBeNull();
  });
  test("AbortError name → null (user cancel, no fallback)", () => {
    expect(
      classifySessionError({
        name: "AbortError",
        data: { message: "Aborted" },
      }),
    ).toBeNull();
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
      expect(classifySessionError({ name: "APIError", data: {} })).toBe(
        "unknown",
      );
    });
  });

  // Kimi Code documented error formats from
  // kimi.com/code/docs/en/kimi-code/error-reference.html. Critical because
  // Kimi returns HTTP 403 (typically auth) for billing-cycle quota
  // exhaustion — without the 403 message scan, fallback would never fire
  // for the most common Kimi quota scenario.
  describe("Kimi Code error formats", () => {
    test("HTTP 403 billing-cycle quota exhausted → quota_exhausted (not auth_error)", () => {
      // Verbatim from Kimi Code error reference.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 403,
            message:
              "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
            isRetryable: false,
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("HTTP 403 with 'billing cycle' in responseBody JSON → quota_exhausted", () => {
      // Defensive: if the message field is generic but the responseBody
      // carries the Kimi wording, the body scan must still classify correctly.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 403,
            message: "Request failed",
            isRetryable: false,
            responseBody:
              '{"error":{"message":"You have reached your usage limit for this billing cycle"}}',
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("HTTP 403 with no quota signal → auth_error (regression guard)", () => {
      // Existing behavior preserved: 403 alone still classifies as auth_error
      // so genuine forbidden/access-denied errors keep their semantics.
      expect(
        classifySessionError({
          name: "APIError",
          data: { statusCode: 403, isRetryable: false },
        }),
      ).toBe("auth_error");
    });
    test("HTTP 403 with quota in message but no Kimi-specific wording → quota_exhausted", () => {
      // Other providers that might use 403 + quota wording also benefit
      // from the message-scan path. Confirms the fix is provider-agnostic
      // at the message level.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 403,
            message: "quota exceeded for this account",
            isRetryable: false,
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("HTTP 429 5-hourly quota → rate_limit (statusCode precedence preserved)", () => {
      // 429 keeps precedence — Kimi's 5-hourly wording still classifies as
      // rate_limit, matching existing ChatGPT Pro precedent. Do NOT promote
      // 429 to quota_exhausted based on message; the team's intentional
      // design choice stands.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 429,
            message: "You've reached your usage limit for this period",
            isRetryable: false,
          },
        }),
      ).toBe("rate_limit");
    });
    test("HTTP 429 Kimi monthly quota → rate_limit (statusCode precedence)", () => {
      // Monthly wording matches "kimi monthly" pattern in the body scan, but
      // 429 status code short-circuits first. This is intentional — cooldown
      // for 429 is 30min vs quota's 60min, and the Kimi monthly window
      // rolls on hour-scale.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 429,
            message:
              "You've reached kimi monthly usage limit for this billing cycle",
            isRetryable: false,
          },
        }),
      ).toBe("rate_limit");
    });
    test("Kimi weekly-cap wording via classifyRetryStatusText → quota_exhausted", () => {
      // Weekly cap is not documented with a status code; the literal wording
      // is "weekly quota has been fully used up". If it surfaces via
      // session.status text or responseBody, the patterns must catch it.
      expect(
        classifyRetryStatusText(
          "The account's weekly quota has been fully used up",
        ),
      ).toBe("quota_exhausted");
    });
    test("Kimi 'fully used up' alone → quota_exhausted", () => {
      expect(classifyRetryStatusText("Quota fully used up")).toBe(
        "quota_exhausted",
      );
    });
    test("Kimi 'kimi monthly' substring → quota_exhausted", () => {
      expect(classifyRetryStatusText("You hit the kimi monthly limit")).toBe(
        "quota_exhausted",
      );
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
    expect(classifyRetryStatusText("Retrying due to rate limit...")).toBe(
      "rate_limit",
    );
    expect(classifyRetryStatusText("HTTP 429 Too Many Requests")).toBe(
      "rate_limit",
    );
  });
  test("quota hint", () => {
    expect(classifyRetryStatusText("monthly quota exhausted")).toBe(
      "quota_exhausted",
    );
  });
  test("model-not-found hint", () => {
    expect(classifyRetryStatusText("Model not found: foo/bar")).toBe(
      "unknown_model",
    );
  });
  test("auth hint", () => {
    expect(classifyRetryStatusText("Unauthorized: bad API key")).toBe(
      "auth_error",
    );
  });
  test("server-error hint", () => {
    expect(classifyRetryStatusText("Internal server error (502)")).toBe(
      "server_error",
    );
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
      expect(
        classifyRetryStatusText("Free usage exceeded, subscribe to Go"),
      ).toBe("quota_exhausted");
    });
    test("OpenAI insufficient_quota literal → quota_exhausted", () => {
      expect(
        classifyRetryStatusText('Error: {"code":"insufficient_quota"}'),
      ).toBe("quota_exhausted");
    });
    test("generic 'usage limit' phrasing → quota_exhausted", () => {
      expect(classifyRetryStatusText("Daily usage limit hit")).toBe(
        "quota_exhausted",
      );
    });
    test("'usage cap' phrasing → quota_exhausted", () => {
      expect(classifyRetryStatusText("You have hit your usage cap")).toBe(
        "quota_exhausted",
      );
    });
    test("does NOT misclassify '5 hour' as server-error 5xx", () => {
      // Regression guard for \b(5\d{2})\b — must not match "5 hour"
      expect(
        classifyRetryStatusText(
          "5 hour usage limit reached. Reset in 5 hours.",
        ),
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

describe("message-scan retryPatterns coverage (P23 campsite rule)", () => {
  // Before the fix: classifySessionError scanned data.message for hardcoded
  // "rate limit" / "quota" only, missing "usage limit" / "billing cycle" etc.
  // The responseBody scan used retryPatterns but the message scan did not.
  // Fix: apply classifyRetryStatusText to data.message too, matching
  // responseBody-scan coverage.

  test("message-only 'usage limit reached' with no statusCode/responseBody → quota_exhausted", () => {
    expect(
      classifySessionError({
        name: "AI_RetryError",
        data: {
          message:
            "5 hour usage limit reached. It will reset in 4 hours 21 minutes.",
          isRetryable: false,
        },
      }),
    ).toBe("quota_exhausted");
  });

  test("message-only 'billing cycle' with no statusCode/responseBody → quota_exhausted", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: {
          message: "You've reached your usage limit for this billing cycle",
          isRetryable: false,
        },
      }),
    ).toBe("quota_exhausted");
  });

  test("message-only 'fully used up' with no statusCode/responseBody → quota_exhausted", () => {
    expect(
      classifySessionError({
        name: "APIError",
        data: {
          message: "Your weekly quota has been fully used up",
          isRetryable: false,
        },
      }),
    ).toBe("quota_exhausted");
  });
});

describe("provider-exhaustion signals (opencode-go + claude-max)", () => {
  // Real observed failures (2026-07-23). Both previously misclassified — the
  // opencode-go workspace spending-limit (HTTP 403) fell through to
  // auth_error (30min), and the claude-max exhaustion marker (no HTTP status)
  // fell through to unknown (5min). Both defeated subagent rollover by giving
  // day/month-scale exhaustion a too-short cooldown. Fixed via producer-owned
  // patterns → quota_exhausted.

  describe("opencode-go workspace spending-limit (F2)", () => {
    test("HTTP 403 'monthly spending limit' message → quota_exhausted (not auth_error)", () => {
      // Verbatim from the opencode-go Go-bundle failure (adv-engineer 19:18).
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 403,
            message:
              "Your workspace has reached its monthly spending limit of $100. Manage your limits here: https://opencode.ai/workspace/wrk_01KP7173C62CT643YJQAEKA5CS/billing",
            isRetryable: false,
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("classifyRetryStatusText 'spending limit' → quota_exhausted", () => {
      expect(classifyRetryStatusText("monthly spending limit reached")).toBe(
        "quota_exhausted",
      );
    });
    test("classifyRetryStatusText opencode.ai billing URL → quota_exhausted", () => {
      expect(
        classifyRetryStatusText(
          "Limit reached — see https://opencode.ai/workspace/wrk_abc/billing",
        ),
      ).toBe("quota_exhausted");
    });
    test("HTTP 403 with no quota/spending signal → auth_error (regression guard)", () => {
      // Genuine forbidden/access-denied keeps auth_error semantics.
      expect(
        classifySessionError({
          name: "APIError",
          data: { statusCode: 403, message: "Forbidden", isRetryable: false },
        }),
      ).toBe("auth_error");
    });
  });

  describe("claude-max exhaustion marker (F1)", () => {
    test("CLAUDE_MAX_UNAVAILABLE message, no statusCode → quota_exhausted (not unknown)", () => {
      // Verbatim marker thrown by the opencode-claude-max plugin when all
      // accounts are exhausted (carries no HTTP status code).
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            message:
              "CLAUDE_MAX_UNAVAILABLE: All configured Claude Max accounts are temporarily unavailable",
            isRetryable: false,
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("classifyRetryStatusText 'claude_max_unavailable' marker → quota_exhausted", () => {
      expect(
        classifyRetryStatusText("opencode-claude-max: CLAUDE_MAX_UNAVAILABLE"),
      ).toBe("quota_exhausted");
    });
  });
});
