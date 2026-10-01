// Configuration loader: reads per-agent fallback chains and blocked-model
// sets from OMR plugin tuple options, with legacy OpenCode config fallback
// for chain migration.
//
// Canonical shape is pluginOptions.agents.<name>.fallback_models and
// pluginOptions.agents.<name>.blocked_models per
// schema/fallback-schema.json. Legacy agent.<name>.options.fallback_models
// is migration-only because OpenCode forwards agent.options to provider
// requests. blocked_models has no legacy path — it is plugin-tuple-only.
// The global model_families map and the per-agent
// family_disjoint_from_parent toggle are plugin-tuple-only as well.
//
// Transitional path: `agent.<name>.fallback_models` (top-level sibling) is
// also read as a fallback — a user who hand-edits sibling keys into their
// config will see the chain still load, accompanied by a one-time
// deprecation log line per agent name.

import type { Logger } from "../logging/logger.ts";
import { isRecord } from "../utils/type-guards.ts";
import type {
  JevConfig,
  ModelKey,
  RouterGrade,
  RouterTiers,
} from "../types.ts";

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

// Bound for the global `model_families` map. The map only needs to cover the
// opted-in agents' chains plus the models that can serve their requesters;
// a larger map than this signals a misconfigured key set rather than a real
// fleet.
export const maxFamilyMapEntries = 64;

// Bound for the global `provider_session_caps` map. The map covers the
// providers named in the designated agents' router tiers; anything larger is
// a misconfiguration, not a fleet.
export const maxProviderSessionCapsEntries = 16;

// Closed grade-key set for `router.tiers`. The router grades low | medium |
// high | extreme; any other key is dropped with a warning.
export const ROUTER_GRADE_KEYS: readonly RouterGrade[] = [
  "low",
  "medium",
  "high",
  "extreme",
] as const;

// Provider-id pattern: the ModelKey prefix before the first slash (the same
// first-char discipline as the model-key pattern).
export const providerIdPattern = /^[a-z0-9][a-z0-9-]*$/;

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
      family_disjoint_from_parent?: unknown;
      router?: unknown;
    }
  >;
  // Global model-key → family map (model_families). Flat and closed, the
  // same shape class as cooldownMsByCategory: one typed map, not a rule
  // language.
  model_families?: unknown;
  // Global providerID → positive concurrent-session cap for the first-turn
  // router. Per provider because plan concurrency is per account.
  provider_session_caps?: unknown;
  // Jev classifier configuration (api_key_file).
  jev?: unknown;
}

export interface LoaderResult {
  chains: Map<string, ModelKey[]>;
  // Per-agent blocked-model sets, keyed by agent name. Populated only from
  // plugin tuple options (no legacy path). Absent agent == empty set ==
  // blocklist inactive for that agent.
  blocked: Map<string, Set<ModelKey>>;
  // Model-key → family, from plugin tuple `model_families`. Keys are
  // validated with the same pattern as chain entries; values are non-empty
  // trimmed strings. Invalid entries are dropped with a warning.
  families: Map<ModelKey, string>;
  // Agent names with `family_disjoint_from_parent: true`. Only agents in
  // this set get the family constraint; routing for every other agent is
  // untouched.
  familyDisjoint: Set<string>;
  // Per-agent router tier lists, keyed by agent name. Presence designates
  // the agent for the first-turn router. Only plugin-tuple agents with at
  // least one valid tier appear here.
  routers: Map<string, RouterTiers>;
  // ProviderID → positive concurrent-session cap, from plugin tuple
  // `provider_session_caps`.
  providerSessionCaps: Map<string, number>;
  // Jev classifier config, from plugin tuple `jev`. Undefined when absent or
  // invalid (the router then fails open with no Jev call).
  jev: JevConfig | undefined;
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

// Parse one agent's `router` block into RouterTiers. Closed shape: only
// `tiers` is read, and `tiers` carries only the four grade keys. A block
// with no valid tier does not designate the agent (null + dropped count).
function parseRouterTiers(raw: unknown): {
  tiers: RouterTiers;
  dropped: number;
} | null {
  if (!isRecord(raw)) return null;
  const tiersRaw = raw.tiers;
  if (!isRecord(tiersRaw)) return null;
  const tiers: RouterTiers = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(tiersRaw)) {
    if (!ROUTER_GRADE_KEYS.includes(key as RouterGrade)) {
      dropped += 1;
      continue;
    }
    if (!Array.isArray(value)) {
      dropped += 1;
      continue;
    }
    const { keys, dropped: invalid } = validateModelKeyEntries(
      value,
      maxChainLength,
    );
    dropped += invalid;
    if (keys.length > 0) {
      tiers[key as RouterGrade] = keys;
    }
  }
  return { tiers, dropped };
}

// Parse `provider_session_caps`: providerID → positive finite integer.
function parseProviderSessionCaps(raw: unknown): {
  caps: Map<string, number>;
  dropped: number;
} {
  const caps = new Map<string, number>();
  if (!isRecord(raw)) return { caps, dropped: 1 };
  let dropped = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (caps.size >= maxProviderSessionCapsEntries) {
      dropped += 1;
      continue;
    }
    if (
      !providerIdPattern.test(key) ||
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      dropped += 1;
      continue;
    }
    caps.set(key, value);
  }
  return { caps, dropped };
}

// Parse `jev`: { api_key_file: non-empty string }.
function parseJevConfig(raw: unknown): JevConfig | null {
  if (!isRecord(raw)) return null;
  const file = raw.api_key_file;
  if (typeof file !== "string" || file.trim().length === 0) return null;
  return { apiKeyFile: file };
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
  const families = new Map<ModelKey, string>();
  const familyDisjoint = new Set<string>();
  const routers = new Map<string, RouterTiers>();
  const providerSessionCaps = new Map<string, number>();
  let jev: JevConfig | undefined;
  const warnings: string[] = [];

  const tupleOptions =
    pluginOptions &&
    typeof pluginOptions === "object" &&
    !Array.isArray(pluginOptions)
      ? (pluginOptions as PluginOptionsShape)
      : undefined;
  const pluginAgents = tupleOptions?.agents;
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

      // Strict boolean true — the constraint is a closed toggle, and any
      // other value (including "true" strings or 1) is ignored rather than
      // coerced.
      if (agent.family_disjoint_from_parent === true) {
        familyDisjoint.add(name);
      }

      // First-turn router designation. Presence of a valid `router` block
      // designates the agent; a block that parses to no valid tier is
      // reported and ignored (the agent stays unrouted).
      if (agent.router !== undefined) {
        const parsed = parseRouterTiers(agent.router);
        if (!parsed) {
          const msg = `plugin option agent '${name}' has a malformed router block; ignored`;
          warnings.push(msg);
          logger?.warn("loader.invalid_router_block", { agent: name });
        } else {
          if (parsed.dropped > 0) {
            const msg = `plugin option agent '${name}' router block has ${parsed.dropped} invalid entr${parsed.dropped === 1 ? "y" : "ies"}; skipped`;
            warnings.push(msg);
            logger?.warn("loader.invalid_plugin_option_entries", {
              agent: name,
              count: parsed.dropped,
              field: "router.tiers",
            });
          }
          if (Object.keys(parsed.tiers).length > 0) {
            routers.set(name, parsed.tiers);
          } else {
            const msg = `plugin option agent '${name}' router block has no valid tiers; agent not designated`;
            warnings.push(msg);
            logger?.warn("loader.empty_router_tiers", { agent: name });
          }
        }
      }
    }
  }

  // provider_session_caps is a sibling of `agents` at the plugin tuple
  // level, so it parses even when no agents block is present.
  if (tupleOptions && tupleOptions.provider_session_caps !== undefined) {
    const { caps, dropped } = parseProviderSessionCaps(
      tupleOptions.provider_session_caps,
    );
    for (const [provider, cap] of caps) providerSessionCaps.set(provider, cap);
    if (dropped > 0) {
      const msg = `plugin option provider_session_caps has ${dropped} invalid entr${dropped === 1 ? "y" : "ies"}; skipped`;
      warnings.push(msg);
      logger?.warn("loader.invalid_plugin_option_entries", {
        count: dropped,
        field: "provider_session_caps",
      });
    }
  }

  if (tupleOptions && tupleOptions.jev !== undefined) {
    const parsed = parseJevConfig(tupleOptions.jev);
    if (!parsed) {
      const msg =
        "plugin option jev must be { api_key_file: <non-empty path> }; ignored";
      warnings.push(msg);
      logger?.warn("loader.invalid_jev_config");
    } else {
      jev = parsed;
    }
  }

  // model_families is a sibling of `agents` at the plugin tuple level, so
  // it parses even when no agents block is present.
  if (
    pluginOptions &&
    typeof pluginOptions === "object" &&
    !Array.isArray(pluginOptions)
  ) {
    const rawFamilies = (pluginOptions as PluginOptionsShape).model_families;
    if (rawFamilies !== undefined) {
      if (!isRecord(rawFamilies)) {
        const msg =
          "plugin option model_families must be an object of model-key → family; ignored";
        warnings.push(msg);
        logger?.warn("loader.invalid_family_map", {
          shape: typeof rawFamilies,
        });
      } else {
        let dropped = 0;
        for (const [key, value] of Object.entries(rawFamilies)) {
          if (
            !modelKeyPattern.test(key) ||
            key.includes("..") ||
            typeof value !== "string" ||
            value.trim().length === 0
          ) {
            dropped += 1;
            continue;
          }
          if (families.size >= maxFamilyMapEntries) {
            dropped += 1;
            continue;
          }
          families.set(key as ModelKey, value.trim());
        }
        if (dropped > 0) {
          const msg = `plugin option model_families has ${dropped} invalid entr${dropped === 1 ? "y" : "ies"}; skipped`;
          warnings.push(msg);
          logger?.warn("loader.invalid_plugin_option_entries", {
            count: dropped,
            field: "model_families",
          });
        }
      }
    }
  }

  const root = (cfg ?? {}) as ConfigShape;
  const agents = root.agent ?? {};
  if (typeof agents !== "object" || agents === null) {
    return {
      chains,
      blocked,
      families,
      familyDisjoint,
      routers,
      providerSessionCaps,
      jev,
      warnings,
    };
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

  return {
    chains,
    blocked,
    families,
    familyDisjoint,
    routers,
    providerSessionCaps,
    jev,
    warnings,
  };
}
