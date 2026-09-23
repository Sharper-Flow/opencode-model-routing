// plugin-internal.ts — testable OpenCode plugin implementation helpers.
//
// Wires the hooks:
//   - chat.message: preemptive skip + TTFT arm
//   - event: session.error / session.status retry / session.idle / token arrival
//   - config: receives merged OpenCode Config; rebuilds chains in-place
//
// Per-process state is held in a closure (FallbackStore + chains map + TTFT
// registry). The chains map is populated by the `config` hook (fires once
// after plugin init and may re-fire on config reload) — see createPluginHooks
// for the ordering guarantee against OpenCode's bus.subscribeAll().

import {
  ExhaustionGuardRegistry,
  shouldSuppressReplay,
} from "./availability/guard.ts";
import {
  applyAvailabilityPreflight,
  claudeUnavailableVeto,
} from "./availability/preflight.ts";
import { readAvailabilitySnapshot } from "./availability/snapshot.ts";
import {
  resolveProviderReportedBoundary,
  type QuotaBoundaryResolver,
} from "./availability/quota-state.ts";
import { loadFallbackChains } from "./config/loader.ts";
import {
  classifyRetryStatusText,
  classifySessionError,
  type SessionErrorData,
  type SessionErrorLike,
} from "./detection/classifier.ts";
import { createLogger, type Logger } from "./logging/logger.ts";
import { applyPreemptiveSkip } from "./preemptive.ts";
import {
  attemptFallback,
  type OrchestratorClient,
  parseModelKey,
  type ReplayTail,
} from "./replay/orchestrator.ts";
import { resolveAgentName } from "./resolution/agent-resolver.ts";
import { resolveFallbackModel } from "./resolution/fallback-resolver.ts";
import { familyVetoFor } from "./resolution/family.ts";
import { CooldownStore, getCooldownPath } from "./state/cooldown-store.ts";
import { FallbackStore } from "./state/store.ts";
import { TtftRegistry } from "./ttft.ts";
import {
  defaultConfig,
  type ErrorCategory,
  type ModelKey,
  type PluginConfig,
  type ReplayResult,
} from "./types.ts";
import { isRecord, messageInfo, unwrapSdkData } from "./utils/type-guards.ts";

// Real OpenCode PluginInput shape per @opencode-ai/plugin@1.15.5 PluginInput
// + packages/opencode/src/plugin/index.ts:134-150 source. NO `config` field —
// OpenCode delivers the merged Config via the Hooks.config callback after
// init, not via PluginInput. (Pre-fix OMR read `opts.config` which was always
// `undefined` → chains map empty → every fallback exited "no chain" silently.)
export interface PluginInput {
  client: OrchestratorClient & {
    session: OrchestratorClient["session"];
  };
  directory?: string;
  worktree?: string;
}

export interface PluginHooks {
  "chat.message"?: (
    input: unknown,
    output: unknown,
  ) => unknown | Promise<unknown>;
  "chat.params"?: (
    input: unknown,
    output: unknown,
  ) => unknown | Promise<unknown>;
  event?: (input: unknown) => unknown | Promise<unknown>;
  // Hooks.config per @opencode-ai/plugin SDK — receives merged OpenCode Config
  // after plugin init and BEFORE bus.subscribeAll() — see ordering proof in
  // packages/opencode/src/plugin/index.ts:217-237 @ 7fe7b9f.
  config?: (input: unknown) => unknown | Promise<unknown>;
}

export interface PluginContext {
  store: FallbackStore;
  ttft: TtftRegistry;
  guard: ExhaustionGuardRegistry;
  chains: Map<string, ModelKey[]>;
  // Per-agent blocked-model sets from plugin tuple options
  // (agents.<name>.blocked_models). Same lifecycle as `chains`: populated
  // by the Hooks.config callback, mutated in-place on re-delivery.
  blocked: Map<string, Set<ModelKey>>;
  // Model-key → family map from the plugin tuple `model_families`. Same
  // in-place-reload lifecycle as `blocked`.
  families: Map<ModelKey, string>;
  // Agent names opted into family_disjoint_from_parent. Only these agents
  // get the family constraint; routing for every other agent is untouched.
  familyDisjoint: Set<string>;
  config: PluginConfig;
  logger: Logger;
  pluginOptions?: unknown;
  // Provider-reported quota boundary resolver. Undefined by default so
  // nothing spawns on the test path; createPluginHooks (the production
  // composition root) wires the real consumer, and handleFailureSignal
  // carries it into attemptFallback for quota_exhausted / rate_limit
  // failures only.
  quotaBoundary?: QuotaBoundaryResolver;
  // Host-specific replay tail (orchestrator.ReplayTail). Undefined on the
  // V1 path — attemptFallback keeps its abort → revert → prompt sequence.
  // The OpenCode 2 setup wires switchModel, plus interrupt({resume:true})
  // on the TTFT entrance: classified failures replay through the approved
  // host retry, TTFT timeouts through interrupt+resume on the switched
  // model (the stalled request never reaches the retry hook).
  replayTail?: ReplayTail;
}

// Compile-time-exhaustive category set: adding/removing an ErrorCategory
// member in types.ts fails the `satisfies Record<ErrorCategory, true>` check,
// preventing drift between the runtime allow-list and the union type.
const KNOWN_CATEGORIES = {
  rate_limit: true,
  server_error: true,
  unknown_model: true,
  auth_error: true,
  ttft_timeout: true,
  quota_exhausted: true,
  unknown: true,
} as const satisfies Record<ErrorCategory, true>;

// Prototype-safe membership check. `s in KNOWN_CATEGORIES` would accept
// inherited names like "toString", "constructor", "__proto__" — Object.hasOwn
// does not traverse the prototype chain.
function isErrorCategory(s: string): s is ErrorCategory {
  return Object.hasOwn(KNOWN_CATEGORIES, s);
}

/**
 * Extract and validate cooldownMsByCategory overrides from the plugin tuple
 * option (`pluginOptions.cooldownMsByCategory`). Defensive: malformed entries
 * are dropped with a warn log, never crash. Returns undefined when absent or
 * entirely invalid — caller falls through to defaultConfig.
 *
 * Infinity handling: Number.POSITIVE_INFINITY is the documented "permanent
 * block within process lifetime" sentinel (types.ts:55-56). It is accepted
 * programmatically (tests, internal callers) but cannot be expressed in JSON
 * configuration (RFC 8259 §6 forbids Infinity in JSON numbers) — users wishing
 * permanent block must use a sufficiently large finite value (e.g., 10 years)
 * or await a future JSON-representable sentinel contract (out of scope).
 *
 * Exported for direct unit testing.
 */
export function extractCooldownOverrides(
  pluginOptions: unknown,
  logger: Logger,
): Partial<Record<ErrorCategory, number>> | undefined {
  if (!isRecord(pluginOptions)) return undefined;
  const raw = (pluginOptions as { cooldownMsByCategory?: unknown })
    .cooldownMsByCategory;
  if (!isRecord(raw)) return undefined;
  const out: Partial<Record<ErrorCategory, number>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isErrorCategory(k)) {
      logger.warn("pluginOptions.cooldown.invalid_category", { category: k });
      continue;
    }
    // Accept finite non-negative numbers OR +Infinity (programmatic sentinel).
    // Reject NaN, -Infinity, negative, and non-number types.
    if (
      typeof v !== "number" ||
      Number.isNaN(v) ||
      v === Number.NEGATIVE_INFINITY ||
      v < 0 ||
      !(Number.isFinite(v) || v === Number.POSITIVE_INFINITY)
    ) {
      logger.warn("pluginOptions.cooldown.invalid_value", {
        category: k,
        value: v,
      });
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * createPluginContext — exposed for testing. Production wires this into the
 * default-exported plugin function below.
 *
 * Chains start empty; OpenCode delivers config via the Hooks.config callback
 * after plugin init (see createPluginHooks below + ordering proof in
 * packages/opencode/src/plugin/index.ts:217-237 @ 7fe7b9f). Tests that need
 * pre-populated chains can mutate `ctx.chains` directly or call the config
 * hook synthetically via pluginModule.server({...}).then(hooks => hooks.config?.(cfg)).
 *
 * Cooldown overrides are merged in 3 layers (most-specific wins):
 *   1. defaultConfig.cooldownMsByCategory (lowest)
 *   2. opts.config?.cooldownMsByCategory (middle — programmatic/test injection)
 *   3. opts.cooldownOverrides (highest — user-side via pluginOptions)
 * The outer PluginConfig spread below is shallow; without the explicit 3-layer
 * rebuild, supplying cooldownMsByCategory via opts.config would clobber the
 * default inner map.
 */
export function createPluginContext(
  opts: {
    config?: Partial<PluginConfig>;
    cooldownOverrides?: Partial<Record<ErrorCategory, number>>;
    logger?: Logger;
    pluginOptions?: unknown;
    quotaBoundary?: QuotaBoundaryResolver;
  } = {},
): PluginContext {
  const logger = opts.logger ?? createLogger();
  const merged: PluginConfig = { ...defaultConfig, ...(opts.config ?? {}) };

  // 3-layer cooldown merge: default → opts.config → pluginOptions overrides.
  // Only rebuild when at least one override layer is present; otherwise the
  // default from the spread above is correct.
  const layerConfig = opts.config?.cooldownMsByCategory;
  if (layerConfig !== undefined || opts.cooldownOverrides !== undefined) {
    merged.cooldownMsByCategory = {
      ...defaultConfig.cooldownMsByCategory,
      ...(layerConfig ?? {}),
      ...(opts.cooldownOverrides ?? {}),
    };
  }

  return {
    store: new FallbackStore(
      () => Date.now(),
      new CooldownStore(getCooldownPath(), { logger }),
    ),
    ttft: new TtftRegistry(),
    guard: new ExhaustionGuardRegistry(),
    chains: new Map(),
    blocked: new Map(),
    families: new Map(),
    familyDisjoint: new Set(),
    config: merged,
    logger,
    pluginOptions: opts.pluginOptions,
    quotaBoundary: opts.quotaBoundary,
  };
}

/**
 * Internal helpers — exposed so plugin.test.ts can drive the hooks without
 * loading the full @opencode-ai/plugin runtime. Production plugin export
 * (default async function) simply calls these.
 */

interface ChatMessageInputShape {
  sessionID?: string;
  sessionId?: string;
  agent?: string;
}
interface ChatMessageOutputShape {
  message: { model?: { providerID: string; modelID: string } };
}

function hasFunction(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "function";
}

export function isPluginInput(input: unknown): input is PluginInput {
  if (!isRecord(input)) return false;
  const client = input.client;
  if (!isRecord(client)) return false;
  if (!isRecord(client.session)) return false;
  return ["messages", "abort", "revert", "prompt", "get"].every((key) =>
    hasFunction(client.session as Record<string, unknown>, key),
  );
}

export function normalizeChatMessageInput(
  input: unknown,
): ChatMessageInputShape | undefined {
  if (!isRecord(input)) return undefined;
  const sessionID =
    typeof input.sessionID === "string" ? input.sessionID : undefined;
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId : undefined;
  const agent =
    typeof input.agent === "string" && input.agent.trim().length > 0
      ? input.agent
      : undefined;
  if (!sessionID && !sessionId) return undefined;
  return { sessionID, sessionId, agent };
}

export function isChatMessageOutputShape(
  output: unknown,
): output is ChatMessageOutputShape {
  if (!isRecord(output)) return false;
  if (!isRecord(output.message)) return false;
  const model = output.message.model;
  if (model === undefined) return true;
  return (
    isRecord(model) &&
    typeof model.providerID === "string" &&
    typeof model.modelID === "string"
  );
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

/**
 * Detect whether a session is a subagent by fetching session info and
 * checking for a non-empty parentID. Used by the session.error and
 * session.status handlers to short-circuit recovery: OpenCode's parent
 * Task tool observes stream-error cancels as terminal regardless of what
 * OMR does, so abort→revert→prompt would be orphaned work. Instead, the
 * orchestrator marks the model unhealthy (so the parent's replacement
 * spawn hits preemptive redirect on chat.message) and skips recovery.
 *
 * Defensive: any fetch/shape/throw degrades to `false` (treat as primary
 * session, recover normally). Subagent detection is an optimization that
 * avoids wasted compute — never block fallback on it.
 *
 * Result is cached in the FallbackStore session-state record so subsequent
 * errors on the same session don't re-fetch.
 */
async function readSessionIdentity(
  sessionId: string,
  client: OrchestratorClient,
  store: FallbackStore,
): Promise<void> {
  const state = store.sessions.get(sessionId);
  if (state.isSubagent !== undefined) return;
  try {
    const response = await client.session.get({
      path: { id: sessionId },
    } as never);
    const data = unwrapSdkData(response);
    const parentID = isRecord(data) ? (data.parentID as unknown) : undefined;
    const hasParent = typeof parentID === "string" && parentID.length > 0;
    state.isSubagent = hasParent;
    state.parentSessionId = hasParent ? parentID : null;
    const agent = isRecord(data) ? data.agent : undefined;
    if (typeof agent === "string" && agent.trim().length > 0) {
      state.agentName = agent;
    }
  } catch {
    // Defensive: leave isSubagent undefined so a later retry can re-attempt
    // detection. Treat current call as "not a subagent" → recover normally.
  }
}

export async function detectSubagent(
  sessionId: string,
  client: OrchestratorClient,
  store: FallbackStore,
): Promise<boolean> {
  const state = store.sessions.get(sessionId);
  await readSessionIdentity(sessionId, client, store);
  return state.isSubagent ?? false;
}

/**
 * Resolve the model serving this session's requesting parent, for agents
 * opted into family_disjoint_from_parent.
 *
 * Returns undefined when the constraint does not apply (primary session, or
 * identity unreadable — same degrade-to-primary contract as detectSubagent).
 * Returns the parent's ModelKey when resolved, or null when the session is a
 * confirmed subagent but no model could be determined. A resolved key is
 * cached on the child's SessionState; null is never cached, because a
 * modelless parent is usually transient (user message committed, assistant
 * still streaming on the parent's first turn) and freezing it would disable
 * the constraint for the process lifetime.
 *
 * Resolution order: (1) the in-memory FallbackStore state for the parent
 * (lastServedModel, then currentModel) — free when the parent passed through
 * OMR in this process; (2) the parent's message history, taking the newest
 * assistant message's providerID/modelID — survives a plugin reload, because
 * a parent always has at least one assistant message by the time it spawns a
 * child (the spawn is a tool call inside one).
 */
async function resolveParentModel(
  sessionId: string,
  client: OrchestratorClient,
  store: FallbackStore,
): Promise<ModelKey | null | undefined> {
  const state = store.sessions.get(sessionId);
  if (state.parentSessionId === undefined) {
    await readSessionIdentity(sessionId, client, store);
  }
  const parent = state.parentSessionId;
  if (!parent) return undefined;
  if (state.parentModelKey !== undefined) return state.parentModelKey;

  const parentState = store.sessions.get(parent);
  const inMemory =
    parentState.lastServedModel ?? parentState.currentModel ?? null;
  if (inMemory) {
    state.parentModelKey = inMemory;
    return inMemory;
  }

  try {
    const response = await client.session.messages({
      path: { id: parent },
    } as never);
    const data = unwrapSdkData(response);
    const messages = Array.isArray(data) ? data : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messageInfo(messages[i]);
      if (!info || info.role !== "assistant") continue;
      const providerID = info.providerID;
      const modelID = info.modelID;
      if (
        typeof providerID === "string" &&
        providerID.length > 0 &&
        typeof modelID === "string" &&
        modelID.length > 0
      ) {
        const resolved = `${providerID}/${modelID}` as ModelKey;
        state.parentModelKey = resolved;
        return resolved;
      }
    }
  } catch {
    // Fetch failed: fall through to unknown; a later scan retries.
  }
  return null;
}

/**
 * Build the family-disjointness veto for one selection, or undefined when
 * the constraint is inactive for this session. Undefined (no veto, routing
 * unchanged) when: the agent did not opt in, the session is primary, the
 * parent's model is unknown, or the parent's model has no family-map entry.
 * The last two cases warn with distinct events so a configuration gap stays
 * separable from an unreadable parent in the logs.
 */
async function buildFamilyVeto(
  ctx: PluginContext,
  client: OrchestratorClient,
  sessionId: string,
  agentName: string | null,
): Promise<((key: ModelKey) => boolean) | undefined> {
  if (!agentName || !ctx.familyDisjoint.has(agentName)) return undefined;
  const parentModel = await resolveParentModel(sessionId, client, ctx.store);
  if (parentModel === undefined) return undefined;
  if (parentModel === null) {
    ctx.logger.warn("family.parent_model_unknown", {
      sessionId,
      agent: agentName,
    });
    return undefined;
  }
  const veto = familyVetoFor(parentModel, ctx.families);
  if (veto === undefined) {
    ctx.logger.warn("family.parent_model_unmapped", {
      sessionId,
      agent: agentName,
      parentModel,
    });
    return undefined;
  }
  return veto;
}

export async function handleChatMessage(
  ctx: PluginContext,
  client: OrchestratorClient,
  input: ChatMessageInputShape | undefined,
  output: ChatMessageOutputShape | undefined,
  applyRedirect?: (from: ModelKey, to: ModelKey) => Promise<void>,
): Promise<void> {
  // Defensive: OpenCode 1.15.9 may invoke chat.message with undefined args
  // during plugin registration / probe phases. Treat as no-op.
  if (!input || !output) return;
  const sessionId = input.sessionID ?? input.sessionId ?? "";
  if (!sessionId) return;

  // A new user turn begins: clear the prior turn's exhaustion-suppression
  // guard so a next valid user turn can proceed (AC5). Any replay entrance
  // later this turn re-evaluates the snapshot and may re-record it.
  ctx.guard.clearTurn(sessionId);

  // Populate state.currentModel from the hook output BEFORE agentName-dependent
  // operations. If resolveAgentName fails (e.g. messages not yet committed for a
  // freshly-spawned sub-agent), applyPreemptiveSkip returns early at
  // `if (!agentName) return` WITHOUT setting currentModel. Without this pre-set,
  // the subsequent session.error's attemptFallback hits `if (current)` → false
  // (currentModel undefined) → skips cooldown → model never marked unhealthy →
  // re-spawn hits the same dead model (the same-process fallover mystery).
  const hookModel = output.message.model;
  const hookModelKey = hookModel
    ? (`${hookModel.providerID}/${hookModel.modelID}` as ModelKey)
    : undefined;
  if (hookModel) {
    const state = ctx.store.sessions.get(sessionId);
    if (!state.currentModel) {
      state.currentModel =
        `${hookModel.providerID}/${hookModel.modelID}` as ModelKey;
      state.originalModel = state.currentModel;
    }
  }

  const state = ctx.store.sessions.get(sessionId);
  if (input.agent) state.agentName = input.agent;
  if (!state.agentName) {
    // Fresh child messages have not been committed yet. Read the structural
    // session record before falling back to message history; this shares the
    // same cached session.get result later used by detectSubagent.
    await readSessionIdentity(sessionId, client, ctx.store);
  }
  const agentName =
    state.agentName ?? (await resolveAgentName(sessionId, client, ctx.store));

  // Family disjointness: resolve the veto once per turn, after agent
  // identity and before any selection. Undefined for every non-opted-in
  // agent, an unreadable parent, or an unmapped requester — each of which
  // leaves routing unchanged (with a warn event for the latter two).
  const familyVeto = await buildFamilyVeto(ctx, client, sessionId, agentName);

  // Availability preflight: consume one descriptor-validated snapshot per
  // turn. Only a fresh, structurally valid `unavailable` snapshot redirects an
  // Anthropic/Claude selection to the first healthy configured non-Anthropic
  // chain entry before dispatch — no Claude child attempt starts on confirmed
  // exhaustion. Missing/stale/malformed/wrong-permission/unknown-version
  // snapshot → null → no-op; non-Anthropic selections are never touched.
  const snapshot = readAvailabilitySnapshot();
  applyAvailabilityPreflight(
    { sessionId, agentName, output, snapshot },
    ctx.store,
    ctx.chains,
    ctx.logger,
    familyVeto,
  );

  applyPreemptiveSkip(
    { sessionId, agentName, output, snapshot },
    ctx.store,
    ctx.chains,
    ctx.config,
    ctx.logger,
    ctx.blocked,
    familyVeto,
  );

  // Record the model actually about to serve this dispatch — captured AFTER
  // the availability preflight and preemptive skip, either of which may have
  // redirected output.message.model to a healthy chain entry. Under the V2
  // context hook the redirect is not yet visible to the host: applyRedirect
  // must push it onto the session (switchModel) BEFORE anything records the
  // served model, so the bookkeeping names the model the request will really
  // use. A failed apply is rolled back to the original model — recording the
  // redirect target would attribute the next failure to a model that never
  // served.
  const servedModel = output.message.model;
  if (servedModel) {
    const servedKey =
      `${servedModel.providerID}/${servedModel.modelID}` as ModelKey;
    if (applyRedirect && hookModel && servedKey !== hookModelKey) {
      try {
        await applyRedirect(hookModelKey as ModelKey, servedKey);
      } catch (err) {
        output.message.model = {
          providerID: hookModel.providerID,
          modelID: hookModel.modelID,
        };
        ctx.logger.warn("routing.redirect_apply_failed", {
          sessionId,
          from: hookModelKey,
          to: servedKey,
          err: errorSummary(err),
        });
      }
    }
    const finalModel = output.message.model;
    if (finalModel) {
      state.lastServedModel =
        `${finalModel.providerID}/${finalModel.modelID}` as ModelKey;
    }
  }

  // Arm the TTFT timer for this round. Cleared when the first token arrives
  // via the event hook (message.part.updated).
  ctx.ttft.arm(sessionId, ctx.config.ttftMs, () => {
    void handleTtftTimeout(ctx, client, sessionId, agentName);
  });
}

/**
 * TTFT replay entrance. The centralized exhaustion guard runs synchronously
 * before the first await: confirmed mid-task Claude exhaustion suppresses
 * the replay with zero SDK calls (AC4/AC5).
 */
// Hands a subagent session back to its parent by aborting it. Used when the
// child cannot be re-served in place (subagent skip, exhausted chain, or a
// suppressed replay whose current rung is dead): without the abort the child
// can sit in the host's retry loop with nothing left to serve, and the parent
// Task wait never regains control. Abort on an already-dead session errors
// and is logged, never thrown.
async function abortSubagentSession(
  ctx: PluginContext,
  client: OrchestratorClient,
  sessionId: string,
  eventPrefix: string,
): Promise<void> {
  try {
    await client.session.abort({ path: { id: sessionId } } as never);
  } catch (err) {
    ctx.logger.error(`${eventPrefix}.subagent_abort_failed`, {
      sessionId,
      err: errorSummary(err),
    });
  }
}

export async function handleTtftTimeout(
  ctx: PluginContext,
  client: OrchestratorClient,
  sessionId: string,
  agentName: string | null,
): Promise<void> {
  if (shouldSuppressReplay(sessionId, ctx)) return;
  const chain = agentName ? (ctx.chains.get(agentName) ?? []) : [];
  // Blocklist follows agent identity: unresolved identity leaves it inactive.
  const blocked = agentName ? ctx.blocked.get(agentName) : undefined;
  // Subagent-aware routing (Part 2): mirror the pattern at lines 463 and 499
  // in handleEvent's session.error/session.status paths. detectSubagent
  // already try/catch-defaults to false on session.get failure (EC5).
  const isSubagent = await detectSubagent(sessionId, client, ctx.store);
  const familyVeto = await buildFamilyVeto(ctx, client, sessionId, agentName);
  try {
    const result = await attemptFallback({
      sessionId,
      reason: "ttft_timeout",
      chain,
      client,
      store: ctx.store,
      config: ctx.config,
      logger: ctx.logger,
      isSubagent,
      blocked,
      unavailableVeto:
        claudeUnavailableVeto(readAvailabilitySnapshot()) ?? undefined,
      familyVeto,
      replayTail: ctx.replayTail,
    });
    if (isSubagent && result.success && result.subagentSkipped) {
      // Unlike session.error, a TTFT timeout has no provider error to
      // terminate the child. Abort only this stalled-child path so the parent
      // Task wait observes a terminal cancellation and regains control.
      await abortSubagentSession(ctx, client, sessionId, "ttft");
    }
  } catch (err) {
    ctx.logger.error("ttft.callback_failed", {
      sessionId,
      err: errorSummary(err),
    });
  }
}

export interface EventInputShape {
  type?: string;
  properties?: {
    sessionID?: string;
    sessionId?: string;
    // Real OpenCode session.error payload shape — see classifier.ts
    // SessionErrorLike for the nested {name, data:{...}} contract.
    error?: {
      name?: string;
      data?: SessionErrorData;
    };
    // session.status retry shape per packages/opencode/src/session/status.ts:8-30.
    // action.reason is the typed structural signal (P33: prefer over message text).
    status?: {
      type?: "idle" | "busy" | "retry";
      message?: string;
      action?: {
        reason?: string;
        provider?: string;
        title?: string;
        message?: string;
        label?: string;
        link?: string;
      };
    };
    part?: {
      type?: string;
      text?: string;
      sessionID?: string;
      sessionId?: string;
    };
    info?: {
      id?: string;
      sessionID?: string;
      sessionId?: string;
      role?: "user" | "assistant";
      // Assistant messages carry the model that produced them
      // (@opencode-ai/sdk AssistantMessage.modelID/providerID). Present on
      // message.updated; used to attribute the failure cooldown to the
      // message's own model.
      modelID?: string;
      providerID?: string;
      error?: SessionErrorLike;
    };
  };
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

// Structural action.reason → ErrorCategory mapping. Keys mirror the OpenCode
// RetryReason union (packages/opencode/src/session/retry.ts) — the
// `(string & {})` open-ended form means unknown reasons gracefully fall
// through to text-pattern classification. Co-locating the map here keeps
// the single source of truth next to the EventInputShape definition.
const REASON_TO_CATEGORY: Record<string, ErrorCategory> = {
  account_rate_limit: "rate_limit",
  free_tier_limit: "quota_exhausted",
};

function isActionShape(action: unknown): boolean {
  if (!isRecord(action)) return false;
  const a = action as Record<string, unknown>;
  return (
    isOptionalString(a.reason) &&
    isOptionalString(a.provider) &&
    isOptionalString(a.title) &&
    isOptionalString(a.message) &&
    isOptionalString(a.label) &&
    isOptionalString(a.link)
  );
}

function isEventInputShape(event: unknown): event is EventInputShape {
  if (!isRecord(event)) return false;
  if (!isOptionalString(event.type)) return false;
  if (event.properties === undefined) return true;
  if (!isRecord(event.properties)) return false;

  const props = event.properties;
  if (!isOptionalString(props.sessionID) || !isOptionalString(props.sessionId))
    return false;
  if (props.error !== undefined) {
    if (!isRecord(props.error)) return false;
    const error = props.error;
    if (!isOptionalString(error.name)) return false;
    if (error.data !== undefined && !isRecord(error.data)) return false;
  }
  if (props.status !== undefined) {
    if (!isRecord(props.status)) return false;
    if (!isOptionalString(props.status.type)) return false;
    if (!isOptionalString(props.status.message)) return false;
    if (
      props.status.action !== undefined &&
      !isActionShape(props.status.action)
    )
      return false;
  }
  if (props.part !== undefined) {
    if (!isRecord(props.part)) return false;
    if (
      !isOptionalString(props.part.type) ||
      !isOptionalString(props.part.text)
    )
      return false;
    if (
      !isOptionalString(props.part.sessionID) ||
      !isOptionalString(props.part.sessionId)
    )
      return false;
  }
  if (props.info !== undefined) {
    if (!isRecord(props.info)) return false;
    const info = props.info;
    if (!isOptionalString(info.id)) return false;
    if (!isOptionalString(info.sessionID) || !isOptionalString(info.sessionId))
      return false;
    if (
      info.role !== undefined &&
      info.role !== "user" &&
      info.role !== "assistant"
    )
      return false;
    if (info.error !== undefined) {
      if (!isRecord(info.error)) return false;
      if (!isOptionalString(info.error.name)) return false;
      if (info.error.data !== undefined && !isRecord(info.error.data))
        return false;
    }
    if (!isOptionalString(info.modelID) || !isOptionalString(info.providerID))
      return false;
  }
  return true;
}

export function normalizeEventInput(
  input: unknown,
): EventInputShape | undefined {
  // OpenCode's event hook passes `{ event }`; undefined registration probes
  // are treated as no-op compatibility inputs.
  if (!isRecord(input)) return undefined;
  return isEventInputShape(input.event) ? input.event : undefined;
}

function hasStreamingTextContent(part: {
  type?: string;
  text?: string;
}): boolean {
  return (
    part.type === "text" &&
    typeof part.text === "string" &&
    part.text.length > 0
  );
}

type TypedFailureSource =
  | "session_error"
  | "message_updated"
  | "session_status"
  // OpenCode 2 retry-hook entrance — the single classified failure path
  // under the V2 runtime (session.error / session.status events are not
  // fed into the pipeline there, so dedup never sees two V2 copies).
  | "v2_retry";

function bounded(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/**
 * Stable failure fingerprint across error representations.
 *
 * One provider failure reaches the plugin twice: as the transient
 * session.error payload and again on the persisted message.updated copy.
 * The two copies can disagree on isRetryable (true while the provider still
 * reports the failure retryable, false once the turn terminates) and on
 * whether responseBody survived serialization, so only the identity-bearing
 * fields both copies carry take part: the error name (case-folded and
 * trimmed — NamedError spelling has drifted across OpenCode versions), the
 * status code, and the bounded message text. Both representations of one
 * failure therefore dedup to a single dispatch regardless of which copy
 * arrives first.
 */
export function failureFingerprint(error: SessionErrorLike): string {
  const data = error.data ?? {};
  return JSON.stringify({
    name: (error.name ?? "").trim().toLowerCase() || null,
    statusCode: typeof data.statusCode === "number" ? data.statusCode : null,
    message: bounded(data.message, 256)?.trim() ?? null,
  });
}

interface TypedFailureInput {
  source: TypedFailureSource;
  sessionId: string;
  messageId?: string;
  category: ErrorCategory;
  fingerprint: string;
  // Model identity carried by the signal itself (message.updated info
  // providerID/modelID). attemptFallback attributes the cooldown to it
  // instead of state.currentModel — see AttemptFallbackArgs.failedModel.
  failedModel?: ModelKey;
}

// Suppressed-entrance recovery: the guard fired because the session's
// current rung is Anthropic and the availability snapshot says that provider
// is dead. Returning here (the pre-fix behavior) pinned the session to the
// dead rung forever — every later failure signal was suppressed before
// attemptFallback could advance the chain, and subagents were never handed
// back to their parents. Instead: advance the bookkeeping past the dead
// rung (a pure state move — no replay, no SDK prompt path) and abort the
// session when it is a subagent so the parent Task wait regains control.
async function advancePastUnavailableRung(
  ctx: PluginContext,
  client: OrchestratorClient,
  sessionId: string,
): Promise<void> {
  const state = ctx.store.sessions.get(sessionId);
  const agentName = state.agentName ?? null;
  const chain = agentName ? (ctx.chains.get(agentName) ?? []) : [];
  const blocked = agentName ? ctx.blocked.get(agentName) : undefined;
  const familyVeto = await buildFamilyVeto(ctx, client, sessionId, agentName);
  const next = resolveFallbackModel(
    state.currentModel,
    chain,
    state.fallbackDepth,
    ctx.store.health,
    ctx.config.maxDepth,
    blocked,
    claudeUnavailableVeto(readAvailabilitySnapshot()) ?? undefined,
    familyVeto,
  );
  if (next) {
    if (!state.originalModel && state.currentModel) {
      state.originalModel = state.currentModel;
    }
    const from = state.currentModel;
    state.currentModel = next;
    state.fallbackDepth += 1;
    state.lastFallbackAt = Date.now();
    ctx.logger.info("availability.advanced_past_unavailable", {
      sessionId,
      from,
      to: next,
      agent: agentName,
    });
  }
  const isSubagent = await detectSubagent(sessionId, client, ctx.store);
  if (isSubagent) {
    await abortSubagentSession(ctx, client, sessionId, "failure");
  }
}

async function handleFailureSignal(
  ctx: PluginContext,
  client: OrchestratorClient,
  input: TypedFailureInput,
): Promise<ReplayResult | undefined> {
  if (shouldSuppressReplay(input.sessionId, ctx)) {
    await advancePastUnavailableRung(ctx, client, input.sessionId);
    return undefined;
  }

  // Family correlation intentionally uses session+category rather than the
  // mutable currentModel. attemptFallback advances currentModel before the
  // terminal error/message update can arrive; including it would defeat the
  // retry-status → terminal-error correlation validated in design review.
  const familyKey = `${input.sessionId}\u0000${input.category}`;
  const identity = {
    sessionId: input.sessionId,
    messageId: input.messageId,
    fingerprint: input.fingerprint,
    familyKey,
  };
  let duplicate = false;
  try {
    duplicate = ctx.store.failures.begin(identity) === "duplicate";
  } catch (err) {
    ctx.logger.warn("failure.dedup_failed", {
      sessionId: input.sessionId,
      source: input.source,
      err: errorSummary(err),
    });
  }

  if (ctx.ttft.has(input.sessionId)) ctx.ttft.clear(input.sessionId);
  ctx.logger.debug("failure.signal", {
    sessionId: input.sessionId,
    messageId: input.messageId,
    source: input.source,
    category: input.category,
    duplicate,
  });
  if (duplicate) return undefined;

  const agentName = await resolveAgentName(input.sessionId, client, ctx.store);
  const chain = agentName ? (ctx.chains.get(agentName) ?? []) : [];
  // Blocklist follows agent identity: unresolved identity leaves it inactive.
  const blocked = agentName ? ctx.blocked.get(agentName) : undefined;
  const isSubagent = await detectSubagent(input.sessionId, client, ctx.store);
  const familyVeto = await buildFamilyVeto(
    ctx,
    client,
    input.sessionId,
    agentName,
  );
  const result = await attemptFallback({
    sessionId: input.sessionId,
    reason: input.category,
    chain,
    client,
    store: ctx.store,
    config: ctx.config,
    logger: ctx.logger,
    isSubagent,
    failedModel: input.failedModel,
    blocked,
    unavailableVeto:
      claudeUnavailableVeto(readAvailabilitySnapshot()) ?? undefined,
    familyVeto,
    replayTail: ctx.replayTail,
    // Classified-failure dispatch is the only entrance that carries the
    // provider-reported boundary consumer: once per dedup-collapsed
    // quota_exhausted / rate_limit failure, never on a routing decision.
    quotaBoundary: ctx.quotaBoundary,
  });
  // Subagent terminal handoff: the skip advanced the chain bookkeeping and
  // cooled the failed model, but the child itself still sits in the host's
  // retry loop with nothing serving it. Abort hands the parent Task wait a
  // terminal cancellation immediately; the parent's replacement spawn starts
  // on the redirected (healthy) rung via preemptive skip. The same applies
  // when the chain is exhausted — nowhere left to roll means the child must
  // fail fast rather than hang.
  if (isSubagent && (result.subagentSkipped || result.error === "exhausted")) {
    await abortSubagentSession(ctx, client, input.sessionId, "failure");
  }
  // OpenCode may deliver an event before the Hooks.config callback has
  // populated chains. Preserve the existing lifecycle behavior: the same
  // signal may retry after config becomes available. Other failures remain
  // deduped to prevent repeated recovery churn.
  if (!result.success && result.error === "no chain") {
    ctx.store.failures.forget(identity);
  }
  return result;
}

export function sanitizeChatParamsOutput(output: unknown): void {
  if (!isRecord(output) || !isRecord(output.options)) return;
  delete output.options.fallback_models;
}

export async function handleEvent(
  ctx: PluginContext,
  client: OrchestratorClient,
  event: EventInputShape | undefined,
): Promise<void> {
  // Defensive: OpenCode may invoke event with undefined during registration.
  if (!event) return;
  const props = event.properties ?? {};

  switch (event.type) {
    case "session.error": {
      const sessionId = props.sessionID ?? props.sessionId ?? "";
      if (!sessionId) return;
      if (!props.error) return;
      const category = classifySessionError(props.error);
      if (!category) return;
      await handleFailureSignal(ctx, client, {
        source: "session_error",
        sessionId,
        category,
        fingerprint: failureFingerprint(props.error),
      });
      return;
    }
    case "session.status": {
      const sessionId = props.sessionID ?? props.sessionId ?? "";
      if (!sessionId) return;
      // Structural first (P33): typed action.reason on retry status events is
      // an Effect Schema field; prefer it over lossy text-pattern matching.
      // Map definition lives at REASON_TO_CATEGORY near the top of this file.
      const status = props.status;
      let category: ReturnType<typeof classifyRetryStatusText> = null;
      const reason = status?.action?.reason;
      if (status?.type === "retry" && reason) {
        // Open-ended (string & {}) future reasons fall through to text scan.
        category = REASON_TO_CATEGORY[reason] ?? null;
      }
      if (!category) {
        category = classifyRetryStatusText(status?.message);
      }
      if (!category) return;
      await handleFailureSignal(ctx, client, {
        source: "session_status",
        sessionId,
        category,
        fingerprint: JSON.stringify({
          reason: status?.action?.reason ?? null,
          provider: status?.action?.provider ?? null,
          message: bounded(status?.message, 256),
        }),
      });
      return;
    }
    case "message.updated": {
      const info = props.info;
      if (!info || info.role !== "assistant" || !info.error) return;
      const sessionId =
        props.sessionID ??
        props.sessionId ??
        info.sessionID ??
        info.sessionId ??
        "";
      if (!sessionId) return;
      const category = classifySessionError(info.error);
      if (!category) return;
      // The persisted assistant message names the model that actually
      // served the failing request. Attribute the failure to it so the
      // cooldown lands on the failing model even when session state has
      // already advanced past it (subagent short-circuit advance).
      const failedModel =
        typeof info.providerID === "string" &&
        info.providerID.length > 0 &&
        typeof info.modelID === "string" &&
        info.modelID.length > 0
          ? (`${info.providerID}/${info.modelID}` as ModelKey)
          : undefined;
      await handleFailureSignal(ctx, client, {
        source: "message_updated",
        sessionId,
        messageId: info.id,
        category,
        fingerprint: failureFingerprint(info.error),
        failedModel,
      });
      return;
    }
    case "message.part.updated": {
      // First streamed text content for this session → clear TTFT timer. Do
      // not clear on metadata/tool/status parts that have a non-empty type but
      // no generated text.
      const part = props.part;
      if (!part) return;
      if (!hasStreamingTextContent(part)) return;
      const sessionId =
        part.sessionID ??
        part.sessionId ??
        props.sessionID ??
        props.sessionId ??
        "";
      if (!sessionId) return;
      if (ctx.ttft.has(sessionId)) {
        ctx.ttft.clear(sessionId);
        ctx.logger.debug("ttft.cleared_on_token", { sessionId });
      }
      return;
    }
    case "session.idle":
      // Idle is informational; nothing to mutate. Recovery detection lives
      // here in production but is out of scope for v1 tests.
      return;
    case "session.deleted": {
      const sessionId = props.sessionID ?? props.sessionId ?? "";
      if (sessionId) ctx.store.failures.clearSession(sessionId);
      return;
    }
    default:
      return;
  }
}

// Production quota-boundary consumer, named as an export so the wiring is
// assertable: createPluginHooks installs it unless a deps override supplies
// a resolver (test seam).
export const PRODUCTION_QUOTA_BOUNDARY: QuotaBoundaryResolver =
  resolveProviderReportedBoundary;

export interface PluginHookDeps {
  // Test seam for the quota-boundary consumer. Production omits it and
  // gets PRODUCTION_QUOTA_BOUNDARY.
  quotaBoundary?: QuotaBoundaryResolver;
}

/**
 * applyLoadedChains installs one loadFallbackChains result into the context
 * maps. Mutation is in-place (clear + set) to preserve Map identity for
 * handler closures that hold ctx by reference. Shared by the V1 config hook
 * and the V2 setup so both runtimes keep one reload lifecycle: a re-delivery
 * cannot leave a stale blocklist behind for an agent whose entry disappeared.
 */
export function applyLoadedChains(
  ctx: PluginContext,
  loaded: ReturnType<typeof loadFallbackChains>,
): void {
  ctx.chains.clear();
  for (const [name, chain] of loaded.chains) ctx.chains.set(name, chain);
  ctx.blocked.clear();
  for (const [name, set] of loaded.blocked) ctx.blocked.set(name, set);
  ctx.families.clear();
  for (const [key, family] of loaded.families) ctx.families.set(key, family);
  ctx.familyDisjoint.clear();
  for (const name of loaded.familyDisjoint) ctx.familyDisjoint.add(name);
  for (const w of loaded.warnings)
    ctx.logger.warn("loader.warning", { message: w });
  ctx.logger.info("config.loaded", { agentCount: ctx.chains.size });
}

/**
 * createPluginHooks wires the closure-held context into the OpenCode hook
 * signatures. The runtime entry point wraps this in a V1 PluginModule object,
 * while hook payloads remain `unknown` and are narrowed inside handlers because
 * plugin types are not stable across versions per agreement.
 *
 * Tuple-option hot-reload caveat: `pluginOptions` is captured ONCE at plugin
 * initialization. The config-hook reload path fires on OpenCode Config changes
 * but is not guaranteed to re-invoke `pluginModule.server(input, pluginOptions)`
 * with new tuple options; users observing cooldown changes not taking effect
 * should restart OpenCode.
 */
export async function createPluginHooks(
  opts: PluginInput,
  pluginOptions?: unknown,
  deps: PluginHookDeps = {},
): Promise<PluginHooks> {
  const logger = createLogger();
  const cooldownOverrides = extractCooldownOverrides(pluginOptions, logger);
  const ctx = createPluginContext({
    pluginOptions,
    cooldownOverrides,
    logger,
    quotaBoundary: deps.quotaBoundary ?? PRODUCTION_QUOTA_BOUNDARY,
  });

  return {
    "chat.message": async (input: unknown, output: unknown) => {
      const chatInput = normalizeChatMessageInput(input);
      const chatOutput = isChatMessageOutputShape(output) ? output : undefined;
      await handleChatMessage(ctx, opts.client, chatInput, chatOutput);
    },
    event: async (input: unknown) => {
      await handleEvent(ctx, opts.client, normalizeEventInput(input));
    },
    "chat.params": async (_input: unknown, output: unknown) => {
      sanitizeChatParamsOutput(output);
    },
    // OpenCode calls this hook after plugin init and BEFORE bus.subscribeAll(),
    // so chains are guaranteed populated before any session.status event fires.
    // Ordering proof: packages/opencode/src/plugin/index.ts:217-237 @ 7fe7b9f
    //   for (const hook of hooks) yield* (hook.config?.(cfg))  // awaited
    //   yield* (yield* bus.subscribeAll()).pipe(...)            // then subscribe
    // If OpenCode ever reorders this, the ordering-violation regression test
    // in plugin.test.ts ("event before config") will catch it: chains stay
    // empty, attemptFallback short-circuits with "no chain", no crash.
    // Mutation is in-place (clear + set) to preserve Map identity for handler
    // closures that hold ctx by reference. The blocked map follows the same
    // lifecycle so a re-delivery cannot leave a stale blocklist behind for an
    // agent whose tuple entry disappeared.
    config: async (input: unknown) => {
      applyLoadedChains(
        ctx,
        loadFallbackChains(input, ctx.logger, ctx.pluginOptions),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// OpenCode 2 (V2) integration
//
// OpenCode 2 decodes a package plugin's default export as { id, setup } (or
// { id, effect }) and ignores V1-only members such as server(); V1 loaders
// call server() and ignore setup(). The shared routing policy — chains,
// cooldowns, dedup, family vetoes, replay orchestration — is unchanged; only
// the integration boundary differs:
//
//   - Chains load once from ctx.options (the native `plugins` object
//     options). There is no config hook under V2, so the legacy
//     agent.<name>.options.fallback_models migration scan has nothing to
//     read; the native options path is the only V2 source.
//   - ctx.session.hook("context") replaces chat.message: same bookkeeping
//     (turn-guard clear, TTFT arm, preemptive skip) over a synthesized V1
//     output envelope. A preemptive redirect cannot mutate the readonly
//     context-hook model, so the adapter applies it with switchModel().
//   - ctx.session.hook("retry") is the single classified failure entrance,
//     replacing the session.error / session.status / message.updated event
//     paths. One failure passes through the shared dedup and chain selection.
//     After an advance, OMR approves the host retry on the switched model;
//     subagent handoff vetoes that retry.
//   - ctx.event.subscribe maps session.text.delta to TTFT clear and handles
//     session.deleted cleanup. Feeding session.error /
//     session.status in as well would create a second fingerprint for the
//     same failure and bypass dedup.
//   - A classified failure switches the model and lets the host retry without
//     interrupting. A TTFT timeout switches the model and interrupts the
//     stalled request, ending that turn. V2 has no revert; re-prompting would
//     duplicate the user turn.
// ---------------------------------------------------------------------------

/** Stable plugin id shared by the V1 module and the V2 definition. */
export const PLUGIN_ID = "@sharper-flow/opencode-model-routing-plugin";

/**
 * The V2 half of the dual default export. Kept structural (no
 * `@opencode/plugin` import): the V1 loader must be able to load this same
 * entry without the V2 SDK present, and the V2 loader decodes the default
 * export structurally as { id, setup }.
 */
export interface V2PluginDefinition {
  id: string;
  setup: (ctx: unknown) => Promise<void | (() => void)>;
}

/**
 * Narrow structural surface of the V2 plugin ctx.session domain. Input shapes
 * mirror the installed @opencode/plugin contract (SessionDomain =
 * Pick<SessionApi, ...> + hook): sessionID-first flat parameters and
 * interrupt({ sessionID, resume }). A TTFT interrupt aborts the stalled
 * request; resume:true does not re-drive that turn in OpenCode 2.0.14.
 */
export interface V2SessionDomain {
  get(input: Record<string, unknown>): Promise<unknown>;
  context(input: Record<string, unknown>): Promise<unknown>;
  switchModel(input: Record<string, unknown>): Promise<unknown>;
  interrupt(input: Record<string, unknown>): Promise<unknown>;
  prompt(input: Record<string, unknown>): Promise<unknown>;
  hook(
    name: string,
    callback: (event: unknown) => unknown,
    options?: unknown,
  ): Promise<unknown>;
}

/** Narrow structural surface of the V2 plugin ctx the setup requires. */
export interface V2PluginHost {
  options?: unknown;
  session: V2SessionDomain;
  event?: {
    subscribe(options?: Record<string, unknown>): AsyncIterable<unknown>;
  };
}

export function isV2PluginHost(host: unknown): host is V2PluginHost {
  if (!isRecord(host)) return false;
  const session = host.session;
  if (!isRecord(session)) return false;
  return ["get", "context", "switchModel", "interrupt", "prompt", "hook"].every(
    (key) => hasFunction(session, key),
  );
}

// v2SessionId reads the V1-envelope { path: { id } } shape the shared
// orchestrator code uses, so every adapter method extracts its target the
// same way.
function v2SessionId(args: unknown): string {
  if (
    isRecord(args) &&
    isRecord(args.path) &&
    typeof args.path.id === "string"
  ) {
    return args.path.id;
  }
  return "";
}

/**
 * createV2OrchestratorClient adapts the V2 session domain onto the shared
 * OrchestratorClient envelope. The V2 ctx methods take flat parameters and
 * return bare domain objects, so reads are wrapped in the `{ data }`
 * envelope unwrapSdkData expects.
 *
 * revert() throws deliberately: the V2 replay tail owns recovery and never
 * reverts (no V2 API), and the default V1 tail must not run against this
 * adapter — a silent no-op would hide a wiring bug behind a duplicated user
 * turn.
 */
export function createV2OrchestratorClient(
  session: V2SessionDomain,
): OrchestratorClient {
  return {
    session: {
      messages: async (args) => ({
        data: await session.context({ sessionID: v2SessionId(args) }),
      }),
      abort: async (args) =>
        session.interrupt({ sessionID: v2SessionId(args), resume: false }),
      revert: async () => {
        throw new Error(
          "omr: session.revert is not part of the OpenCode 2 runtime; the V2 replay tail owns recovery",
        );
      },
      prompt: async (args) => {
        // Defensive total mapping. The V2 tail never prompts (no revert →
        // a re-prompt would duplicate the user turn), but the shared client
        // surface must stay total for the subagent and abort paths above.
        const body = isRecord(args) && isRecord(args.body) ? args.body : {};
        const parts = Array.isArray(body.parts) ? body.parts : [];
        const text = parts
          .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
          .filter((t) => t.length > 0)
          .join("\n");
        const sessionID = v2SessionId(args);
        return typeof body.agent === "string" && body.agent.length > 0
          ? session.prompt({ sessionID, text, agent: body.agent })
          : session.prompt({ sessionID, text });
      },
      get: async (args) => ({
        data: await session.get({ sessionID: v2SessionId(args) }),
      }),
    },
  };
}

/**
 * createV2ReplayTail builds the V2 replay tail: move the session onto `next`
 * with switchModel. Under V2 the replay itself is the HOST retry — the retry
 * hook approves one rescheduled attempt (decision {retry:true}), and the
 * host re-drives the agent loop on the session's switched model. Verified
 * against opencode v2.0.14: interrupt({resume:true}) does not re-drive a
 * settled turn, so a classified-failure tail never interrupts.
 *
 * A TTFT timeout is the opposite situation: the failed request is still IN
 * FLIGHT, the retry hook never fires for it, and a bare switchModel would
 * leave the session waiting on the stalled request forever while the
 * fallback bookkeeping claims success (verified live against v2.0.14). For
 * that entrance the tail additionally interrupts with resume:true, aborting
 * the stalled request. Verified live against v2.0.14: that abort ENDS the
 * hung turn — it does not re-drive it in-run, and no supported continuation
 * surface re-drives a stalled turn without duplicating the user message
 * (contract research, TTFT continuation-route investigation). The session
 * stays anchored on the switched model, so the next turn serves the healthy
 * rung. A rejection from either call propagates: attemptFallback records
 * fallback.replay_failed and leaves the bookkeeping unadvanced — a TTFT
 * recovery that did not happen is never reported as success.
 */
export function createV2ReplayTail(session: V2SessionDomain): ReplayTail {
  return async ({ sessionId, next, reason }) => {
    const { providerID, modelID } = parseModelKey(next);
    await session.switchModel({
      sessionID: sessionId,
      model: { providerID, id: modelID },
    });
    if (reason === "ttft_timeout") {
      await session.interrupt({ sessionID: sessionId, resume: true });
    }
  };
}

interface V2ContextEventShape {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

/**
 * narrowV2ContextEvent narrows the V2 "context" hook event. The event model
 * is `{ providerID, id, variant? }` under V2; `modelID` is accepted as a
 * defensive alias. Undefined when the event carries no usable session or
 * model identity — the handler then leaves routing untouched.
 */
export function narrowV2ContextEvent(
  raw: unknown,
): V2ContextEventShape | undefined {
  if (!isRecord(raw)) return undefined;
  const sessionID =
    typeof raw.sessionID === "string" && raw.sessionID.length > 0
      ? raw.sessionID
      : undefined;
  if (!sessionID) return undefined;
  const agent =
    typeof raw.agent === "string" && raw.agent.trim().length > 0
      ? raw.agent
      : undefined;
  const modelRaw = isRecord(raw.model) ? raw.model : undefined;
  const providerID =
    typeof modelRaw?.providerID === "string" && modelRaw.providerID.length > 0
      ? modelRaw.providerID
      : undefined;
  const modelID =
    typeof modelRaw?.id === "string" && modelRaw.id.length > 0
      ? modelRaw.id
      : typeof modelRaw?.modelID === "string" && modelRaw.modelID.length > 0
        ? modelRaw.modelID
        : undefined;
  const model = providerID && modelID ? { providerID, modelID } : undefined;
  return { sessionID, agent, model };
}

/**
 * handleV2Context adapts the V2 "context" hook (fires immediately before
 * each agent-loop model request) onto the shared chat.message pipeline:
 * turn-guard clear, TTFT arm, availability preflight, preemptive skip, and
 * served-model capture all run through handleChatMessage over a synthesized
 * V1 output envelope. The context hook's model is readonly, so a preemptive
 * redirect is applied with switchModel() through the applyRedirect callback —
 * which handleChatMessage invokes BEFORE it records the served model or arms
 * TTFT, and rolls back if the switch fails, so bookkeeping can never name a
 * model the request will not use.
 */
export async function handleV2Context(
  ctx: PluginContext,
  client: OrchestratorClient,
  session: V2SessionDomain,
  raw: unknown,
): Promise<void> {
  const event = narrowV2ContextEvent(raw);
  if (!event) return;
  const output = {
    message: {
      model: event.model
        ? { providerID: event.model.providerID, modelID: event.model.modelID }
        : undefined,
    },
  };
  await handleChatMessage(
    ctx,
    client,
    { sessionID: event.sessionID, agent: event.agent },
    output,
    async (_from, to) => {
      const { providerID, modelID } = parseModelKey(to);
      await session.switchModel({
        sessionID: event.sessionID,
        model: { providerID, id: modelID },
      });
    },
  );
}

/**
 * classifyV2RetryError maps the V2 retry hook's typed error onto the shared
 * session.error classifier by reshaping { type, status, message } into the
 * { name, data: { statusCode, message } } NamedError envelope. One
 * classification policy serves both runtimes; returning null leaves the
 * host's retry decision untouched.
 */
export function classifyV2RetryError(error: unknown): ErrorCategory | null {
  if (!isRecord(error)) return null;
  const name = typeof error.type === "string" ? error.type : undefined;
  const status = typeof error.status === "number" ? error.status : undefined;
  if (name === undefined && status === undefined) return null;
  return classifySessionError({
    name,
    data: {
      statusCode: status,
      message: typeof error.message === "string" ? error.message : undefined,
    },
  });
}

/**
 * handleV2RetrySignal is the V2 failure entrance. Sequence: classify the
 * typed error; run the shared handleFailureSignal (cooldowns, dedup,
 * subagent short-circuit, and the switchModel replay tail); then decide the
 * host retry from the outcome:
 *
 *   - chain advanced (success, not a subagent): approve exactly one host
 *     retry at a short delay — the host re-drives the agent loop on the
 *     session's switched model, which IS the V2 replay. Verified against
 *     opencode v2.0.14: a veto leaves nobody retrying, and
 *     interrupt({resume:true}) does not re-drive a settled turn.
 *   - subagent short-circuit: the child was aborted so its parent can
 *     respawn it — veto the host retry.
 *   - anything else (exhausted, suppressed, duplicate, no chain): leave the
 *     host's own retry decision untouched.
 */
export async function handleV2RetrySignal(
  ctx: PluginContext,
  client: OrchestratorClient,
  raw: unknown,
): Promise<void> {
  if (!isRecord(raw)) return;
  const sessionId =
    typeof raw.sessionID === "string" && raw.sessionID.length > 0
      ? raw.sessionID
      : undefined;
  if (!sessionId) return;
  const errorRaw = isRecord(raw.error) ? raw.error : undefined;
  const category = classifyV2RetryError(errorRaw);
  if (!category) return;

  const agent =
    typeof raw.agent === "string" && raw.agent.trim().length > 0
      ? raw.agent
      : undefined;
  let ownsRecovery = false;
  if (agent) {
    ctx.store.sessions.get(sessionId).agentName = agent;
    const chain = ctx.chains.get(agent) ?? [];
    if (chain.length > 0 && !shouldSuppressReplay(sessionId, ctx)) {
      ownsRecovery = true;
    }
  }

  // The retry event names the model that failed — attribute the cooldown to
  // it directly instead of falling back to session state. The attempt
  // number joins the fingerprint so consecutive host retries of the same
  // category classify as distinct failures and each can advance the chain.
  const modelRaw = isRecord(raw.model) ? raw.model : undefined;
  const failedModel =
    typeof modelRaw?.providerID === "string" &&
    modelRaw.providerID.length > 0 &&
    typeof modelRaw?.id === "string" &&
    modelRaw.id.length > 0
      ? (`${modelRaw.providerID}/${modelRaw.id}` as ModelKey)
      : undefined;

  const fingerprint = JSON.stringify({
    type: typeof errorRaw?.type === "string" ? errorRaw.type : null,
    status: typeof errorRaw?.status === "number" ? errorRaw.status : null,
    message: bounded(errorRaw?.message, 256),
    attempt: typeof raw.attempt === "number" ? raw.attempt : null,
  });
  ctx.logger.debug("v2.retry_event", { sessionId, fingerprint });
  const result = await handleFailureSignal(ctx, client, {
    source: "v2_retry",
    sessionId,
    category,
    fingerprint,
    failedModel,
  });

  if (!ownsRecovery) return;
  if (result?.success && !result.subagentSkipped) {
    (raw as { decision?: unknown }).decision = { retry: true, delay: 250 };
  } else if (result?.subagentSkipped) {
    (raw as { decision?: unknown }).decision = { retry: false };
  }
}

/**
 * normalizeV2Event narrows one event-stream record onto the internal V1
 * event shape. Three encodings are accepted:
 *
 *   1. the V1 envelope ({type, properties}) — pass-through;
 *   2. the live V2 flat envelope ({type, data}) — verified against
 *      opencode v2.0.14, where streaming text is session.text.delta
 *      (data: {sessionID, delta, ...}); V1 names like message.part.updated
 *      do not exist on the V2 stream. Only the events OMR consumes are
 *      mapped: session.text.delta → TTFT clear, session.deleted → cleanup;
 *   3. a flat V1-style encoding ({type, part}) as a defensive fallback.
 *
 * Anything else is dropped — the V2 event stream carries no failure signals
 * (the retry hook owns those).
 */
export function normalizeV2Event(raw: unknown): EventInputShape | undefined {
  if (!isRecord(raw)) return undefined;
  if (isRecord(raw.properties) && isEventInputShape(raw)) {
    return raw as EventInputShape;
  }
  if (typeof raw.type === "string" && isRecord(raw.data)) {
    const data = raw.data;
    if (
      raw.type === "session.text.delta" &&
      typeof data.sessionID === "string" &&
      data.sessionID.length > 0 &&
      typeof data.delta === "string" &&
      data.delta.length > 0
    ) {
      return {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            text: data.delta,
            sessionID: data.sessionID,
          },
        },
      };
    }
    if (
      raw.type === "session.deleted" &&
      typeof data.sessionID === "string" &&
      data.sessionID.length > 0
    ) {
      return {
        type: "session.deleted",
        properties: { sessionID: data.sessionID },
      };
    }
    return undefined;
  }
  const { type, ...properties } = raw;
  const shaped = { type, properties } as unknown;
  return isEventInputShape(shaped) ? (shaped as EventInputShape) : undefined;
}

async function consumeV2Events(
  ctx: PluginContext,
  client: OrchestratorClient,
  host: V2PluginHost,
  signal: AbortSignal,
): Promise<void> {
  const stream = host.event?.subscribe({ signal });
  if (
    !stream ||
    typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
      "function"
  ) {
    return;
  }
  try {
    for await (const raw of stream as AsyncIterable<unknown>) {
      const event = normalizeV2Event(raw);
      if (!event) continue;
      // TTFT clear + session cleanup only. session.error / session.status
      // are deliberately not fed into the failure pipeline: the retry hook
      // is the single V2 classified entrance, and a second entrance would
      // bypass failure dedup and duplicate replay.
      if (
        event.type === "message.part.updated" ||
        event.type === "session.deleted"
      ) {
        await handleEvent(ctx, client, event);
      }
    }
  } catch {
    // Stream ended (host shutdown or cleanup abort). The controller abort in
    // the setup cleanup handles resource teardown; nothing to recover.
  }
}

/**
 * setupV2Plugin is the OpenCode 2 setup() implementation: build the shared
 * context from ctx.options, load chains, register the context and retry
 * hooks, subscribe the event stream, and return the cleanup that aborts it.
 */
export async function setupV2Plugin(
  host: unknown,
  deps: PluginHookDeps = {},
): Promise<(() => void) | undefined> {
  if (!isV2PluginHost(host)) {
    throw new Error(
      "opencode-model-routing plugin: invalid OpenCode 2 plugin context",
    );
  }
  const logger = createLogger();
  const cooldownOverrides = extractCooldownOverrides(host.options, logger);
  const ctx = createPluginContext({
    pluginOptions: host.options,
    cooldownOverrides,
    logger,
    quotaBoundary: deps.quotaBoundary ?? PRODUCTION_QUOTA_BOUNDARY,
  });
  applyLoadedChains(ctx, loadFallbackChains(undefined, logger, host.options));
  const client = createV2OrchestratorClient(host.session);
  ctx.replayTail = createV2ReplayTail(host.session);

  await host.session.hook("context", (event: unknown) =>
    handleV2Context(ctx, client, host.session, event),
  );
  await host.session.hook("retry", (event: unknown) =>
    handleV2RetrySignal(ctx, client, event),
  );

  const controller = new AbortController();
  void consumeV2Events(ctx, client, host, controller.signal);
  return () => controller.abort();
}

/**
 * createV2PluginDefinition builds the V2 half of the dual default export.
 * deps mirrors PluginHookDeps (test seam for the quota-boundary consumer).
 */
export function createV2PluginDefinition(
  deps: PluginHookDeps = {},
): V2PluginDefinition {
  return {
    id: PLUGIN_ID,
    setup: (host: unknown) => setupV2Plugin(host, deps),
  };
}
