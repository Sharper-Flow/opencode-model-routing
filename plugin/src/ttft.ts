// ttft.ts — time-to-first-token timer registry.
//
// Per-session timer set at the start of a chat round. Cleared when the first
// streamed token arrives (session.message.part.updated event with non-empty
// content). If the timer fires before a token arrives, the orchestrator is
// invoked with reason="ttft_timeout".
//
// Streaming-safe: once any token arrives, the timer is cleared and no
// further TTFT enforcement happens for that round. Inter-token stall
// detection is out of scope per agreement.

export type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerEntry {
  handle: TimerHandle;
}

export class TtftRegistry {
  private timers = new Map<string, TimerEntry>();

  arm(sessionId: string, ttftMs: number, onTimeout: () => void): void {
    // Replace any existing timer for the same session.
    this.clear(sessionId);
    const entry: TimerEntry = {
      handle: setTimeout(() => {
        if (this.timers.get(sessionId) !== entry) return;
        this.timers.delete(sessionId);
        onTimeout();
      }, ttftMs),
    };
    this.timers.set(sessionId, entry);
  }

  clear(sessionId: string): void {
    const entry = this.timers.get(sessionId);
    if (entry) {
      clearTimeout(entry.handle);
      this.timers.delete(sessionId);
    }
  }

  has(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }
}
