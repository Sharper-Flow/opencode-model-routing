import { describe, expect, test } from "bun:test";
import { FailureDeduplicator } from "../src/state/failure-dedup.ts";

const base = {
  sessionId: "s1",
  fingerprint: "api:403:quota",
  familyKey: "s1|kimi/kimi|quota_exhausted",
};

describe("FailureDeduplicator", () => {
  test("session.error alias then exact message is duplicate", () => {
    const d = new FailureDeduplicator();
    expect(d.begin(base)).toBe("new");
    expect(d.begin({ ...base, messageId: "m1" })).toBe("duplicate");
  });

  test("exact message then session.error alias is duplicate", () => {
    const d = new FailureDeduplicator();
    expect(d.begin({ ...base, messageId: "m1" })).toBe("new");
    expect(d.begin(base)).toBe("duplicate");
  });

  test("retry family then terminal error family is duplicate", () => {
    const d = new FailureDeduplicator();
    expect(d.begin({ ...base, fingerprint: "retry:free_tier_limit" })).toBe("new");
    expect(d.begin({ ...base, fingerprint: "api:403:quota", messageId: "m1" })).toBe("duplicate");
  });

  test("same fingerprint in different sessions is new", () => {
    const d = new FailureDeduplicator();
    expect(d.begin(base)).toBe("new");
    expect(
      d.begin({
        ...base,
        sessionId: "s2",
        familyKey: "s2|kimi/kimi|quota_exhausted",
      }),
    ).toBe("new");
  });

  test("different model/category family is new", () => {
    const d = new FailureDeduplicator();
    expect(d.begin(base)).toBe("new");
    expect(
      d.begin({
        ...base,
        fingerprint: "api:500:provider",
        familyKey: "s1|openai/gpt|provider_error",
      }),
    ).toBe("new");
  });

  test("entry becomes new after TTL expires", () => {
    let now = 1_000;
    const d = new FailureDeduplicator({ now: () => now, ttlMs: 30_000 });
    expect(d.begin(base)).toBe("new");
    now += 30_001;
    expect(d.begin(base)).toBe("new");
  });

  test("registry remains bounded", () => {
    const d = new FailureDeduplicator({ maxEntries: 8 });
    for (let i = 0; i < 50; i++) {
      expect(
        d.begin({
          sessionId: `s${i}`,
          messageId: `m${i}`,
          fingerprint: `f${i}`,
          familyKey: `s${i}|model|category`,
        }),
      ).toBe("new");
    }
    expect(d.size).toBeLessThanOrEqual(8);
  });

  test("clearSession removes exact alias and family entries", () => {
    const d = new FailureDeduplicator();
    expect(d.begin({ ...base, messageId: "m1" })).toBe("new");
    d.clearSession("s1");
    expect(d.begin({ ...base, messageId: "m1" })).toBe("new");
  });

  test("prune removes expired entries deterministically", () => {
    let now = 1_000;
    const d = new FailureDeduplicator({ now: () => now, ttlMs: 100 });
    d.begin(base);
    expect(d.size).toBeGreaterThan(0);
    now += 101;
    d.prune();
    expect(d.size).toBe(0);
  });
});
