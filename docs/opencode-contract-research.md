# OpenCode Contract Research for OMR

Last checked: 2026-09-23 (V2 section); 2026-05-23 (V1 sections).

## Sources

- Official plugin docs: https://opencode.ai/docs/plugins.md
- Official SDK docs: https://opencode.ai/docs/sdk.md
- Published config schema: https://opencode.ai/config.json
- OpenCode source: `packages/opencode/src/session/llm/request.ts`, `packages/opencode/src/session/llm.ts`, `packages/opencode/src/provider/transform.ts`, `packages/opencode/src/plugin/index.ts`
- Installed OMR dev dependencies: `@opencode-ai/plugin@1.4.8`, `@opencode-ai/sdk@1.4.17`

## OpenCode 2 (V2)

- Plugin docs: https://opencode.ai/v2/docs/build/plugins — migration guide: https://opencode.ai/v2/docs/build/plugins/migrate-v1
- V2 decodes a package plugin's default export structurally as `{id, setup}`
  (or `{id, effect}`) and ignores `server()`. V1 1.18.29+ calls `server()`.
  A dual default export `{...Plugin.define({id, setup}), server}` is the
  documented cross-runtime shape; the V2 decode is structural, so the object
  can be built without importing `@opencode/plugin` (keeps the V1 load path
  free of a V2-only runtime import).
- V2 config: `plugins` array of strings or `{package, options}` objects. V2
  normalizes a V1 `plugin` tuple in memory; conversion to native shape is
  optional. `agent` was renamed `agents`.
- Hook mapping (migration guide): `chat.message` → `ctx.session.hook("prompt")`
  (prompt admission) — but OMR's per-request model routing maps to
  `ctx.session.hook("context")` (runs immediately before each agent-loop model
  request; carries `sessionID`, `agent`, readonly `model`). `chat.params` →
  `"context"` options. `event` → `ctx.event.subscribe({signal})`.
- Failure handling: `ctx.session.hook("retry")` runs after OpenCode classifies
  a provider failure and before any retry is scheduled; `event.decision` may
  set `{retry: false}`. Carries `sessionID`, `agent`, `model`,
  `error {type, message, status}`, `attempt`.
- Session domain replaces V1 client calls: `session.context({sessionID})`
  (messages), `session.get({sessionID})`, `session.prompt({sessionID, text})`,
  `session.interrupt({sessionID, resume})`, `session.switchModel({sessionID,
  model})`. Shapes verified against the installed `@opencode/plugin`
  (SessionDomain) and `@opencode/client` input types @ v2.0.14, then
  re-verified live against the binary. There is no `revert` — the V1
  abort→revert→prompt replay cannot be transplanted.
- VERIFIED LIVE (opencode v2.0.14): `interrupt({resume: true})` does NOT
  re-drive a settled turn — the session ends without a new model request.
  The working replay is `switchModel(next)` followed by approving one host
  retry from the retry hook (`event.decision = {retry: true, delay}`). A
  vetoed retry leaves nobody retrying. `interrupt({resume: false})` aborts a
  child session for the subagent handoff.
- VERIFIED LIVE (opencode v2.0.14, 2026-09-22 TTFT-stall fixture): a TTFT
  timeout leaves the failed request IN FLIGHT; the retry hook never fires
  for it. `switchModel(next)` alone re-drives nothing — the session hangs on
  the stalled request indefinitely. Adding `interrupt({resume: true})` after
  the switch aborts the stalled request and ENDS the turn (the run exits,
  empty output) — it still does not re-drive. A re-prompt would complete the
  turn but duplicates the user message (rejected by the approved design).
  Net V2 TTFT behavior: bounded abort + one chain advance + the session
  anchored on the healthy rung for the next turn; in-run turn completion is
  an upstream limitation.
- VERIFIED LIVE: a directory-form `plugins` entry resolves its entry through
  `<dir>/server` then `<dir>/index` via Bun `resolveSync`; package.json
  `exports` is NOT consulted for that shape. A package without a root
  `index.js`/`index.ts` is SILENTLY skipped (no warning at any log level).
  The loader also must resolve `@opencode/plugin` from the installed package
  tree (published-plugin requirement). npm-name entries are npm-installed by
  the host; unreleased names fail with a logged 404.
- VERIFIED LIVE (opencode v2.0.14, 2026-09-22 primary-usage probe; corrected
  2026-09-23 against the official V2 agents contract,
  https://opencode.ai/v2/docs/agents/): the earlier probe drove the agent as
  a PRIMARY (`--agent`) and found the JSON `agents.<name>.model` STRING
  ignored. That is the documented PRIMARY semantic, not field inertness: a
  session stores its selected model separately, and selecting a primary
  agent by ID does not change that model. The official contract gives the
  SUBAGENT semantic: a subagent uses its configured model, inheriting the
  parent session's model only when none is configured. The OBJECT form
  `{providerID, modelID}` still breaks the agent decode as probed (note: the
  documented expanded form uses `{providerID, model, variant}` keys — a
  different shape that was not the probed one). The omr writer keeps the
  documented string form: effective under V1, the subagent's model under V2.
  The subagent path is verified live by scripts/e2e-v2-runtime.sh, whose
  fixture anchors the failing chain head via `agents.reviewer.model` alone.
- TTFT continuation-route investigation (2026-09-23; installed
  @opencode/client 2.0.14 dist + upstream dev source): no supported
  plugin-reachable surface re-drives a stalled turn without duplicating the
  user message. Evidence: `interrupt({resume:true})` aborts the stalled
  request and ends the turn (live, v2.0.14); a re-prompt with a new id
  duplicates the user turn (rejected by the approved design), and upstream
  dev turns a same-id re-admission into `PromptConflictError`
  (packages/core/src/session/input.ts treats a stored id as
  LifecycleConflict); the core's internal `execution.resume` exists
  (packages/core/src/session.ts) but is NOT exposed on the 2.0.14
  client/plugin session domain (verified against the installed
  @opencode/client 2.0.14 dist and upstream's generated client). Net V2
  TTFT behavior stands: bounded abort + one chain advance + the session
  anchored on the healthy rung for the next turn; in-run turn completion is
  an upstream limitation.
- Plugin options arrive on `ctx.options`; the V1 config hook has no V2
  equivalent (domain transforms replace it), so legacy
  `agent.<name>.options.fallback_models` is unreadable under V2.

## Plugin configuration

OpenCode config accepts plugin tuple options:

```jsonc
"plugin": [
  ["/path/or/npm-spec", { "agents": { "general": { "fallback_models": ["provider/model"] } } }]
]
```

`@opencode-ai/plugin` declares:

```ts
export type PluginOptions = Record<string, unknown>
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
```

OpenCode source calls plugin server functions with `load.options` as the second argument.

## Runtime SDK surface

OpenCode plugin runtime constructs `createOpencodeClient` from `@opencode-ai/sdk` and passes it through `PluginInput.client`. That main SDK uses `{ path, body }` request envelopes:

```ts
client.session.messages({ path: { id: sessionId } })
client.session.abort({ path: { id: sessionId } })
client.session.revert({ path: { id: sessionId }, body: { messageID } })
client.session.prompt({ path: { id: sessionId }, body: { model, parts, agent } })
```

The v2 SDK exposes flatter helper parameters (`{ sessionID, ... }`), but the plugin runtime type imports the main client. OMR targets main SDK shape.

## Message shape

`session.messages` returns:

```ts
Array<{ info: Message; parts: Part[] }>
```

OMR normalizes this envelope at SDK boundaries. Legacy flat message objects are accepted only for compatibility tests and defensive parsing.

## Event shape

Official plugin docs list message events as:

- `message.part.removed`
- `message.part.updated`
- `message.removed`
- `message.updated`

Installed SDK type:

```ts
export type EventMessagePartUpdated = {
  type: "message.part.updated"
  properties: { part: Part; delta?: string }
}
```

There is no `session.message.part.updated` event in the current docs/types. OMR reads the session id from `properties.part.sessionID`.

## Provider options path

OpenCode builds LLM options in this order:

1. provider/model base options
2. model options
3. agent options
4. variant options
5. `chat.params` hook mutation
6. `ProviderTransform.providerOptions(model, prepared.params.options)`

Therefore `agent.<name>.options.fallback_models` is unsafe: it can become provider request metadata.

Provider transforms differ:

- AI Gateway splits `gateway` from the remaining options and routes the rest under the upstream provider slug.
- Azure duplicates options under `openai` and `azure`.
- OpenAI-compatible, OpenAI, and Anthropic use SDK/provider keys derived from package/provider id.
- Other custom providers use `sdkKey(model.api.npm)` or provider id.

OMR must strip `fallback_models` before provider transform and must store new routing config under plugin tuple options.
