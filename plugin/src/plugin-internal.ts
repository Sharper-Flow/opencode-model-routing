// plugin-internal.ts — testable OpenCode plugin implementation helpers.
//
// Wires the hooks:
//   - chat.message: preemptive skip + TTFT arm
//   - event: session.error / session.status retry / session.idle / token arrival
//
// Per-process state is held in a closure (FallbackStore + chains map + TTFT
// registry). On each chat.message round, the chain map is rebuilt from the
// current config — cheap and keeps reloads simple.

import { loadFallbackChains } from "./config/loader.ts";
import {
  classifyRetryStatusText,
  classifySessionError,
  type SessionErrorData,
} from "./detection/classifier.ts";
import { createLogger, type Logger } from "./logging/logger.ts";
import { applyPreemptiveSkip } from "./preemptive.ts";
import { attemptFallback, type OrchestratorClient } from "./replay/orchestrator.ts";
import { resolveAgentName } from "./resolution/agent-resolver.ts";
import { FallbackStore } from "./state/store.ts";
import { TtftRegistry } from "./ttft.ts";
import { defaultConfig, type ErrorCategory, type ModelKey, type PluginConfig } from "./types.ts";

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
  "chat.message"?: (input: unknown, output: unknown) => unknown | Promise<unknown>;
  event?: (input: unknown) => unknown | Promise<unknown>;
  // Hooks.config per @opencode-ai/plugin SDK — receives merged OpenCode Config
  // after plugin init and BEFORE bus.subscribeAll() — see ordering proof in
  // packages/opencode/src/plugin/index.ts:217-237 @ 7fe7b9f.
  config?: (input: unknown) => unknown | Promise<unknown>;
}

export interface PluginContext {
  store: FallbackStore;
  ttft: TtftRegistry;
  chains: Map<string, ModelKey[]>;
  config: PluginConfig;
  logger: Logger;
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
 */
export function createPluginContext(opts: {
  config?: Partial<PluginConfig>;
  logger?: Logger;
} = {}): PluginContext {
  const logger = opts.logger ?? createLogger();
  const merged: PluginConfig = { ...defaultConfig, ...(opts.config ?? {}) };
  return {
    store: new FallbackStore(),
    ttft: new TtftRegistry(),
    chains: new Map(),
    config: merged,
    logger,
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
}
interface ChatMessageOutputShape {
  message: { model?: { providerID: string; modelID: string } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "function";
}

export function isPluginInput(input: unknown): input is PluginInput {
  if (!isRecord(input)) return false;
  const client = input.client;
  if (!isRecord(client)) return false;
  if (!isRecord(client.session)) return false;
  return ["messages", "abort", "revert", "prompt"].every((key) =>
    hasFunction(client.session as Record<string, unknown>, key),
  );
}

export function normalizeChatMessageInput(input: unknown): ChatMessageInputShape | undefined {
  if (!isRecord(input)) return undefined;
  const sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined;
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
  if (!sessionID && !sessionId) return undefined;
  return { sessionID, sessionId };
}

export function isChatMessageOutputShape(output: unknown): output is ChatMessageOutputShape {
  if (!isRecord(output)) return false;
  if (!isRecord(output.message)) return false;
  const model = output.message.model;
  if (model === undefined) return true;
  return isRecord(model) && typeof model.providerID === "string" && typeof model.modelID === "string";
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
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

  const agentName = await resolveAgentName(sessionId, client, ctx.store);

  applyPreemptiveSkip(
    { sessionId, agentName, output },
    ctx.store,
    ctx.chains,
    ctx.config,
    ctx.logger,
  );

  // Arm the TTFT timer for this round. Cleared when the first token arrives
  // via the event hook (session.message.part.updated).
  ctx.ttft.arm(sessionId, ctx.config.ttftMs, async () => {
    const chain = agentName ? ctx.chains.get(agentName) ?? [] : [];
    try {
      await attemptFallback({
        sessionId,
        reason: "ttft_timeout",
        chain,
        client,
        store: ctx.store,
        config: ctx.config,
        logger: ctx.logger,
      });
    } catch (err) {
      ctx.logger.error("ttft.callback_failed", { sessionId, err: errorSummary(err) });
    }
  });
}

interface EventInputShape {
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
    part?: { type?: string; text?: string };
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
  if (!isOptionalString(props.sessionID) || !isOptionalString(props.sessionId)) return false;
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
    if (props.status.action !== undefined && !isActionShape(props.status.action)) return false;
  }
  if (props.part !== undefined) {
    if (!isRecord(props.part)) return false;
    if (!isOptionalString(props.part.type) || !isOptionalString(props.part.text)) return false;
  }
  return true;
}

export function normalizeEventInput(input: unknown): EventInputShape | undefined {
  // OpenCode's event hook passes `{ event }`; undefined registration probes
  // are treated as no-op compatibility inputs.
  if (!isRecord(input)) return undefined;
  return isEventInputShape(input.event) ? input.event : undefined;
}

function hasStreamingTextContent(part: { type?: string; text?: string }): boolean {
  return part.type === "text" && typeof part.text === "string" && part.text.length > 0;
}

export async function handleEvent(
  ctx: PluginContext,
  client: OrchestratorClient,
  event: EventInputShape | undefined,
): Promise<void> {
  // Defensive: OpenCode may invoke event with undefined during registration.
  if (!event) return;
  const props = event.properties ?? {};
  const sessionId = props.sessionID ?? props.sessionId ?? "";
  if (!sessionId) return;

  switch (event.type) {
    case "session.error": {
      if (!props.error) return;
      const category = classifySessionError(props.error);
      const agentName = await resolveAgentName(sessionId, client, ctx.store);
      const chain = agentName ? ctx.chains.get(agentName) ?? [] : [];
      await attemptFallback({
        sessionId,
        reason: category,
        chain,
        client,
        store: ctx.store,
        config: ctx.config,
        logger: ctx.logger,
      });
      return;
    }
    case "session.status": {
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
      const agentName = await resolveAgentName(sessionId, client, ctx.store);
      const chain = agentName ? ctx.chains.get(agentName) ?? [] : [];
      await attemptFallback({
        sessionId,
        reason: category,
        chain,
        client,
        store: ctx.store,
        config: ctx.config,
        logger: ctx.logger,
      });
      return;
    }
    case "session.message.part.updated": {
      // First streamed text content for this session → clear TTFT timer. Do
      // not clear on metadata/tool/status parts that have a non-empty type but
      // no generated text.
      const part = props.part;
      if (!part) return;
      if (!hasStreamingTextContent(part)) return;
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
    default:
      return;
  }
}

/**
 * createPluginHooks wires the closure-held context into the OpenCode hook
 * signatures. The runtime entry point wraps this in a V1 PluginModule object,
 * while hook payloads remain `unknown` and are narrowed inside handlers because
 * plugin types are not stable across versions per agreement.
 */
export async function createPluginHooks(opts: PluginInput): Promise<PluginHooks> {
  const ctx = createPluginContext();

  return {
    "chat.message": async (input: unknown, output: unknown) => {
      const chatInput = normalizeChatMessageInput(input);
      const chatOutput = isChatMessageOutputShape(output) ? output : undefined;
      await handleChatMessage(ctx, opts.client, chatInput, chatOutput);
    },
    event: async (input: unknown) => {
      await handleEvent(ctx, opts.client, normalizeEventInput(input));
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
      const { chains: loaded, warnings } = loadFallbackChains(input, ctx.logger);
      ctx.chains.clear();
      for (const [name, chain] of loaded) ctx.chains.set(name, chain);
      for (const w of warnings) ctx.logger.warn("loader.warning", { message: w });
      ctx.logger.info("config.loaded", { agentCount: ctx.chains.size });
    },
  };
}
