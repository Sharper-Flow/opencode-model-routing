# Archive: Fix plugin packaging

**Change ID:** fixPluginPackaging
**Archived:** 2026-05-23T04:24:01.040Z
**Created:** 2026-05-23T02:20:09.081Z

## Tasks Completed

- ✅ Add bundled plugin package contract
  > Added tsup-based bundle configuration, changed plugin package runtime metadata to dist/index.js/dist/index.d.ts with exports for `.` and `./server`, moved OpenCode packages to devDependencies, added package lifecycle scripts and package contract tests, and updated bun.lock. Verified package contract test, build, and typecheck.
- ✅ Fix OpenCode event hook boundary and guards
  > Added wrapper-path test for default plugin event hook using canonical OpenCode `{ event }` payload, implemented narrow boundary normalization for event hooks, retained undefined no-op behavior, removed speculative loader workaround narrative from runtime source, and verified plugin tests/typecheck.
- ✅ Wire Makefile build-plugin to typecheck and bundle
  > Extended Makefile contract test to require `make build-plugin` to run both typecheck and bundle build, then updated `build-plugin` target to run `bun install --frozen-lockfile && bun run typecheck && bun run build`. Verified contract script and full `make build-plugin`.
- ✅ Harden deploy-local around bundled runtime artifact
  > Added deploy-local runtime bundle verification for dist JS/types and package metadata, changed deploy to write a package-shaped runtime tree (`package.json`, `dist/`, optional NOTICE) instead of rsyncing raw source, improved dry-run messaging, and extended Makefile contract tests. Verified missing-bundle failure and successful dry-run verification.
- ✅ Update README with fixed plugin build/deploy path
  > Updated README plugin documentation to describe bundled dist runtime, package-shaped deploy, `make build-plugin` build behavior, and OpenCode restart requirement. Avoided workaround-focused docs. Verified contract script and README search for workaround language.
- ✅ Run final packaging compatibility verification
  > Task checkpoint completed

## Specs Modified


## Wisdom Accumulated

- **[pattern]** For OpenCode plugin package fixes, make package metadata a tested contract: assert `main`, `types`, `exports['.']`, `exports['./server']`, and lifecycle scripts in Bun tests before changing package.json. This gives clean RED/GREEN evidence for packaging-only changes.
- **[success]** Final packaging verification should include both positive and negative deploy paths: build/test/typecheck plus `deploy-local --dry-run` success and a temporary missing-bundle failure check. This proves deploy refuses broken runtime artifacts without mutating the real local-share plugin.
- **[pattern]** Release hardening for plugin host boundaries should convert `unknown` hook payloads to typed handlers through small runtime validators, not direct casts. Keep malformed payloads as no-op compatibility inputs and add tests that exercise the default plugin hook wrapper, not only internal handlers.
