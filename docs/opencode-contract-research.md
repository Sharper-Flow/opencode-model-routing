# OpenCode Contract Research for OMR

Last checked: 2026-05-23.

## Sources

- Official plugin docs: https://opencode.ai/docs/plugins.md
- Official SDK docs: https://opencode.ai/docs/sdk.md
- Published config schema: https://opencode.ai/config.json
- OpenCode source: `packages/opencode/src/session/llm/request.ts`, `packages/opencode/src/session/llm.ts`, `packages/opencode/src/provider/transform.ts`, `packages/opencode/src/plugin/index.ts`
- Installed OMR dev dependencies: `@opencode-ai/plugin@1.4.8`, `@opencode-ai/sdk@1.4.17`

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
