import { describe, expect, test } from "bun:test";
import { FallbackStore } from "../src/state/store.ts";
import { newSessionState } from "../src/state/session-state.ts";

describe("FallbackStore — locks + dedup", () => {
  test("acquireLock first call returns true", () => {
    const s = new FallbackStore();
    expect(s.acquireLock("sess-1")).toBe(true);
  });

  test("acquireLock second call returns false until release", () => {
    const s = new FallbackStore();
    expect(s.acquireLock("sess-1")).toBe(true);
    expect(s.acquireLock("sess-1")).toBe(false);
    s.releaseLock("sess-1");
    expect(s.acquireLock("sess-1")).toBe(true);
  });

  test("isInDedupWindow true within window, false after", () => {
    let now = 1_000_000;
    const s = new FallbackStore(() => now);
    const state = s.sessions.get("sess-1");
    state.lastFallbackAt = now;
    expect(s.sessions.isInDedupWindow("sess-1", 3_000)).toBe(true);
    now += 3_001;
    expect(s.sessions.isInDedupWindow("sess-1", 3_000)).toBe(false);
  });

  test("SessionState defaults are correct", () => {
    const s = newSessionState();
    expect(s.originalModel).toBeNull();
    expect(s.currentModel).toBeNull();
    expect(s.agentName).toBeNull();
    expect(s.fallbackDepth).toBe(0);
    expect(s.lastFallbackAt).toBe(0);
  });
});

describe("ModelHealthMap — cooldown lifecycle", () => {
  test("isInCooldown true while window active, false after expiry", () => {
    let now = 1_000_000;
    const s = new FallbackStore(() => now);
    s.health.cooldown(
      "openai/gpt-5" as `${string}/${string}`,
      5_000,
      "rate_limit",
    );
    expect(s.health.isInCooldown("openai/gpt-5" as `${string}/${string}`)).toBe(
      true,
    );
    now += 5_001;
    expect(s.health.isInCooldown("openai/gpt-5" as `${string}/${string}`)).toBe(
      false,
    );
    // Side-effect: cooldown expiry upgrades record to healthy.
    expect(s.health.get("openai/gpt-5" as `${string}/${string}`).state).toBe(
      "healthy",
    );
  });

  test("unknown model returns healthy", () => {
    const s = new FallbackStore();
    const r = s.health.get("never/seen" as `${string}/${string}`);
    expect(r.state).toBe("healthy");
    expect(r.cooldownUntil).toBe(0);
  });
});
