# Build model fallback monorepo

## Background

`JRedeker/opencode-model-preferences` (now imported as `Sharper-Flow/opencode-model-routing`) provides `omp`, a Go TUI for authoring per-agent model preferences in OpenCode by writing static `agent.<name>.model` entries into `~/.config/opencode/opencode.json`.

It does not address what happens when the configured model becomes unavailable, rate-limited, exhausted, or unresponsive. Users currently must manually switch models in OpenCode or wait out the failure. OpenCode core does not natively support model fallback arrays as of investigation date (multiple open feature requests: sst/opencode #7602, #8687, #9575, #20098, #1267; PR #8669 unmerged).

Three OpenCode plugins implement runtime fallback today (`razroo/opencode-model-fallback`, `Smart-Coders-HQ/opencode-model-fallback`, `arisgrout/opencode-runtime-fallback`), confirming the OpenCode plugin API (`@opencode-ai/plugin`) exposes sufficient hooks (`chat.message`, `event` with `session.status` / `session.error`) for fallback without patching OpenCode core.

The imported codebase also carries hygiene debt from its original repo: no LICENSE (now corrected by GH on the new repo), `go.mod` module path mismatch (`sharperflow/opencode-model-preferences` vs new identity), an auto-installing pre-push hook bundled with `make install` that masks supply-chain changes, ~13 months stale dependencies, 7 warning-severity lint findings, and an `ApplyPreferences` path that mutates `opencode.json` without prior backup.

## Problem Statement

Users of `omp` cannot express "use model A for agent X, but fall back to model B (then C) if A is unavailable." The single static `model` field is the only authoring surface, and OpenCode core does not act on fallback arrays even if they were written. Additionally, the imported codebase has hygiene gaps (license clarity, module identity, opt-in for auto-rebuild hooks, dep freshness, error-handling completeness, destructive-write safety) that should be resolved before adding new functionality on top.

## Success Criteria

1. **Fallback authoring**: `omp` lets a user assign an ordered list of one-or-more `provider/model` pairs to a single agent or sub-agent in its TUI. Empty list = no fallback (same as today's behavior). Single-entry list = behaves identically to today's single-model assignment.

2. **Fallback runtime**: A TypeScript OpenCode plugin in this repo's `plugin/` directory reads the schema `omp` writes and, at session time, transparently advances through the configured pairs when the active pair fails. The user does not need to restart OpenCode or manually switch models for the rotation to take effect.

3. **Three trigger surfaces, all conservative defaults**:
   - **Errors**: explicit provider failures (rate-limit 429, quota exhaustion, 5xx, model-not-found, transient 403 from gateways)
   - **TTFT timeout**: if no tokens arrive within a conservative configurable window (default 60 seconds) the active pair is aborted and the next pair is tried. Once streaming has begun, TTFT no longer applies (no mid-stream interruption).
   - **Preemptive skip**: when a pair is known to be unhealthy (within a configurable cooldown window after a recent failure), the next message starts on the next-healthy pair without attempting the unhealthy one.

4. **Hygiene corrections completed in the same change**:
   - `go.mod` module path matches the canonical hosting (`github.com/Sharper-Flow/opencode-model-routing` or the agreed final identity)
   - LICENSE is Apache-2.0 (already in place from GH init)
   - NOTICE file credits derivative-source plugins (already in place)
   - `make install` no longer auto-installs the pre-push hook; hook becomes opt-in via separate `make install-hooks` target with documented intent
   - Dependencies refreshed (`go mod tidy` against current bubbletea/lipgloss/etc; npm deps in plugin/ pinned to current `@opencode-ai/plugin` and `@opencode-ai/sdk` releases)
   - The 7 existing warning-severity lint findings in `internal/config/` are resolved (unhandled errors logged or propagated; nil-map declarations clarified)
   - `ApplyPreferences` writes a timestamped backup of `opencode.json` to a recoverable location before mutating

5. **Monorepo coexistence**: Go binary (`omp`) and TypeScript plugin (`plugin/`) build, test, and version independently within one repository. Top-level Makefile orchestrates both. Schema contract between them is documented and lives in a single canonical location consumed by both.

6. **No OpenCode patching**: the entire solution operates through the public `@opencode-ai/plugin` API and configuration files. No fork, no patch, no proxy.

## Out of Scope

- Patching, forking, or shimming OpenCode itself
- Building or maintaining a provider-protocol proxy (LiteLLM-style daemon that re-encodes between providers' wire formats)
- Cost-based routing decisions, spend caps, token budgeting beyond what fallback already implies (out-of-tokens is treated identically to rate-limit)
- A TUI for editing the runtime plugin's standalone behavior parameters (TTFT threshold, cooldown windows). v1 ships sensible defaults and a config file; UI integration is a follow-up.
- Cross-session health sharing or persistent health state across OpenCode restarts. v1 keeps health tracking in-memory per session.
- Inter-token gap detection (stall-mid-stream). v1 only enforces time-to-first-token.
- Compaction-aware fallback (replaying `/compact` failures on the next model). v1 documents this as an explicit limitation; existing third-party plugins handle it via OpenCode-specific compaction events that we may add post-v1.
- Migration tooling from the third-party plugin schemas (`razroo`, `Smart-Coders-HQ`, `arisgrout`). v1 documents differences; migration is manual.

## Constraints

- **Apache-2.0 license** for the whole repository, matching the LICENSE created by GH init and the derivative-source `Smart-Coders-HQ/opencode-model-fallback` license. NOTICE file credits derivative sources without per-file headers.
- **TypeScript plugin** must use `@opencode-ai/plugin` and `@opencode-ai/sdk` published packages. No private/internal OpenCode APIs.
- **Go binary** stays on the existing charmbracelet bubbletea/lipgloss stack and tidwall gjson/sjson for jsonc-safe writes.
- **Schema source of truth**: a single JSON schema document defines the shape of the fallback config. Both `omp` (writer) and `plugin/` (reader) reference it. Drift between writer and reader is a defect.
- **opencode.json destructive-write safety**: `ApplyPreferences` MUST write a timestamped backup before any mutation. Backup location is recoverable without TUI assistance.
- **No silent fallback at apply time**: if `omp` is given an invalid `provider/model` pair in a chain, the TUI surfaces the validation error rather than writing it through.
- **Conservative TTFT**: default 60 seconds. Configurable. Streaming-safe (no mid-stream interruption).
- **No additional system services**: the runtime plugin loads in-process with OpenCode. No long-lived daemon, no proxy, no separate auth surface.
- **No conformance lock yet**: this is the founding change for the repo. Conformance gating starts with the *next* change that touches finalized specs.

## Acceptance Criteria

- A user can open `omp`, select a sub-agent (e.g. `adv-researcher`), assign a primary pair (e.g. `anthropic/claude-sonnet-4-5`) and one or more fallback pairs (e.g. `openai/gpt-5`, `google/gemini-2.5-pro`), and apply.
- After apply, `opencode.json` contains the primary `model` (single-pair backward compatibility) plus a documented field for the ordered fallback chain (exact field name decided in design).
- A backup of pre-apply `opencode.json` exists at a documented recoverable path.
- Loading the new repo's plugin in OpenCode via the `plugin` array activates fallback behavior for any agent with a fallback chain.
- Simulated failure on the primary pair (test fixture: provider returns 429) causes the plugin to retry the same user message on the next pair without user intervention.
- TTFT timeout test: with a mock pair that never returns a token, the plugin aborts after the configured threshold (default 60s) and advances to the next pair. With a mock pair that returns a token within threshold but then takes longer to complete, no abort fires.
- Preemptive skip test: after a pair returns 429, a subsequent message in the cooldown window starts on the next pair without retrying the cooled pair.
- `make install` no longer touches `.git/hooks/pre-push`. A separate target `make install-hooks` (or equivalent) installs it explicitly, with documentation stating what the hook does.
- `go install github.com/Sharper-Flow/opencode-model-routing/cmd/omp@latest` succeeds (i.e. module path matches hosting).
- `go vet ./...` and the 7 documented warning-severity lint findings: zero remaining.
- All existing omp tests pass; new plugin/ tests pass; no skipped or pending tests on the main branch.
