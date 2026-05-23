# Executive Summary

## Outcome

Fixed OMR plugin live startup by changing the runtime export surface from a legacy plugin function plus named helpers to a V1 OpenCode plugin module object. The deployed runtime now exposes only `default`, and that default is `{ id, server }`.

## Verdict

READY

## What Was Built

1. Added runtime export-surface contract test proving the current multi-function export bug, then verifying the fixed V1 shape.
2. Split `plugin/src/plugin.ts` runtime entry from testable internals in `plugin/src/plugin-internal.ts`.
3. Replaced runtime entry with default V1 module object: `id: "@sharper-flow/opencode-model-routing-plugin"`, `server` function.
4. Updated plugin behavior tests to import internal helpers and exercise runtime hooks through `pluginModule.server`.
5. Deployed the rebuilt plugin locally and enabled OMR in global OpenCode config.
6. Hardened the V1 server boundary with a structural PluginInput guard and removed a no-op microtask yield.

## What Was Verified

- `make build-plugin` passed.
- `make test` passed: Go tests plus 92 plugin tests.
- `make lint` passed.
- `./scripts/deploy-local.sh --dry-run` passed.
- `make deploy-local` passed.
- Built export inspection returned `keys:["default"]`, `defaultKeys:["id","server"]`.
- `./scripts/deploy-local.sh --check` confirmed OMR plugin registered.
- Live `opencode models` exited 0 with OMR enabled.
- Live log `/home/jon/.local/share/opencode/log/2026-05-23T045626.log` loaded `file:///home/jon/.local/share/opencode-model-routing/plugin` and had no `O.config` / `r.provider` startup failures.
- Hardening scanners completed; validated findings fixed and re-verified.
- Contract matrix: 21/21 rows passed/respected.
- Merge compatibility with `origin/main` passed.

## Remaining Concerns

None blocking. OMR live proof passed; OMP removal is logged as follow-up agenda item `ag-Dg3b1ldW`.