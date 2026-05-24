# Model Preferences Routing

## Purpose

Define how `omr` resolves and applies model preferences for OpenCode targets.

## Config

Preferences are stored in `omr-preferences.json`:

```json
{
  "target_models": {
    "general": "anthropic/claude-haiku-4"
  },
  "cleared_models": {
    "scout": true
  },
  "adv_providers": {
    "adv-claude": {
      "enabled": true,
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

- `target_models` — maps each target (agent or sub-agent) directly to a model ID.
- `cleared_models` — tracks targets whose model was explicitly cleared by the user.
- `adv_providers` — provider ADV variant configuration. Only `adv-claude`, `adv-gpt`, `adv-glm`, and `adv-kimi` are valid keys.

Fallback chains are applied to OpenCode plugin tuple options, not to
`agent.<name>.options`. The runtime shape is:

```jsonc
{
  "plugin": [
    [
      "/home/you/.local/share/opencode-model-routing/plugin",
      {
        "agents": {
          "general": {
            "fallback_models": ["anthropic/claude-sonnet-4-5"]
          }
        }
      }
    ]
  ]
}
```

Legacy `agent.<name>.options.fallback_models` is read for migration and removed
on the next write. OMR never writes new fallback metadata into `agent.options`
because OpenCode forwards that object as provider/model request options.

Main agents/overlays `build`, `adv`, and `plan` are intentionally excluded from direct mapping. They should follow current session model instead of getting pinned in `opencode.json`.

If stale `build`, `adv`, or `plan` entries already exist in `omr-preferences.json`, `omr` removes them automatically on load/save.

## Resolution

When applying preferences, each target resolves as:

1. If `cleared_models[target]` is true, **delete** the `model` key from `opencode.json` (other fields preserved).
2. If `target_models[target]` is non-empty, write that model to `opencode.json`.
3. If `target_fallbacks[target]` is non-empty, write it to the OMR plugin tuple option at `plugin[N][1].agents.<target>.fallback_models` and remove any legacy `agent.<target>.options.fallback_models`.
4. If `target_fallbacks[target]` is empty and an existing fallback chain exists, remove both plugin-owned and legacy fallback fields.
5. For `adv_providers`, write `agent.adv-{provider}.disable` = `!enabled`, and `agent.adv-{provider}.model` if non-empty.
6. Else leave target unchanged.

## OpenCode Runtime Contracts

The TypeScript runtime targets the OpenCode plugin server API, which passes a
main `@opencode-ai/sdk` client in `PluginInput.client`.

- `session.messages({ path: { id } })` returns `{ info: Message, parts: Part[] }[]`.
- `session.prompt({ path: { id }, body })`, `session.abort({ path: { id } })`, and `session.revert({ path: { id }, body })` use the documented main SDK request envelope.
- Streaming token arrival is `message.part.updated`; the session id is read from `event.properties.part.sessionID`.
- `chat.params.output.options.fallback_models` is deleted before OpenCode calls provider-specific option transforms.

For unmapped main agents/overlays (`build`, `adv`, `plan`), applying preferences always removes any direct `model` override from `opencode.json`.

Provider ADV variants (`adv-claude`, `adv-gpt`, `adv-glm`, `adv-kimi`) are whitelisted as mappable despite their `adv-` prefix. The canonical `adv` agent remains unmapped.

Only targets that already exist in `opencode.json` are written to. Assigning a new model to a previously cleared target removes it from `cleared_models`.

## TUI Sections

The TUI groups targets into three sections:

- **Agents** — visible, user-facing agents
- **Sub-agents** — agents with `mode: subagent` or `hidden: true` (e.g. plugin sub-agents like `adv-researcher`). Not shown in OpenCode's Tab-cycle in the same way as primary agents, but configurable here.
- **ADV Provider Agents** — provider-specific ADV variants (`adv-claude`, `adv-gpt`, `adv-glm`, `adv-kimi`). Generated globally by ADV sync. Each shows enabled/disabled status and optional model.

`build`, `adv`, and `plan` do not appear in these configurable sections.

Sub-agent mappings are sticky overrides. They do not automatically follow a main-agent model change. Clearing a sub-agent mapping returns it to inherited/default OpenCode routing.

## TUI Controls

- `enter` / `m` — pick a model for the selected agent
- `d` — clear model assignment
- `D` — clear all sub-agent overrides
- `e` — toggle enable/disable for selected ADV Provider Agent
- `a` — apply all preferences to `opencode.json`
- `/` — filter the list
- `q` — quit
