# opencode-model-routing

Model routing for [OpenCode](https://opencode.ai): give every agent a primary
model plus an ordered fallback chain, and keep sessions alive when a provider
fails.

The repository ships two artifacts that share one schema contract:

- **`omr`** — a Go TUI for authoring OpenCode routing stacks: a primary model
  plus an ordered fallback chain per OpenCode target (agent, sub-agent, or
  provider ADV variant).
- **`plugin/`** — a TypeScript OpenCode plugin that reads that config at
  runtime and rotates to the next healthy model on errors, 429/quota
  exhaustion, or a conservative time-to-first-token timeout. It also
  preemptively skips models that are cooling down or explicitly blocked.

Both halves reference the field names `fallback_models` and `blocked_models`
verbatim; `make lint` runs `schema-contract-check.sh`, which fails if either
side drifts.

## What the plugin does

Once enabled, the plugin sits in the request path and acts on three triggers:

| Trigger | Action |
|---|---|
| Session error (rate limit, server error, auth, quota, unknown model) | Rotate to the next healthy chain entry and replay the turn. |
| No first token within the TTFT window (default 60 s) | Abort the stuck request and rotate. |
| Model currently cooling down or blocked | Preemptively redirect to the first healthy, non-blocked chain entry before the request is sent. |

Recovery details:

- **Context preservation** (default on): work the failing model already
  completed mid-turn is summarised and prepended to the re-prompt, so the next
  model continues instead of restarting from the bare user message.
- **Category-aware cooldowns**: quota exhaustion cools a model for 10 minutes,
  auth and rate-limit failures for 30 minutes, everything else for the 5-minute
  default. Cooldowns are shared across processes through a cooldown file, so a
  fresh OpenCode session does not immediately re-probe a dead model.
- **Sub-agent aware**: a failing sub-agent is marked unhealthy and the parent's
  replacement hits the preemptive redirect path instead of a mid-turn replay.
- **Fail-soft**: when every alternative is blocked or cooling, the plugin logs
  `preemptive.no_allowed_model` and leaves the selection unchanged rather than
  killing the session.

The `omr-cooldown` CLI (shipped with the plugin) inspects and clears cooldowns:

```sh
omr-cooldown list                  # active cooldowns
omr-cooldown status --model openai/gpt-5
omr-cooldown reset --model openai/gpt-5
omr-cooldown list --json           # machine-readable output
```

## Prerequisites

| Tool | Needed for | Version |
|---|---|---|
| Go | `omr` build and tests | ≥ 1.24 (`go.mod`) |
| Bun | plugin build, tests, and runtime-dep install | 1.3+ (`packageManager: bun@1.3.14`) |
| Node | plugin engine requirement | ≥ 24 (`engines` in `plugin/package.json`) |
| jq, rsync | `make deploy-local` config validation and deploy | any recent |
| OpenCode | the thing being routed | — |

`omr` discovers models through the `opencode models` CLI, so keep `opencode`
on your `PATH`.

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

Each OpenCode target is shown as a routing stack. Key bindings:

| Key | Action |
|---|---|
| `enter` / `m` | Choose the primary model for the selected target |
| `d` | Clear the selected target's model |
| `D` | Clear all sub-agent overrides |
| `e` | Toggle a provider ADV variant |
| `f` | Edit the fallback chain |
| `J` / `K` | Reorder fallback entries (in the chain editor) |
| `enter` / `d` | Add or remove a chain entry (in the chain editor) |
| `a` | Preview config changes, then confirm apply |
| `q` / `esc` | Quit |

`make install` never touches `.git/hooks/`. To enable the optional pre-push
hook that runs `make build && make test` and redeploys the plugin on each
push, run:

```sh
make install-hooks
```

### Plugin (TypeScript)

The runtime plugin lives in [`plugin/`](./plugin). Local development deploys a
stable, package-shaped copy (`package.json`, `dist/`, notice files) so
OpenCode loads the same bundled runtime shape as a packaged install:

```sh
make build-plugin  # installs deps (frozen lockfile), typechecks, and builds plugin/dist
make deploy-local  # deploys bundled runtime to ~/.local/share/opencode-model-routing/plugin
```

`make deploy-local` verifies the bundle before writing the local-share copy.
Restart OpenCode after deploy; running sessions keep the plugin code loaded at
startup. Set `OMR_LOCAL_DEPLOY_ROOT` to override the default local deploy
root.

### Enable in OpenCode

Add the deployed plugin path to your global `opencode.json` / `opencode.jsonc`
(see [Configuration](#configuration) for the full option shape):

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

## Configuration

### Where chains live

The per-agent fallback chain and blocked-model set live in the OMR plugin
tuple options inside OpenCode's global config. The shape, allowed value
pattern, and length caps are defined in
[`schema/fallback-schema.json`](./schema/fallback-schema.json) (chains up to 8
entries, blocklists up to 16).

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

Why plugin options rather than `agent.<name>.options.fallback_models`:
OpenCode merges `agent.options` into model/provider options before LLM
execution, then wraps those options differently per provider family.
OMR-owned routing metadata must not be stored in that provider-options field.
The plugin also strips legacy `fallback_models` from
`chat.params.output.options` defensively before provider transform.

`omr` writes this shape for you. It stores your preferences in
`omr-preferences.json` (in the OpenCode config dir, respecting
`OPENCODE_CONFIG_DIR`) and applies routing changes into the global config
through a previewed, backed-up write — see [Config write
safety](#config-write-safety).

### Blocked models

`agents.<name>.blocked_models` lists exact `provider/model` keys the plugin
must never select for that agent — for example a metered model you want kept
away from one agent but available to the others. Keys may name models outside
the fallback chain, such as a user-selected primary.

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

With that config:

- a dispatch starting on `anthropic/claude-sonnet-4-5` or `minimax/token-plan`
  is redirected to `openai/gpt-5` (first healthy non-blocked entry);
- if `openai/gpt-5` later fails, rotation lands on `google/gemini-2.5-pro`;
- if both chain entries are unavailable, the session stays on its current
  model with a `preemptive.no_allowed_model` warn log.

Matching is exact-key only; patterns and model classes are intentionally not
supported. `blocked_models` has no legacy `agent.options` path — it is
plugin-tuple-only.

### Legacy migration

Legacy `agent.<name>.options.fallback_models` is still read as a migration
fallback and removed by `omr` when it writes the plugin-owned option. A
hand-edited top-level `agent.<name>.fallback_models` sibling is also read,
with a one-time deprecation log line per agent.

### Agent markdown frontmatter

Markdown agent files may declare a chain in either YAML list form:

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

### Tuning the plugin

Plugin behaviour knobs live beside `agents` in the same tuple option. Defaults
are deliberately conservative (`plugin/src/types.ts`):

```jsonc
[
  "/home/you/.local/share/opencode-model-routing/plugin",
  {
    "agents": { /* ... */ },
    "ttftMs": 60000,
    "cooldownMsByCategory": { "rate_limit": 1800000 }
  }
]
```

| Option | Default | Meaning |
|---|---|---|
| `ttftMs` | `60000` | Time-to-first-token window in ms; on expiry the request is aborted and rotated. |
| `cooldownMs` | `300000` | Default cooldown window in ms after a failure. |
| `cooldownMsByCategory` | see below | Per-category overrides; `rate_limit` and `auth_error` get 30 min, `quota_exhausted` 10 min. |
| `maxDepth` | `3` | Max fallback depth per session (prevents infinite cascades). |
| `dedupWindowMs` | `3000` | Collapses fallback triggers within this window for the same session. |
| `abortWaitMs` | `150` | Pause between `abort()` and `revert()` in ms. |
| `preserveContext` | `true` | Summarise completed mid-turn work into the re-prompt on rotation. |

### Cooldown state

Cooldowns are stored in a shared file so all OpenCode processes agree on which
models are unhealthy:

```text
~/.local/share/opencode-model-routing/cooldown.json
```

Set `OPENCODE_MODEL_ROUTING_COOLDOWN` to move the file. Cooldowns never
contain credentials; the file lists model keys, expiry timestamps, and failure
categories.

## Config write safety

`omr` treats the OpenCode config file as sensitive because it can contain
provider API keys. Writes are guarded at three layers:

- Every mutation writes the file with owner-only permissions (`0600`) and an
  atomic write.
- Before `ApplyPreferences` changes the file, it writes a timestamped backup
  beside it (`opencode.json.omr-backup.<timestamp>`); after a successful
  apply, only the 5 most recent backups are retained.
- The TUI shows a preview generated from the same pure `ApplyPlan` used by the
  write path; nothing is written until you confirm.

## Make targets

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

`scripts/deploy-local.sh` also accepts `--check` (report config drift without
writing), `--fix`, and `--dry-run` (preview deploy/patch actions).

## Verification

```sh
make lint    # go vet, cross-stack schema contract check, plugin typecheck
make test    # Go suite + bun plugin suite
./scripts/e2e-smoke.sh   # end-to-end writer→reader contract on plugin tuple options
```

The schema contract test is the guardrail that keeps the Go writer
(`internal/config/`) and the TypeScript reader (`plugin/src/`) in agreement:
if either side stops referencing `fallback_models` or `blocked_models`,
`make lint` fails.

## Repository layout

```text
cmd/omr/            omr entrypoint
internal/config/    Go writer: preferences, apply plans, atomic writes, backups
internal/tui/       Bubble Tea TUI (routing stacks)
plugin/src/         TypeScript runtime plugin (hooks, resolution, replay, state)
plugin/test/        bun test suite
schema/             fallback-schema.json — canonical field contract
scripts/            deploy-local.sh, e2e-smoke.sh
```

Design details live in [`docs/specs/model-preferences-routing.md`](./docs/specs/model-preferences-routing.md)
and [`docs/opencode-contract-research.md`](./docs/opencode-contract-research.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Acknowledgments

The runtime plugin architecture draws on
[`Smart-Coders-HQ/opencode-model-fallback`](https://github.com/Smart-Coders-HQ/opencode-model-fallback)
(Apache-2.0), and the project grew out of
[`JRedeker/opencode-model-preferences`](https://github.com/JRedeker/opencode-model-preferences).
See [NOTICE](./NOTICE) for attribution.
