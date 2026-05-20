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

export class TtftRegistry {
  private timers = new Map<string, TimerHandle>();

  arm(sessionId: string, ttftMs: number, onTimeout: () => void): void {
    // Replace any existing timer for the same session.
    this.clear(sessionId);
    const handle = setTimeout(onTimeout, ttftMs);
    this.timers.set(sessionId, handle);
  }

  clear(sessionId: string): void {
    const handle = this.timers.get(sessionId);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(sessionId);
    }
  }

  has(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }
}
