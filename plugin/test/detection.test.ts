import { describe, expect, test } from "bun:test";
import {
  classifyRetryStatusText,
  classifySessionError,
} from "../src/detection/classifier.ts";
import { parseMessageResetBoundary } from "../src/detection/reset-boundary.ts";

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
    test("HTTP 429 OpenAI plan exhaustion wording → quota_exhausted (message inspected before bare-429)", () => {
      // OpenAI plan exhaustion arrives as 429 "The usage limit has been
      // reached". The message/body scan must run BEFORE the bare-429
      // rate_limit return so usage-limit wording classifies as
      // quota_exhausted and gets the quota cooldown instead of cooling for
      // the rate_limit window.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 429,
            message: "The usage limit has been reached",
            isRetryable: false,
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("HTTP 429 usage-limit wording in responseBody only → quota_exhausted (body scan)", () => {
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 429,
            message: "Request failed",
            isRetryable: false,
            responseBody:
              '{"error":{"message":"You have reached your usage limit for this billing cycle"}}',
          },
        }),
      ).toBe("quota_exhausted");
    });
    test("HTTP 429 Kimi monthly usage-limit wording → quota_exhausted", () => {
      // Same usage-limit family as the OpenAI wording — quota signals in
      // the message win over the bare-429 default regardless of provider.
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
      ).toBe("quota_exhausted");
    });
    test("HTTP 429 transient rate-limit wording → rate_limit (default preserved)", () => {
      // True transient rate limits keep the rate_limit classification: no
      // quota signal in message or responseBody.
      expect(
        classifySessionError({
          name: "APIError",
          data: {
            statusCode: 429,
            message:
              "Rate limit reached for gpt-5.6-luna on tokens per min (TPM): Limit 30000, Used 30000",
            isRetryable: true,
          },
        }),
      ).toBe("rate_limit");
    });
    test("HTTP 429 with no message/body → rate_limit (bare-429 default preserved)", () => {
      expect(
        classifySessionError({
          name: "APIError",
          data: { statusCode: 429, isRetryable: false },
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

describe("weekly Command Code quota 429 — message-only TransportFailureError", () => {
  // Real incident: a weekly plan-window 429 reaches the plugin as a
  // message-only TransportFailureError carrying statusCode 0, so the quota
  // branch at classifier.ts (code === 429) never runs. The message template
  // is the zai-coding-plan wording observed verbatim in the host log
  // (~/.local/share/opencode/log/opencode.log:5332: "AI_APICallError:
  // Usage limit reached for 5 hour. Your limit will reset at
  // 2026-09-09 15:26:55"); the weekly Command Code variant follows the same
  // template with the transport status prefix. Before the fix the bare-429
  // rate-limit entry in patterns.ts matched first and the window cooled for
  // the 30-minute rate_limit constant instead of its own reset boundary.
  test("message-only 429 + usage-limit wording → quota_exhausted (not rate_limit)", () => {
    expect(
      classifySessionError({
        name: "TransportFailureError",
        data: {
          statusCode: 0,
          message:
            "429: You've reached your weekly usage limit for your plan. Your limit will reset at 2026-09-26 09:14:33",
        },
      }),
    ).toBe("quota_exhausted");
  });
  test("message-only usage-limit reset boundary without status prefix → quota_exhausted", () => {
    expect(
      classifySessionError({
        name: "TransportFailureError",
        data: {
          message:
            "Usage limit reached for week. Your limit will reset at 2026-09-26 09:14:33",
        },
      }),
    ).toBe("quota_exhausted");
  });
  test("classifyRetryStatusText: quota wording beats the bare-429 entry (precedence)", () => {
    expect(
      classifyRetryStatusText(
        "429 You've reached your weekly usage limit for your plan",
      ),
    ).toBe("quota_exhausted");
    expect(
      classifyRetryStatusText("429 monthly quota exhausted for this account"),
    ).toBe("quota_exhausted");
  });
  test("bare 429 without quota wording stays rate_limit (default preserved)", () => {
    expect(classifyRetryStatusText("HTTP 429")).toBe("rate_limit");
    expect(classifyRetryStatusText("Too Many Requests")).toBe("rate_limit");
    expect(
      classifyRetryStatusText(
        "Rate limit reached for gpt-5.6-luna on tokens per min (TPM)",
      ),
    ).toBe("rate_limit");
  });
});

describe("parseMessageResetBoundary", () => {
  const NOW = Date.parse("2026-09-20T12:00:00Z");
  const HOUR = 3_600_000;

  // Mirrors the provider's naive local-time stamp format; the parser reads
  // stamps without a timezone as host-local, so tests must build stamps in
  // host-local terms too (toISOString would hand back UTC-shifted text).
  function localStamp(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  test("observed provider template 'reset at YYYY-MM-DD HH:mm:ss' parses", () => {
    // Verbatim template from the host log (2026-09-09 15:26:55 form), with a
    // timestamp kept inside the sanity window.
    const boundary = parseMessageResetBoundary(
      "Usage limit reached for week. Your limit will reset at 2026-09-22 15:26:55",
      NOW,
    );
    expect(boundary).toBe(Date.parse("2026-09-22T15:26:55"));
  });
  test("ISO with Z suffix parses as UTC", () => {
    expect(
      parseMessageResetBoundary("reset at 2026-09-22T15:26:55Z", NOW),
    ).toBe(Date.parse("2026-09-22T15:26:55Z"));
  });
  test("ISO with numeric offset parses", () => {
    expect(
      parseMessageResetBoundary("Resets at 2026-09-22T23:26:55+08:00", NOW),
    ).toBe(Date.parse("2026-09-22T23:26:55+08:00"));
  });
  test("ISO with fractional seconds preserves milliseconds", () => {
    const now = Date.parse("2026-09-25T01:20:00.000Z");
    expect(
      parseMessageResetBoundary(
        "Your limit will RESET at 2026-09-25T01:21:27.817Z",
        now,
      ),
    ).toBe(Date.parse("2026-09-25T01:21:27.817Z"));
  });
  test("fractional seconds are padded or truncated to milliseconds", () => {
    const now = Date.parse("2026-09-25T01:20:00Z");
    expect(
      parseMessageResetBoundary("reset at 2026-09-25T01:21:27.8Z", now),
    ).toBe(Date.parse("2026-09-25T01:21:27.800Z"));
    expect(
      parseMessageResetBoundary("resets at 2026-09-25T01:21:27.8179Z", now),
    ).toBe(Date.parse("2026-09-25T01:21:27.817Z"));
  });
  test("future ISO timestamp without reset wording is ignored", () => {
    expect(
      parseMessageResetBoundary("request expires 2026-09-22T15:26:55Z", NOW),
    ).toBeNull();
  });
  test("seconds are optional", () => {
    expect(parseMessageResetBoundary("reset at 2026-09-22 15:26", NOW)).toBe(
      Date.parse("2026-09-22T15:26:00"),
    );
  });
  test("past reset → null (constant stays the probe interval)", () => {
    expect(
      parseMessageResetBoundary(
        "Usage limit reached for week. Your limit will reset at 2026-09-19 15:26:55",
        NOW,
      ),
    ).toBeNull();
  });
  test("reset beyond the 7-day sanity ceiling → null", () => {
    expect(
      parseMessageResetBoundary(
        `Usage limit reached. Your limit will reset at ${localStamp(NOW + 8 * 24 * HOUR)}`,
        NOW,
      ),
    ).toBeNull();
  });
  test("human-only clock time ('3:00 PM') → null", () => {
    expect(
      parseMessageResetBoundary(
        "You've reached your 5-hour usage limit for your plan. Your limit resets at 3:00 PM.",
        NOW,
      ),
    ).toBeNull();
  });
  test("null/empty/unrelated text → null", () => {
    expect(parseMessageResetBoundary(null, NOW)).toBeNull();
    expect(parseMessageResetBoundary(undefined, NOW)).toBeNull();
    expect(parseMessageResetBoundary("", NOW)).toBeNull();
    expect(parseMessageResetBoundary("Request failed", NOW)).toBeNull();
  });
  test("boundary exactly at the ceiling edge (7 days out) parses", () => {
    const edge = NOW + 7 * 24 * HOUR;
    expect(parseMessageResetBoundary(`reset at ${localStamp(edge)}`, NOW)).toBe(
      edge,
    );
  });
});

describe("classifySessionError — verbatim ChatGPT Pro 429 payload", () => {
  // Real session.error payload shape constructed from observed AI_APICallError
  // (after OpenCode wraps via parseAPICallError → APIError NamedError).
  // Observed in log 2026-05-23T180338.log @ 18:04:02 ses_1a9fdfb70ffeExYV11DljnFqU0.
  test("APIError APIError with usage_limit_reached responseBody → quota_exhausted (message inspected before bare-429)", () => {
    // OpenAI/ChatGPT Pro plan exhaustion on 429 classifies as
    // quota_exhausted: the message scan runs before the bare-429 rate_limit
    // return, so "The usage limit has been reached" (and the
    // usage_limit_reached body) map to the quota cooldown instead of the
    // rate_limit window.
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
    ).toBe("quota_exhausted");
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
