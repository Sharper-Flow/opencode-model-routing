import { describe, expect, test } from "bun:test";
import { loadFallbackChains } from "../src/config/loader.ts";
import type { ModelKey } from "../src/types.ts";

describe("loadFallbackChains", () => {
  test("reads chain from plugin tuple options", () => {
    const pluginOptions = {
      agents: {
        scout: { fallback_models: ["openai/gpt-5", "google/gemini-2.5-pro"] },
      },
    };
    const { chains, warnings } = loadFallbackChains({}, undefined, pluginOptions);
    expect(chains.size).toBe(1);
    expect(chains.get("scout")).toEqual(["openai/gpt-5", "google/gemini-2.5-pro"]);
    expect(warnings).toEqual([]);
  });

  test("plugin tuple options win over legacy agent options", () => {
    const cfg = { agent: { scout: { options: { fallback_models: ["legacy/path"] } } } };
    const pluginOptions = { agents: { scout: { fallback_models: ["plugin/path"] } } };
    const { chains, warnings } = loadFallbackChains(cfg, undefined, pluginOptions);
    expect(chains.get("scout")).toEqual(["plugin/path"]);
    expect(warnings.some((w) => w.includes("ignored") && w.includes("plugin options"))).toBe(true);
  });

  test("reads legacy chain from agent options path with migration warning", () => {
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
    expect(warnings.some((w) => w.includes("legacy agent options"))).toBe(true);
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

  test("agent options path wins over sibling path", () => {
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
    expect(warnings.some((w) => w.includes("legacy agent options"))).toBe(true);
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
