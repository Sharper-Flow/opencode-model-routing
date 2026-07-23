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
import { applyAvailabilityPreflight } from "./availability/preflight.ts";
import { readAvailabilitySnapshot } from "./availability/snapshot.ts";
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
} from "./replay/orchestrator.ts";
import { resolveAgentName } from "./resolution/agent-resolver.ts";
import { CooldownStore, getCooldownPath } from "./state/cooldown-store.ts";
import { FallbackStore } from "./state/store.ts";
import { TtftRegistry } from "./ttft.ts";
import {
  defaultConfig,
  type ErrorCategory,
  type ModelKey,
  type PluginConfig,
} from "./types.ts";
import { isRecord, unwrapSdkData } from "./utils/type-guards.ts";

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
  config: PluginConfig;
  logger: Logger;
  pluginOptions?: unknown;
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
    config: merged,
    logger,
    pluginOptions: opts.pluginOptions,
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
    state.isSubagent = typeof parentID === "string" && parentID.length > 0;
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

export async function handleChatMessage(
  ctx: PluginContext,
  client: OrchestratorClient,
  input: ChatMessageInputShape | undefined,
  output: ChatMessageOutputShape | undefined,
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
  );

  applyPreemptiveSkip(
    { sessionId, agentName, output },
    ctx.store,
    ctx.chains,
    ctx.config,
    ctx.logger,
  );

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
export async function handleTtftTimeout(
  ctx: PluginContext,
  client: OrchestratorClient,
  sessionId: string,
  agentName: string | null,
): Promise<void> {
  if (shouldSuppressReplay(sessionId, ctx)) return;
  const chain = agentName ? (ctx.chains.get(agentName) ?? []) : [];
  // Subagent-aware routing (Part 2): mirror the pattern at lines 463 and 499
  // in handleEvent's session.error/session.status paths. detectSubagent
  // already try/catch-defaults to false on session.get failure (EC5).
  const isSubagent = await detectSubagent(sessionId, client, ctx.store);
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
    });
    if (isSubagent && result.success && result.subagentSkipped) {
      // Unlike session.error, a TTFT timeout has no provider error to
      // terminate the child. Abort only this stalled-child path so the parent
      // Task wait observes a terminal cancellation and regains control.
      try {
        await client.session.abort({ path: { id: sessionId } } as never);
      } catch (err) {
        ctx.logger.error("ttft.subagent_abort_failed", {
          sessionId,
          err: errorSummary(err),
        });
      }
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
  "session_error" | "message_updated" | "session_status";

function bounded(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export function failureFingerprint(error: SessionErrorLike): string {
  const data = error.data ?? {};
  return JSON.stringify({
    name: error.name ?? null,
    statusCode: typeof data.statusCode === "number" ? data.statusCode : null,
    isRetryable:
      typeof data.isRetryable === "boolean" ? data.isRetryable : null,
    message: bounded(data.message, 256),
    responseBody: bounded(data.responseBody, 512),
  });
}

interface TypedFailureInput {
  source: TypedFailureSource;
  sessionId: string;
  messageId?: string;
  category: ErrorCategory;
  fingerprint: string;
}

async function handleFailureSignal(
  ctx: PluginContext,
  client: OrchestratorClient,
  input: TypedFailureInput,
): Promise<void> {
  if (shouldSuppressReplay(input.sessionId, ctx)) return;

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
  if (duplicate) return;

  const agentName = await resolveAgentName(input.sessionId, client, ctx.store);
  const chain = agentName ? (ctx.chains.get(agentName) ?? []) : [];
  const isSubagent = await detectSubagent(input.sessionId, client, ctx.store);
  const result = await attemptFallback({
    sessionId: input.sessionId,
    reason: input.category,
    chain,
    client,
    store: ctx.store,
    config: ctx.config,
    logger: ctx.logger,
    isSubagent,
  });
  // OpenCode may deliver an event before the Hooks.config callback has
  // populated chains. Preserve the existing lifecycle behavior: the same
  // signal may retry after config becomes available. Other failures remain
  // deduped to prevent repeated recovery churn.
  if (!result.success && result.error === "no chain") {
    ctx.store.failures.forget(identity);
  }
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
      await handleFailureSignal(ctx, client, {
        source: "message_updated",
        sessionId,
        messageId: info.id,
        category,
        fingerprint: failureFingerprint(info.error),
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
): Promise<PluginHooks> {
  const logger = createLogger();
  const cooldownOverrides = extractCooldownOverrides(pluginOptions, logger);
  const ctx = createPluginContext({ pluginOptions, cooldownOverrides, logger });

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
    // closures that hold ctx by reference.
    config: async (input: unknown) => {
      const { chains: loaded, warnings } = loadFallbackChains(
        input,
        ctx.logger,
        ctx.pluginOptions,
      );
      ctx.chains.clear();
      for (const [name, chain] of loaded) ctx.chains.set(name, chain);
      for (const w of warnings)
        ctx.logger.warn("loader.warning", { message: w });
      ctx.logger.info("config.loaded", { agentCount: ctx.chains.size });
    },
  };
}
