// Configuration loader: reads per-agent fallback chains from the OpenCode
// config object passed by the `config` hook input.
//
// Canonical JSON path is `agent.<name>.options.fallback_models` per
// schema/fallback-schema.json — OpenCode's AgentConfig normalize() relocates
// any non-allow-listed sibling into `options`, so we read from the documented
// extension slot rather than relying on the transform side-effect.
//
// Transitional path: `agent.<name>.fallback_models` (top-level sibling) is
// also read as a fallback — a user who hand-edits sibling keys into their
// config will see the chain still load, accompanied by a one-time
// deprecation log line per agent name.

import type { Logger } from "../logging/logger.ts";
import type { ModelKey } from "../types.ts";

// Mirrors `items.pattern` in schema/fallback-schema.json. Validation is
// inline (no JSON-Schema runtime dependency) — both the Go side and this
// side reference the schema file but apply the pattern themselves.
export const modelKeyPattern = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_:/-]+(\.[A-Za-z0-9_:/-]+)*$/;

// Mirrors `maxItems` in schema/fallback-schema.json.
export const maxChainLength = 8;

export interface AgentConfigShape {
  // What OpenCode's parsed AgentConfig actually looks like at runtime is
  // permissive — we read defensively via `any`.
  options?: { fallback_models?: unknown };
  // Transitional / legacy sibling path. Hand-edited configs may have this.
  fallback_models?: unknown;
}

export interface ConfigShape {
  agent?: Record<string, AgentConfigShape>;
}

export interface LoaderResult {
  chains: Map<string, ModelKey[]>;
  warnings: string[];
}

function validateChainEntries(raw: unknown[]): { chain: ModelKey[]; dropped: number } {
  const out: ModelKey[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const v of raw) {
    if (typeof v !== "string" || !modelKeyPattern.test(v) || v.includes("..") || seen.has(v)) {
      dropped += 1;
      continue;
    }
    seen.add(v);
    out.push(v as ModelKey);
    if (out.length >= maxChainLength) break;
  }
  return { chain: out, dropped };
}

/**
 * loadFallbackChains reads per-agent chains from the OpenCode config hook
 * input. Returns a Map keyed by agent name with validated chains. Emits a
 * one-time deprecation warning per agent that uses the legacy sibling path.
 *
 * Defensive: malformed individual entries are skipped and reported as warnings.
 * A malformed chain does NOT throw — it returns an empty array. The caller
 * (`plugin/src/plugin.ts`) treats an empty chain as "no fallback".
 */
export function loadFallbackChains(cfg: ConfigShape | unknown, logger?: Logger): LoaderResult {
  const chains = new Map<string, ModelKey[]>();
  const warnings: string[] = [];

  const root = (cfg ?? {}) as ConfigShape;
  const agents = root.agent ?? {};
  if (typeof agents !== "object" || agents === null) {
    return { chains, warnings };
  }

  for (const [name, agent] of Object.entries(agents)) {
    // Skip empty/whitespace agent names. Handler call sites use
    // `agentName ? chains.get(agentName) : []` so an entry keyed by "" would
    // be created but unreachable. Skip at load-time to avoid the dead entry.
    if (!name || !name.trim()) continue;
    if (!agent || typeof agent !== "object") continue;

    // Primary path: agent.<name>.options.fallback_models
    const optionsRaw = (agent as AgentConfigShape).options?.fallback_models;
    const siblingRaw = (agent as AgentConfigShape).fallback_models;

    let chainRaw: unknown = undefined;
    let usedLegacy = false;
    if (Array.isArray(optionsRaw)) {
      chainRaw = optionsRaw;
    } else if (Array.isArray(siblingRaw)) {
      chainRaw = siblingRaw;
      usedLegacy = true;
    }
    if (chainRaw === undefined) continue;

    const { chain: validated, dropped } = validateChainEntries(chainRaw as unknown[]);
    if (dropped > 0) {
      const msg = `agent '${name}' has ${dropped} invalid fallback_models entr${dropped === 1 ? "y" : "ies"}; skipped`;
      warnings.push(msg);
      logger?.warn("loader.invalid_entries", { agent: name, count: dropped });
    }
    if (validated.length === 0) continue;

    chains.set(name, validated);

    if (usedLegacy) {
      const msg = `agent '${name}' uses legacy sibling-path 'fallback_models'; prefer 'options.fallback_models'`;
      warnings.push(msg);
      logger?.warn("loader.legacy_path", { agent: name });
    }
  }

  return { chains, warnings };
}
