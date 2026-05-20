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

  // The narrow surface used by orchestrator + agent-resolver.
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
  };

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}
