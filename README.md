# opencode-model-routing

OpenCode model routing: per-agent model preferences and runtime fallback chains.

> **⚠ Work in progress.** This repository is the successor to
> [`JRedeker/opencode-model-preferences`](https://github.com/JRedeker/opencode-model-preferences).
> It currently contains the imported `omp` TUI source from that project and is
> being restructured into a monorepo with two artifacts:
>
> - `omp` — Go TUI for authoring per-agent model preferences and fallback chains
> - `plugin/` — TypeScript OpenCode plugin that consumes the schema at runtime
>   to provide ordered fallback, conservative TTFT timeout, and preemptive skip
>   of known-unhealthy models
>
> Documentation, install instructions, and usage will be written as part of
> the active ADV change.

## Schema Contract

The per-agent fallback chain lives at `agent.<name>.options.fallback_models`
inside OpenCode's global `opencode.json`. The shape, allowed value pattern,
and length cap are defined in [`schema/fallback-schema.json`](./schema/fallback-schema.json).

Both the Go writer (`internal/config/`) and the TypeScript plugin reader
(`plugin/src/` — added in a later phase) reference the field name verbatim.
The `schema-contract-check.sh` script (wired into `make lint`) enforces this
cross-stack contract; renaming the field on one side without updating the
other will fail CI.

Why `options.fallback_models` rather than a top-level sibling key: OpenCode's
`AgentConfig` schema runs a `normalize()` transform that relocates any
non-allow-listed sibling key into `options`. Writing directly to the `options`
extension slot matches the documented contract rather than relying on the
transform side-effect. See [`design.md`](./.adv/...) § D1 for the upstream
source citation.

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

`omp` treats `opencode.json` as sensitive because it can contain provider API
keys and other credentials. Mutations write the file with owner-only
permissions (`0600`). Before `ApplyPreferences` changes the file, it writes a
timestamped backup beside it (`opencode.json.omp-backup.<timestamp>`); after a
successful apply, only the 5 most recent backups are retained.

## Installation

### omp (Go TUI)

```sh
make build       # builds the omp binary
make install     # copies omp to ~/.local/bin/ (no git hook side-effects)
```

`make install` no longer touches `.git/hooks/`. To enable the optional pre-push
hook that runs `make build && make test` before each push, run:

```sh
make install-hooks
```

### Plugin (TypeScript)

The runtime fallback plugin lives in [`plugin/`](./plugin). Local development
uses a stable deployed copy so OpenCode does not load directly from the mutable
dev checkout.

```sh
make build-plugin  # installs deps (frozen lockfile) + typechecks
make deploy-local  # copies plugin/ to ~/.local/share/opencode-model-routing/plugin
```

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
| `make build` | Builds the `omp` Go binary. |
| `make build-plugin` | Installs plugin deps (frozen lockfile) and typechecks. |
| `make deploy-local` | Deploys the plugin to `~/.local/share/opencode-model-routing/plugin` and validates OpenCode config. |
| `make install` | Installs `omp` to `~/.local/bin/`. Does NOT touch git hooks. |
| `make install-hooks` | Installs the optional pre-push hook (build + test + deploy-local). |
| `make test` | Runs both Go and plugin test suites. |
| `make test-go` | Go tests only. |
| `make test-plugin` | Plugin tests only (`bun test`). |
| `make lint` | Go vet, schema-contract-check, plugin typecheck. |
| `make clean` | Removes `omp` binary and `plugin/node_modules`, `plugin/dist`. |

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Acknowledgments

The runtime plugin architecture draws on
[`Smart-Coders-HQ/opencode-model-fallback`](https://github.com/Smart-Coders-HQ/opencode-model-fallback)
(Apache-2.0). See [NOTICE](./NOTICE) for attribution.
