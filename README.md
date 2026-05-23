# opencode-model-routing

OpenCode model routing: an OMR-native routing TUI plus runtime fallback plugin.

This repository ships two artifacts:

- `omr` — Go TUI for authoring OpenCode routing stacks: primary model plus
  ordered fallback chain per configurable target.
- `plugin/` — TypeScript OpenCode plugin that consumes the schema at runtime to
  provide ordered fallback, conservative TTFT timeout, and preemptive skip of
  known-unhealthy models.

## Schema Contract

The per-agent fallback chain lives at `agent.<name>.options.fallback_models`
inside OpenCode's global `opencode.json`. The shape, allowed value pattern,
and length cap are defined in [`schema/fallback-schema.json`](./schema/fallback-schema.json).

Both the Go writer (`internal/config/`) and the TypeScript plugin reader
(`plugin/src/`) reference the field name verbatim.
The `schema-contract-check.sh` script (wired into `make lint`) enforces this
cross-stack contract; renaming the field on one side without updating the
other will fail CI.

Why `options.fallback_models` rather than a top-level sibling key: OpenCode's
`AgentConfig` schema runs a `normalize()` transform that relocates any
non-allow-listed sibling key into `options`. Writing directly to the `options`
extension slot matches the documented contract rather than relying on the
transform side-effect.

Example:

```jsonc
{
  "agent": {
    "adv-researcher": {
      "model": "anthropic/claude-sonnet-4-5",
      "options": {
        "fallback_models": ["openai/gpt-5", "google/gemini-2.5-pro"]
      }
    }
  }
}
```

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
  "plugin": ["/home/you/.local/share/opencode-model-routing/plugin"]
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
