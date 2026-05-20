// plugin.ts — OpenCode plugin entry point.
//
// Exports a default async function with the @opencode-ai/plugin contract.
// Wires the hooks:
//   - chat.message: preemptive skip + TTFT arm
//   - event: session.error / session.status retry / session.idle / token arrival
//
// Per-process state is held in a closure (FallbackStore + chains map + TTFT
// registry). On each chat.message round, the chain map is rebuilt from the
// current config — cheap and keeps reloads simple.

import { loadFallbackChains } from "./config/loader.ts";
import { classifyRetryStatusText, classifySessionError } from "./detection/classifier.ts";
import { createLogger, type Logger } from "./logging/logger.ts";
import { applyPreemptiveSkip } from "./preemptive.ts";
import { attemptFallback, type OrchestratorClient } from "./replay/orchestrator.ts";
import { resolveAgentName } from "./resolution/agent-resolver.ts";
import { FallbackStore } from "./state/store.ts";
import { TtftRegistry } from "./ttft.ts";
import { defaultConfig, type ModelKey, type PluginConfig } from "./types.ts";

// PluginInput is intentionally typed loosely — the @opencode-ai/plugin
// signature varies across versions; we accept what we need defensively.
export interface PluginInput {
  client: OrchestratorClient & {
    session: OrchestratorClient["session"];
  };
  directory?: string;
  config?: unknown;
}

export interface PluginHooks {
  "chat.message"?: (input: unknown, output: unknown) => unknown | Promise<unknown>;
  event?: (input: unknown) => unknown | Promise<unknown>;
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
 */
export function createPluginContext(opts: {
  rawConfig?: unknown;
  config?: Partial<PluginConfig>;
  logger?: Logger;
}): PluginContext {
  const logger = opts.logger ?? createLogger();
  const merged: PluginConfig = { ...defaultConfig, ...(opts.config ?? {}) };
  const { chains, warnings } = loadFallbackChains(opts.rawConfig, logger);
  for (const w of warnings) logger.warn("loader.warning", { message: w });
  return {
    store: new FallbackStore(),
    ttft: new TtftRegistry(),
    chains,
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

export async function handleChatMessage(
  ctx: PluginContext,
  client: OrchestratorClient,
  input: ChatMessageInputShape,
  output: ChatMessageOutputShape,
): Promise<void> {
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
    await attemptFallback({
      sessionId,
      reason: "ttft_timeout",
      chain,
      client,
      store: ctx.store,
      config: ctx.config,
      logger: ctx.logger,
    });
  });
}

interface EventInputShape {
  type?: string;
  properties?: {
    sessionID?: string;
    sessionId?: string;
    error?: { providerID?: string; statusCode?: number; name?: string; message?: string };
    status?: { message?: string };
    part?: { type?: string; text?: string };
  };
}

function hasStreamingTextContent(part: { type?: string; text?: string }): boolean {
  return part.type === "text" && typeof part.text === "string" && part.text.length > 0;
}

export async function handleEvent(
  ctx: PluginContext,
  client: OrchestratorClient,
  event: EventInputShape,
): Promise<void> {
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
      const text = props.status?.message ?? "";
      const category = classifyRetryStatusText(text);
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
 * Default export — the @opencode-ai/plugin entry point.
 *
 * Wires the closure-held context into the hook signatures expected by the
 * plugin runtime. We accept `unknown` payloads and narrow inside the
 * handlers because the plugin types are not stable across versions per
 * agreement.
 */
// eslint-disable-next-line import/no-default-export
export default async function plugin(opts: PluginInput): Promise<PluginHooks> {
  const ctx = createPluginContext({ rawConfig: opts.config });

  return {
    "chat.message": async (input: unknown, output: unknown) => {
      await handleChatMessage(
        ctx,
        opts.client,
        input as ChatMessageInputShape,
        output as ChatMessageOutputShape,
      );
    },
    event: async (input: unknown) => {
      await handleEvent(ctx, opts.client, input as EventInputShape);
    },
  };
}
