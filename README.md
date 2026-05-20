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

## Installation

```sh
make build       # builds the omp binary
make install     # copies omp to ~/.local/bin/ (no git hook side-effects)
```

`make install` no longer touches `.git/hooks/`. To enable the optional pre-push
hook that runs `make build && make test` before each push, run:

```sh
make install-hooks
```

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Acknowledgments

The runtime plugin architecture draws on
[`Smart-Coders-HQ/opencode-model-fallback`](https://github.com/Smart-Coders-HQ/opencode-model-fallback)
(Apache-2.0). See [NOTICE](./NOTICE) for attribution.
