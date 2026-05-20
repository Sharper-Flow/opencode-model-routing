import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TtftRegistry } from "../src/ttft.ts";

describe("TtftRegistry", () => {
  let registry: TtftRegistry;
  beforeEach(() => {
    registry = new TtftRegistry();
  });
  afterEach(() => {
    // Clear any leftover timers between tests.
    registry.clear("s1");
    registry.clear("s2");
  });

  test("arm fires onTimeout after delay", async () => {
    let fired = false;
    registry.arm("s1", 10, () => {
      fired = true;
    });
    expect(registry.has("s1")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(true);
    expect(registry.has("s1")).toBe(false);
  });

  test("clear prevents onTimeout from firing", async () => {
    let fired = false;
    registry.arm("s1", 20, () => {
      fired = true;
    });
    registry.clear("s1");
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(false);
    expect(registry.has("s1")).toBe(false);
  });

  test("arm twice on same session replaces previous timer", async () => {
    let firstFired = false;
    let secondFired = false;
    registry.arm("s1", 10, () => {
      firstFired = true;
    });
    registry.arm("s1", 30, () => {
      secondFired = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(firstFired).toBe(false);
    expect(secondFired).toBe(true);
    registry.clear("s1");
  });

  test("isolated per session", async () => {
    let s1Fired = false;
    let s2Fired = false;
    registry.arm("s1", 10, () => {
      s1Fired = true;
    });
    registry.arm("s2", 10, () => {
      s2Fired = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(s1Fired).toBe(true);
    expect(s2Fired).toBe(true);
  });
});
