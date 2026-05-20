import { describe, expect, test } from "bun:test";
import { loadFallbackChains } from "../src/config/loader.ts";
import type { ModelKey } from "../src/types.ts";

describe("loadFallbackChains — options.fallback_models", () => {
  test("reads chain from canonical options path", () => {
    const cfg = {
      agent: {
        scout: {
          options: { fallback_models: ["openai/gpt-5", "google/gemini-2.5-pro"] },
        },
      },
    };
    const { chains, warnings } = loadFallbackChains(cfg);
    expect(chains.size).toBe(1);
    expect(chains.get("scout")).toEqual(["openai/gpt-5", "google/gemini-2.5-pro"]);
    expect(warnings).toEqual([]);
  });

  test("reads chain from legacy sibling path with deprecation warning", () => {
    const cfg = {
      agent: {
        scout: { fallback_models: ["openai/gpt-5"] },
      },
    };
    const { chains, warnings } = loadFallbackChains(cfg);
    expect(chains.get("scout")).toEqual(["openai/gpt-5"]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("scout");
    expect(warnings[0]).toContain("legacy");
  });

  test("options path wins over sibling path (no warning emitted)", () => {
    const cfg = {
      agent: {
        scout: {
          options: { fallback_models: ["winner/options"] },
          fallback_models: ["loser/sibling"],
        },
      },
    };
    const { chains, warnings } = loadFallbackChains(cfg);
    expect(chains.get("scout")).toEqual(["winner/options"]);
    expect(warnings).toEqual([]);
  });

  test("malformed entries dropped with warnings", () => {
    const cfg = {
      agent: {
        scout: {
          options: {
            fallback_models: [
              "openai/gpt-5",
              "BADNOSLASH",
              "OpenAI/UpperProvider",
              123,
              "google/gemini-2.5-pro",
              "openai/../secret",
            ],
          },
        },
      },
    };
    const { chains, warnings } = loadFallbackChains(cfg);
    expect(chains.get("scout")).toEqual(["openai/gpt-5", "google/gemini-2.5-pro"]);
    expect(warnings).toContain("agent 'scout' has 4 invalid fallback_models entries; skipped");
  });

  test("empty agents map returns empty chains", () => {
    expect(loadFallbackChains({}).chains.size).toBe(0);
    expect(loadFallbackChains({ agent: {} }).chains.size).toBe(0);
    expect(loadFallbackChains(null).chains.size).toBe(0);
    expect(loadFallbackChains(undefined).chains.size).toBe(0);
  });

  test("absent fallback_models = no entry in map", () => {
    const cfg = {
      agent: {
        scout: { options: {} },
      },
    };
    expect(loadFallbackChains(cfg).chains.has("scout")).toBe(false);
  });

  test("schema examples accepted verbatim", () => {
    // Examples from schema/fallback-schema.json must pass validation.
    const valid: ModelKey[][] = [
      ["openai/gpt-5"],
      ["openai/gpt-5", "google/gemini-2.5-pro", "anthropic/claude-sonnet-4-5"],
    ];
    for (const chain of valid) {
      const cfg = { agent: { x: { options: { fallback_models: chain } } } };
      const { chains } = loadFallbackChains(cfg);
      expect(chains.get("x")).toEqual(chain);
    }
  });
});
