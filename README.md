# opencode-model-routing

OpenCode model routing: an OMR-native routing TUI plus runtime fallback plugin.

This repository ships two artifacts:

- `omr` — Go TUI for authoring OpenCode routing stacks: primary model plus
  ordered fallback chain per configurable target.
- `plugin/` — TypeScript OpenCode plugin that consumes the schema at runtime to
  provide ordered fallback, conservative TTFT timeout, and preemptive skip of
  known-unhealthy models.

## Schema Contract

The per-agent fallback chain and blocked-model set live in the OMR plugin
tuple options inside OpenCode's global `opencode.json`. The shape, allowed
value pattern, and length caps are defined in
[`schema/fallback-schema.json`](./schema/fallback-schema.json).

Both the Go writer (`internal/config/`) and the TypeScript plugin reader
(`plugin/src/`) reference the field names `fallback_models` and
`blocked_models` verbatim. The `schema-contract-check.sh` script (wired into
`make lint`) enforces this cross-stack contract; renaming a field on one side
without updating the other will fail CI.

Why plugin options rather than `agent.<name>.options.fallback_models`: OpenCode
merges `agent.options` into model/provider options before LLM execution, then
wraps those options differently per provider family. OMR-owned routing metadata
must not be stored in that provider-options field. The plugin also strips legacy
`fallback_models` from `chat.params.output.options` defensively before provider
transform.

Example:

```jsonc
{
  "plugin": [
    [
      "/home/you/.local/share/opencode-model-routing/plugin",
      {
        "agents": {
          "adv-researcher": {
            "fallback_models": ["openai/gpt-5", "google/gemini-2.5-pro"]
          }
        }
      }
    ]
  ]
}
```

Legacy `agent.<name>.options.fallback_models` is still read as a migration
fallback and removed by `omr` when it writes the plugin-owned option.

### Blocked models

`agents.<name>.blocked_models` lists exact `provider/model` keys the routing
plugin must never select for that agent — for example a model on a metered
plan you want kept away from one agent but available to the others. It is
declared beside the chain in the plugin tuple options and is plugin-tuple-only
(there is no legacy `agent.options` path for it). Keys may name models outside
the fallback chain, for instance a user-selected primary. The runtime plugin
enforces it at both selection points:

- Preemptive redirect (`chat.message`): when OpenCode is about to dispatch the
  agent on a blocked model, the plugin redirects to the first chain entry that
  is healthy and not blocked — regardless of the current model's cooldown
  state. When the agent identity cannot be resolved, the blocklist stays
  inactive (matching the existing anti-heuristic guard).
- Fallback rotation: the resolver scan skips blocked entries, so a blocked key
  inside a configured chain is never rotated onto.

When every alternative is blocked or cooled, the plugin logs
`preemptive.no_allowed_model` and leaves the selection unchanged — a hard
failure would kill the session for want of a model, so the misconfiguration is
surfaced in the log instead. Matching is exact-key only; patterns and model
classes are intentionally not supported. The `omr` writer carries the field
with the same validation (`internal/config`), and `schema-contract-check.sh`
enforces the field name on both stacks.

Worked example — `adv-researcher` falls back from `openai/gpt-5` to
`google/gemini-2.5-pro` but must never run on the metered Claude plan, and the
user-selected `minimax/token-plan` primary is also forbidden for this agent:

```jsonc
{
  "plugin": [
    [
      "/home/you/.local/share/opencode-model-routing/plugin",
      {
        "agents": {
          "adv-researcher": {
            "fallback_models": ["openai/gpt-5", "google/gemini-2.5-pro"],
            "blocked_models": [
              "anthropic/claude-sonnet-4-5",
              "minimax/token-plan"
            ]
          }
        }
      }
    ]
  ]
}
```

With that config: a dispatch starting on `anthropic/claude-sonnet-4-5` or
`minimax/token-plan` is redirected to `openai/gpt-5` (first healthy
non-blocked entry); if `openai/gpt-5` later fails, rotation lands on
`google/gemini-2.5-pro`; and if both chain entries are unavailable, the
session stays on its current model with a `preemptive.no_allowed_model` warn
log.

Markdown agent frontmatter may use either inline or multi-line YAML list form:

```yaml
---
fallback_models: ["openai/gpt-5", "google/gemini-2.5-pro"]
---
```

```yaml
---
fallback_models:
  - openai/gpt-5
  - google/gemini-2.5-pro
---
```

## Config write safety

`omr` treats `opencode.json` as sensitive because it can contain provider API
keys and other credentials. Mutations write the file with owner-only
permissions (`0600`). Before `ApplyPreferences` changes the file, it writes a
timestamped backup beside it (`opencode.json.omr-backup.<timestamp>`); after a
successful apply, only the 5 most recent backups are retained.

Before applying, the TUI shows a preview generated from the same pure
`ApplyPlan` used by the write path. Confirming the preview applies through the
existing backup, atomic-write, and owner-only permission safeguards.

## Installation

### omr (Go TUI)

```sh
make build       # builds the omr binary
make install     # copies omr to ~/.local/bin/ (no git hook side-effects)
```

Run the TUI with:

```sh
omr
```

In the TUI, each target is shown as a routing stack. Use `enter`/`m` to choose
the primary model, `f` to edit the fallback chain, `J`/`K` to reorder fallback
entries, `d` to remove entries, and `a` to preview config changes before
confirming apply.

`make install` no longer touches `.git/hooks/`. To enable the optional pre-push
hook that runs `make build && make test` before each push, run:

```sh
make install-hooks
```

### Plugin (TypeScript)

The runtime fallback plugin lives in [`plugin/`](./plugin). Local development
uses a stable deployed copy so OpenCode loads the same bundled runtime shape as
a packaged install: `package.json` points at `dist/index.js`, with declarations
and server exports generated during build.

```sh
make build-plugin  # installs deps, typechecks, and builds plugin/dist
make deploy-local  # deploys bundled runtime to ~/.local/share/opencode-model-routing/plugin
```

`make deploy-local` verifies the bundle before writing the local-share copy and
deploys the package-shaped runtime (`package.json`, `dist/`, and notice files),
not raw TypeScript source. Restart OpenCode after deploy; running sessions keep
the plugin code loaded at startup.

Set `OMR_LOCAL_DEPLOY_ROOT` to override the default local deploy root.

To enable in OpenCode, add the deployed plugin path to your `opencode.json`:

```jsonc
{
  "plugin": [
    [
      "/home/you/.local/share/opencode-model-routing/plugin",
      { "agents": {} }
    ]
  ]
}
```

Once published to npm, it can be loaded by name:

```jsonc
{
  "plugin": ["@sharper-flow/opencode-model-routing-plugin"]
}
```

### Make targets

| Target | Action |
|---|---|
| `make build` | Builds the `omr` Go binary. |
| `make build-plugin` | Installs plugin deps (frozen lockfile), typechecks, and builds `plugin/dist`. |
| `make deploy-local` | Deploys bundled plugin runtime to `~/.local/share/opencode-model-routing/plugin` and validates or patches OpenCode config with `--fix`. |
| `make install` | Installs `omr` to `~/.local/bin/`. Does NOT touch git hooks. |
| `make install-hooks` | Installs the optional pre-push hook, which runs build + test + deploy-local on push. |
| `make test` | Runs both Go and plugin test suites. |
| `make test-go` | Go tests only. |
| `make test-plugin` | Plugin tests only (`bun test`). |
| `make lint` | Go vet, schema-contract-check, plugin typecheck. |
| `make clean` | Removes the `omr` binary and `plugin/node_modules`, `plugin/dist`. |

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Acknowledgments

The runtime plugin architecture draws on
[`Smart-Coders-HQ/opencode-model-fallback`](https://github.com/Smart-Coders-HQ/opencode-model-fallback)
(Apache-2.0). See [NOTICE](./NOTICE) for attribution.
