// Configuration loader: reads per-agent fallback chains and blocked-model
// sets from OMR plugin tuple options, with legacy OpenCode config fallback
// for chain migration.
//
// Canonical shape is pluginOptions.agents.<name>.fallback_models and
// pluginOptions.agents.<name>.blocked_models per
// schema/fallback-schema.json. Legacy agent.<name>.options.fallback_models
// is migration-only because OpenCode forwards agent.options to provider
// requests. blocked_models has no legacy path — it is plugin-tuple-only.
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
export const modelKeyPattern =
  /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_:/-]+(\.[A-Za-z0-9_:/-]+)*$/;

// Mirrors `maxItems` for fallback_models in schema/fallback-schema.json.
export const maxChainLength = 8;

// Mirrors `maxItems` for blocked_models in schema/fallback-schema.json.
// The blocklist cap is larger than the chain cap because blocked keys may
// name models outside the configured chain (e.g. user-selected primaries
// that must never serve this agent).
export const maxBlocklistLength = 16;

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

export interface PluginOptionsShape {
  agents?: Record<
    string,
    {
      fallback_models?: unknown;
      blocked_models?: unknown;
    }
  >;
}

export interface LoaderResult {
  chains: Map<string, ModelKey[]>;
  // Per-agent blocked-model sets, keyed by agent name. Populated only from
  // plugin tuple options (no legacy path). Absent agent == empty set ==
  // blocklist inactive for that agent.
  blocked: Map<string, Set<ModelKey>>;
  warnings: string[];
}

function validateModelKeyEntries(
  raw: unknown[],
  maxItems: number,
): {
  keys: ModelKey[];
  dropped: number;
} {
  const out: ModelKey[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const v of raw) {
    if (
      typeof v !== "string" ||
      !modelKeyPattern.test(v) ||
      v.includes("..") ||
      seen.has(v)
    ) {
      dropped += 1;
      continue;
    }
    seen.add(v);
    out.push(v as ModelKey);
    if (out.length >= maxItems) break;
  }
  return { keys: out, dropped };
}

/**
 * loadFallbackChains reads per-agent chains and blocked-model sets from the
 * OpenCode config hook input. Returns a Map keyed by agent name with
 * validated chains, a parallel Map of validated blocked sets, and warnings.
 * Emits a one-time deprecation warning per agent that uses the legacy
 * sibling path.
 *
 * Defensive: malformed individual entries are skipped and reported as warnings.
 * A malformed chain does NOT throw — it returns an empty array. The caller
 * (`plugin/src/plugin.ts`) treats an empty chain as "no fallback".
 */
export function loadFallbackChains(
  cfg: ConfigShape | unknown,
  logger?: Logger,
  pluginOptions?: PluginOptionsShape | unknown,
): LoaderResult {
  const chains = new Map<string, ModelKey[]>();
  const blocked = new Map<string, Set<ModelKey>>();
  const warnings: string[] = [];

  const pluginAgents =
    pluginOptions &&
    typeof pluginOptions === "object" &&
    !Array.isArray(pluginOptions)
      ? (pluginOptions as PluginOptionsShape).agents
      : undefined;
  if (pluginAgents && typeof pluginAgents === "object") {
    for (const [name, agent] of Object.entries(pluginAgents)) {
      if (!name || !name.trim()) continue;
      if (!agent || typeof agent !== "object") continue;
      const raw = agent.fallback_models;
      if (Array.isArray(raw)) {
        const { keys: validated, dropped } = validateModelKeyEntries(
          raw,
          maxChainLength,
        );
        if (dropped > 0) {
          const msg = `plugin option agent '${name}' has ${dropped} invalid fallback_models entr${dropped === 1 ? "y" : "ies"}; skipped`;
          warnings.push(msg);
          logger?.warn("loader.invalid_plugin_option_entries", {
            agent: name,
            count: dropped,
            field: "fallback_models",
          });
        }
        if (validated.length > 0) chains.set(name, validated);
      }

      const rawBlocked = agent.blocked_models;
      if (Array.isArray(rawBlocked)) {
        const { keys: validated, dropped } = validateModelKeyEntries(
          rawBlocked,
          maxBlocklistLength,
        );
        if (dropped > 0) {
          const msg = `plugin option agent '${name}' has ${dropped} invalid blocked_models entr${dropped === 1 ? "y" : "ies"}; skipped`;
          warnings.push(msg);
          logger?.warn("loader.invalid_plugin_option_entries", {
            agent: name,
            count: dropped,
            field: "blocked_models",
          });
        }
        if (validated.length > 0) blocked.set(name, new Set(validated));
      }
    }
  }

  const root = (cfg ?? {}) as ConfigShape;
  const agents = root.agent ?? {};
  if (typeof agents !== "object" || agents === null) {
    return { chains, blocked, warnings };
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

    if (chains.has(name)) {
      const msg = `agent '${name}' has legacy agent.options.fallback_models ignored because plugin options define a chain`;
      warnings.push(msg);
      logger?.warn("loader.legacy_ignored_plugin_options_win", { agent: name });
      continue;
    }

    const { keys: validated, dropped } = validateModelKeyEntries(
      chainRaw as unknown[],
      maxChainLength,
    );
    if (dropped > 0) {
      const msg = `agent '${name}' has ${dropped} invalid fallback_models entr${dropped === 1 ? "y" : "ies"}; skipped`;
      warnings.push(msg);
      logger?.warn("loader.invalid_entries", { agent: name, count: dropped });
    }
    if (validated.length === 0) continue;

    chains.set(name, validated);

    if (usedLegacy) {
      const msg = `agent '${name}' uses legacy sibling-path 'fallback_models'; prefer plugin tuple options`;
      warnings.push(msg);
      logger?.warn("loader.legacy_path", { agent: name });
    } else {
      const msg = `agent '${name}' uses legacy agent options fallback_models; prefer plugin tuple options`;
      warnings.push(msg);
      logger?.warn("loader.legacy_agent_options", { agent: name });
    }
  }

  return { chains, blocked, warnings };
}
