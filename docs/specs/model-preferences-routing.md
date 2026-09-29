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

Fallback chains are applied to OMR plugin options, not to
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

### V2 native plugins target

OpenCode 2 reads the same V1 tuple in memory and normalizes it, and carries a
native `plugins` array of `{package, options}` objects:

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/.local/share/opencode-model-routing/plugin",
      "options": {
        "agents": {
          "general": {
            "fallback_models": ["anthropic/claude-sonnet-4-5"],
            "blocked_models": ["openai/gpt-5-mini"]
          }
        }
      }
    }
  ]
}
```

`omr` keeps an existing OMR registration as the write target:

- An existing native V2 OMR entry is updated in place as a V2 object (a bare
  string entry is upgraded to the object form first).
- An existing V1 OMR tuple retains its package path and all agent options,
  even when an unrelated native V2 `plugins` array also exists.
- A first install into a native V2 `plugins` array appends an OMR object entry.
- Any other config keeps the V1 tuple target: it loads under OpenCode 1 and
  is normalized by OpenCode 2, so the tuple remains the cross-runtime safe
  default.
- Unrelated `plugins`/`plugin` entries, unrelated fields inside the OMR
  entry, and all non-plugin config fields are preserved on every write.

Agent sections follow the same rule: an agent is written where it is already
defined — the V2 native `agents` object or the V1 `agent` key — and an absent
agent is written to the section the config already uses. `omr` discovers,
reads, and reorders agents under both section keys.

Legacy `agent.<name>.options.fallback_models` is read for migration and removed
on the next write. OMR never writes new fallback metadata into `agent.options`
because OpenCode forwards that object as provider/model request options.

Main agents/overlays `build`, `adv`, and `plan` are intentionally excluded from direct mapping. They should follow current session model instead of getting pinned in `opencode.json`.

If stale `build`, `adv`, or `plan` entries already exist in `omr-preferences.json`, `omr` removes them automatically on load/save.

## Resolution

When applying preferences, each target resolves as:

1. If `cleared_models[target]` is true, **delete** the `model` key from `opencode.json` (other fields preserved).
2. If `target_models[target]` is non-empty, write that model to `opencode.json` (V1 `agent.<target>.model`, V2 native `agents.<target>.model`; string form). Under V2 the override's reach follows the official agents contract: a subagent uses its configured model, while a primary agent's session keeps its selected model — selecting a primary agent does not change it.
3. If `target_fallbacks[target]` is non-empty, write it to the existing OMR plugin options (V1 tuple or V2 object), or create an entry for a first install. Remove any legacy `agent.<target>.options.fallback_models`.
4. If `target_fallbacks[target]` is empty and an existing fallback chain exists, remove both plugin-owned and legacy fallback fields.
5. For `adv_providers`, write the agent toggle `!enabled`, addressing the agent where the config defines it: V1 `agent.adv-{provider}.disable`, or the V2 native `agents.adv-{provider}.disabled` (the V2 agents contract spells the toggle `disabled`; `disable` is the legacy V1 field). Write `adv-{provider}.model` in the same section if non-empty.
6. Else leave target unchanged.

## OpenCode Runtime Contracts

One package entrypoint supports both runtimes. OpenCode 1 (1.18.29+) decodes
the default export as `{id, server}` and calls `server()`; OpenCode 2 decodes
it as `{id, setup}` and ignores `server()`. Both halves share one routing
policy (chains, cooldowns, failure dedup, chain resolution, replay
orchestration); only the integration boundary differs.

The TypeScript runtime targets the OpenCode plugin server API, which passes a
main `@opencode-ai/sdk` client in `PluginInput.client`.

- `session.messages({ path: { id } })` returns `{ info: Message, parts: Part[] }[]`.
- `session.prompt({ path: { id }, body })`, `session.abort({ path: { id } })`, and `session.revert({ path: { id }, body })` use the documented main SDK request envelope.
- Streaming token arrival is `message.part.updated`; the session id is read from `event.properties.part.sessionID`.
- `chat.params.output.options.fallback_models` is deleted before OpenCode calls provider-specific option transforms.

Under OpenCode 2 the plugin context replaces the client argument:

- Chains load once from `ctx.options` (the native plugins object options).
  The legacy `agent.<name>.options` migration scan has no config hook to read
  under V2, so options are the only V2 chain source.
- `ctx.session.hook("context")` replaces `chat.message`: turn-guard clear,
  TTFT arm, availability preflight, and preemptive skip run unchanged. The
  context hook's model is readonly, so a preemptive redirect is applied to
  subsequent requests with `ctx.session.switchModel`. The return to the
  original model works the same way: once the original's cooldown ends, the
  next context hook that arrives on the fallback rung is redirected back and
  applied through `switchModel`; a failed switch restores the routing state
  (currentModel, originalModel, fallbackDepth, lastFallbackAt) together with
  the request model, so the bookkeeping keeps naming the rung that really
  serves. The return shares one admission predicate with every redirect
  scan — while the original is cooling, blocked, or vetoed, the session
  stays on its current rung. The host resolves the request model before the
  context hook runs and never re-reads it, so the request whose hook
  observed the original admissible still serves the fallback: the return
  takes over from the next agent-loop request. That request's model is
  therefore what `lastServedModel` records for every context hook — a
  model-less failure (TTFT timeout) on it cools the fallback that served,
  never the recovered original. Redirect and recovery events log only after
  `switchModel` resolves; a rejected switch logs
  `routing.redirect_apply_failed` and no `preemptive.redirected` or
  `fallback.recovered` event.
- `ctx.session.hook("retry")` is the single classified failure entrance,
  replacing the `session.error` / `session.status` / `message.updated` event
  paths. When OMR owns recovery (a chain exists and the exhaustion guard
  will not suppress the replay) and the chain advanced, it approves exactly
  one host retry at a short delay — the host re-drives the agent loop on the
  session's switched model, which is the V2 replay. A subagent
  short-circuit vetoes the host retry (the parent respawns the child); every
  other outcome leaves OpenCode's retry policy standing. The attempt number
  joins the failure fingerprint so consecutive host retries classify as
  distinct failures.
- `ctx.event.subscribe` maps V2 `session.text.delta` to TTFT clear and handles
  cleanup (`session.deleted`). V2 events are not fed into the failure
  pipeline — a second entrance would bypass failure dedup and duplicate
  replay.
- The replay tail advances once via `ctx.session.switchModel(next)` and never
  interrupts on the classified-failure entrance: verified against
  opencode v2.0.14, `interrupt({resume: true})` does not re-drive a settled
  turn, and the approved host retry re-drives the loop. V2 has no revert, and
  re-prompting would duplicate the user turn, so the V1
  abort → revert → prompt sequence never runs under V2.
  `interrupt({resume: false})` is used only to abort a subagent child for its
  terminal handoff.
- A TTFT timeout is the one entrance whose failed request stays IN FLIGHT —
  the retry hook never fires for a hang. There the tail also issues
  `interrupt({resume: true})` after the switch: the stalled request is
  aborted and the hung turn ends instead of pinning the session forever,
  leaving the session anchored on the healthy rung for the next turn. A tail
  rejection (switch or interrupt) leaves the fallback bookkeeping unadvanced,
  so a recovery that did not happen is never reported as success. Verified
  against opencode v2.0.14 (2026-09-22 stall fixture): the host still does
  not re-drive the aborted turn in-run, and completing it would require
  re-prompting (rejected — it duplicates the user turn), so in-run TTFT turn
  completion remains an upstream limitation.

### V2 package loading contract

OpenCode 2 resolves a directory-form plugin entry through `<dir>/server` or
`<dir>/index` (Bun `resolveSync`) and does not consult package.json
`exports` for that shape, so the package ships a root `index.js` re-exporting
`dist/index.js` — without it, a directory entry naming the package is
silently skipped. The package also declares `@opencode/plugin` as a
dependency (the published-plugin requirement); the runtime bundle never
imports it, but the V2 loader must resolve it from the installed package
tree. These contracts are pinned by `plugin/test/v2-installed-package.test.ts`
and verified live by `scripts/e2e-v2-runtime.sh`.

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
