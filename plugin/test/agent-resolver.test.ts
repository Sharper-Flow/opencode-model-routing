import { describe, expect, test } from "bun:test";
import { resolveAgentName } from "../src/resolution/agent-resolver.ts";
import { FallbackStore } from "../src/state/store.ts";
import { MockClient } from "./helpers/mock-client.ts";

describe("resolveAgentName", () => {
  test("returns cached name without API call", async () => {
    const store = new FallbackStore();
    store.sessions.get("s1").agentName = "scout";
    const client = new MockClient();
    const name = await resolveAgentName("s1", client, store);
    expect(name).toBe("scout");
    expect(client.calls.length).toBe(0);
  });

  test("fetches from messages on cold cache and caches it", async () => {
    const store = new FallbackStore();
    const client = new MockClient({
      messages: [{ info: { agent: "scout", role: "user" }, parts: [] }, { info: { agent: "scout", role: "assistant" }, parts: [] }],
    });
    const name = await resolveAgentName("s1", client, store);
    expect(name).toBe("scout");
    // Subsequent call hits cache.
    const again = await resolveAgentName("s1", client, store);
    expect(again).toBe("scout");
    // Only one messages call.
    expect(client.callsTo("session.messages").length).toBe(1);
    expect(client.callsTo("session.messages")[0]?.args).toEqual({ path: { id: "s1" } });
  });

  test("returns null when messages are empty", async () => {
    const store = new FallbackStore();
    const client = new MockClient({ messages: [] });
    expect(await resolveAgentName("s1", client, store)).toBeNull();
  });

  test("returns null when first messages lack an agent field", async () => {
    const store = new FallbackStore();
    const client = new MockClient({
      messages: [{ info: { role: "user" }, parts: [] }, { info: { role: "assistant", agent: "" }, parts: [] }],
    });
    expect(await resolveAgentName("s1", client, store)).toBeNull();
  });

  test("returns null on API error", async () => {
    const store = new FallbackStore();
    const client = new MockClient({ messagesError: new Error("boom") });
    expect(await resolveAgentName("s1", client, store)).toBeNull();
  });
});
