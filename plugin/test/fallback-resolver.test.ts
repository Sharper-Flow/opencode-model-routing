import { describe, expect, test } from "bun:test";
import { resolveFallbackModel } from "../src/resolution/fallback-resolver.ts";
import { ModelHealthMap } from "../src/state/model-health.ts";
import type { ModelKey } from "../src/types.ts";

const chain: ModelKey[] = ["a/one", "b/two", "c/three"];

describe("resolveFallbackModel", () => {
  test("picks first model after current", () => {
    const health = new ModelHealthMap();
    expect(resolveFallbackModel("a/one", chain, 0, health, 3)).toBe("b/two");
  });

  test("picks second model when first fallback is cooled", () => {
    const now = 1_000_000;
    const health = new ModelHealthMap(() => now);
    health.cooldown("b/two" as ModelKey, 5_000);
    expect(resolveFallbackModel("a/one", chain, 0, health, 3)).toBe("c/three");
  });

  test("returns null when chain exhausted", () => {
    const health = new ModelHealthMap();
    expect(resolveFallbackModel("c/three", chain, 0, health, 3)).toBeNull();
  });

  test("returns null when all remaining models are cooled", () => {
    const now = 1_000_000;
    const health = new ModelHealthMap(() => now);
    health.cooldown("b/two" as ModelKey, 5_000);
    health.cooldown("c/three" as ModelKey, 5_000);
    expect(resolveFallbackModel("a/one", chain, 0, health, 3)).toBeNull();
  });

  test("returns null at maxDepth", () => {
    const health = new ModelHealthMap();
    expect(resolveFallbackModel("a/one", chain, 3, health, 3)).toBeNull();
  });

  test("returns null for empty chain", () => {
    const health = new ModelHealthMap();
    expect(resolveFallbackModel("a/one", [], 0, health, 3)).toBeNull();
  });

  test("currentModel not in chain → starts at index 0", () => {
    const health = new ModelHealthMap();
    expect(resolveFallbackModel("primary/main", chain, 0, health, 3)).toBe(
      "a/one",
    );
  });

  test("null currentModel → starts at index 0", () => {
    const health = new ModelHealthMap();
    expect(resolveFallbackModel(null, chain, 0, health, 3)).toBe("a/one");
  });

  describe("blocked set", () => {
    test("skips a blocked entry and lands on the next allowed one", () => {
      const health = new ModelHealthMap();
      const blocked = new Set<ModelKey>(["b/two"]);
      expect(resolveFallbackModel("a/one", chain, 0, health, 3, blocked)).toBe(
        "c/three",
      );
    });

    test("null currentModel scans from the top, skipping blocked entries", () => {
      const health = new ModelHealthMap();
      const blocked = new Set<ModelKey>(["a/one"]);
      expect(resolveFallbackModel(null, chain, 0, health, 3, blocked)).toBe(
        "b/two",
      );
    });

    test("blocked and cooled entries are both skipped", () => {
      const now = 1_000_000;
      const health = new ModelHealthMap(() => now);
      health.cooldown("b/two" as ModelKey, 5_000);
      const blocked = new Set<ModelKey>(["c/three"]);
      expect(
        resolveFallbackModel("a/one", chain, 0, health, 3, blocked),
      ).toBeNull();
    });

    test("returns null when every remaining entry is blocked", () => {
      const health = new ModelHealthMap();
      const blocked = new Set<ModelKey>(["b/two", "c/three"]);
      expect(
        resolveFallbackModel("a/one", chain, 0, health, 3, blocked),
      ).toBeNull();
    });
  });
});
