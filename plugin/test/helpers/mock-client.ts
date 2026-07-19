// MockClient — narrow stub of the @opencode-ai/sdk client surface the plugin
// uses. Records calls for assertion, supports scripted responses + errors.
//
// Borrowed in shape from Smart-Coders-HQ/opencode-model-fallback (Apache-2.0).

export interface RecordedCall {
  method: string;
  args: unknown;
}

export interface MockClientOptions {
  messages?: unknown[];
  abortError?: Error;
  revertError?: Error;
  promptError?: Error;
  messagesError?: Error;
  // Optional session info returned by session.get. When omitted, returns
  // an empty object (no parentID → primary session). Set { parentID: "..." }
  // to simulate a subagent session.
  sessionInfo?: Record<string, unknown>;
  getError?: Error;
}

export class MockClient {
  public calls: RecordedCall[] = [];
  private opts: MockClientOptions;

  constructor(opts: MockClientOptions = {}) {
    this.opts = opts;
  }

  setMessages(messages: unknown[]) {
    this.opts.messages = messages;
  }

  setSessionInfo(sessionInfo: Record<string, unknown>) {
    this.opts.sessionInfo = sessionInfo;
  }

  // The narrow surface used by orchestrator + agent-resolver + subagent
  // detection (session.get).
  session = {
    messages: async (args: unknown) => {
      this.calls.push({ method: "session.messages", args });
      if (this.opts.messagesError) throw this.opts.messagesError;
      return this.opts.messages ?? [];
    },
    abort: async (args: unknown) => {
      this.calls.push({ method: "session.abort", args });
      if (this.opts.abortError) throw this.opts.abortError;
    },
    revert: async (args: unknown) => {
      this.calls.push({ method: "session.revert", args });
      if (this.opts.revertError) throw this.opts.revertError;
    },
    prompt: async (args: unknown) => {
      this.calls.push({ method: "session.prompt", args });
      if (this.opts.promptError) throw this.opts.promptError;
    },
    get: async (args: unknown) => {
      this.calls.push({ method: "session.get", args });
      if (this.opts.getError) throw this.opts.getError;
      // SDK wraps responses in { data: ... } — unwrapSdkData handles both
      // wrapped and bare shapes. Return bare here for test simplicity.
      return this.opts.sessionInfo ?? {};
    },
  };

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}
