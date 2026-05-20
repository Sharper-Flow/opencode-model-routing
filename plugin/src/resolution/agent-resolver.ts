// agent-resolver: resolves the agent name for a session.
//
// session.error events don't include the agent name in their typed props;
// neither does the chat.message hook always know the agent at hook time on
// fallback paths. The reference plugin's strategy: look up the first
// message in the session and read its `agent` field, then cache the result
// on session state so subsequent fallbacks within the same session skip the
// API call.

import type { FallbackStore } from "../state/store.ts";

// Subset of @opencode-ai/sdk client surface we actually use. Kept narrow
// so tests can stub it without pulling the full SDK type graph.
export interface AgentResolverClient {
  session: {
    messages(args: { sessionID: string } | { sessionId: string }): Promise<unknown[]>;
  };
}

export async function resolveAgentName(
  sessionId: string,
  client: AgentResolverClient,
  store: FallbackStore,
): Promise<string | null> {
  const state = store.sessions.get(sessionId);
  if (state.agentName) return state.agentName;

  let messages: unknown[];
  try {
    // The SDK uses sessionID (capital ID) in some versions and sessionId in
    // others — accept either by trying both.
    messages = await client.session.messages({ sessionID: sessionId } as never).catch(async () =>
      client.session.messages({ sessionId } as never),
    );
  } catch {
    return null;
  }
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // Walk messages oldest-first; the first one with a non-empty agent wins.
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const agent = (m as { agent?: unknown }).agent;
    if (typeof agent === "string" && agent.length > 0) {
      state.agentName = agent;
      return agent;
    }
  }
  return null;
}
