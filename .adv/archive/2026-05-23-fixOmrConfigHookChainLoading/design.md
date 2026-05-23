# Design

## Discovery findings (validated by adv-researcher: APPROVE + 1 concern)

Confirmed via OpenCode source `packages/opencode/src/plugin/index.ts:217-237` @ commit 7fe7b9f:

```ts
// 1. Load all external plugins (init phase)
for (const load of loaded) {
  yield* Effect.tryPromise({ try: () => applyPlugin(load, input, hooks), ... })
}

// 2. Notify plugins of current config — AWAITED before bus subscription
for (const hook of hooks) {
  yield* Effect.tryPromise({
    try: () => Promise.resolve((hook as any).config?.(cfg)),
    catch: (err) => log.error("plugin config hook failed", { error: err })
  }).pipe(Effect.ignore)
}

// 3. Subscribe to bus events
yield* (yield* bus.subscribeAll()).pipe(Stream.runForEach(...), Effect.forkScoped)
```

**Ordering guarantee (today):** Sequential `yield*` in `Effect.gen` → config hooks awaited before `bus.subscribeAll()` even called. No race window.

**Validator concern (absorbed):** Ordering is not part of the published `Hooks` contract. Mitigation in this change: code comment documenting dependency + ordering-violation regression test that codifies "event before config = no crash, no fallback, log empty-chain skip". Lazy `client.config.get()` hardening deferred.

**Config delivery shape** (validated):
- `@opencode-ai/sdk` `Config.agent?: { [name: string]: AgentConfig }`
- `AgentConfig` has typed surface (model, temperature, tools, ...) + index signature for unknown keys
- OpenCode runtime `packages/opencode/src/config/agent.ts:77+` `normalize()` promotes any unknown sibling key into `agent.options`, so `cfg.agent.<name>.options.fallback_models` is the canonical reachable path even if user wrote it as a sibling

**PluginInput shape** (`packages/opencode/src/plugin/index.ts:134-150`): `{client, project, worktree, directory, experimental_workspace, serverUrl, $}`. No `config`. OMR's `opts.config` read is dead code.

## Fix plan

### Fix 1 — Register `config` hook (with documented ordering dependency)

In `createPluginHooks`:

```ts
return {
  "chat.message": ...,
  event: ...,
  // OpenCode invokes `config` AFTER plugin init and BEFORE bus.subscribeAll()
  // — see packages/opencode/src/plugin/index.ts:217-237 @ 7fe7b9f. Chain
  // population is therefore guaranteed before the first session.status event.
  // If a future OpenCode reorder breaks this, the ordering-violation test
  // codifies the contract: empty chain → "no chain" skip, no crash.
  config: async (cfg: unknown) => {
    const { chains: loaded, warnings } = loadFallbackChains(cfg, ctx.logger);
    ctx.chains.clear();
    for (const [name, chain] of loaded) ctx.chains.set(name, chain);
    for (const w of warnings) ctx.logger.warn("loader.warning", { message: w });
    ctx.logger.info("config.loaded", { agentCount: ctx.chains.size });
  },
};
```

### Fix 2 — Strip dead `opts.config` reads from `createPluginContext`

```ts
export function createPluginContext(opts: {
  config?: Partial<PluginConfig>;
  logger?: Logger;
}): PluginContext {
  const logger = opts.logger ?? createLogger();
  const merged: PluginConfig = { ...defaultConfig, ...(opts.config ?? {}) };
  // Chains start empty; populated by `config` hook in createPluginHooks
  return {
    store: new FallbackStore(),
    ttft: new TtftRegistry(),
    chains: new Map(),
    config: merged,
    logger,
  };
}
```

Remove `rawConfig` parameter from the function signature (was always undefined in production).

### Fix 3 — Correct `PluginInput` interface

```ts
// Real shape from @opencode-ai/plugin@1.15.5 PluginInput + OpenCode source
// packages/opencode/src/plugin/index.ts:134-150. `config` is NOT here —
// OpenCode delivers config via Hooks.config callback after init.
export interface PluginInput {
  client: OrchestratorClient & { session: OrchestratorClient["session"] };
  directory?: string;
  worktree?: string;
}
```

Remove `config?: unknown` field. Drop `loadFallbackChains` import + call from `createPluginContext` (moves to `createPluginHooks`).

### Fix 4 — Add integration + ordering-violation tests

In `plugin/test/plugin.test.ts` (or new file `config-hook.test.ts`):

```ts
describe("createPluginHooks — config hook lifecycle", () => {
  test("init → config hook → event triggers fallback", async () => {
    const client = makeMockClient({...});
    const hooks = await createPluginHooks({
      client: client as any,
      directory: "/tmp/repo",
    });
    expect(typeof hooks.config).toBe("function");

    // OpenCode delivers config via hook
    await hooks.config!({
      agent: { adv: { options: { fallback_models: ["anthropic/claude", "z/glm"] } } },
    });

    // Bus event arrives after config hook completed
    await hooks.event!({
      event: {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            message: "The usage limit has been reached",
            attempt: 1,
            next: Date.now() + 2000,
          },
        },
      },
    });

    expect(client.callsTo("session.abort").length).toBe(1);
    expect(client.callsTo("session.prompt").length).toBe(1);
  });

  test("ordering violation: event before config → no crash, no fallback, empty-chain log", async () => {
    const client = makeMockClient({...});
    const hooks = await createPluginHooks({ client: client as any });
    // Fire event BEFORE config — codifies the ordering contract
    await expect(
      hooks.event!({ event: { type: "session.status", properties: {...} } })
    ).resolves.toBeUndefined();
    expect(client.callsTo("session.abort").length).toBe(0);
    expect(client.callsTo("session.prompt").length).toBe(0);

    // Now deliver config and fire again
    await hooks.config!({ agent: { adv: { options: { fallback_models: [...] } } } });
    await hooks.event!({ event: {...same...} });
    expect(client.callsTo("session.prompt").length).toBe(1);
  });

  test("empty agent config → chains.size === 0, fallback exits 'no chain'", async () => {
    // Tests that loader correctly handles cfg with no agents
  });
});
```

### Files touched

- `plugin/src/plugin-internal.ts` — strip `opts.config`/`opts.rawConfig`; correct `PluginInput`; register `config` hook with documented ordering comment
- `plugin/test/plugin.test.ts` — add 3 tests for config hook lifecycle

### Files NOT touched

- `plugin/src/config/loader.ts` — no change (loader already accepts the shape)
- `plugin/src/detection/*` — classifier/patterns shipped in parent
- `plugin/src/replay/orchestrator.ts` — fallback dispatch unchanged
- `plugin/src/resolution/agent-resolver.ts` — no change

## Rebuild / deploy

```
make deploy-local
# Restart OpenCode session
# Trigger 429 by hitting usage cap → verify fallback rotates models
```

## Risk register

| Risk | Mitigation |
|---|---|
| `Hooks.config` not in OMR PluginHooks type | Add as optional field on PluginHooks interface; cast at registration site |
| Map identity stability | Verified by validator (handlers read `ctx.chains.get()` at call time); ordering-violation test covers regression |
| Future OpenCode reorders bus-before-config | Ordering-violation regression test + code comment with source link; lazy `client.config.get()` hardening deferred to a future change if multi-version support becomes a concern |
| Logger noise on every init | `config.loaded` is single info-level event — bounded |
