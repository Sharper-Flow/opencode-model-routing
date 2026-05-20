# Design: Build model fallback monorepo

## Architecture Overview

The repository contains two cooperating components:

1. **Go authoring surface (`omp`)** — discovers OpenCode agents/sub-agents, lets users assign primary and fallback model chains, validates `provider/model` values, and writes `opencode.json` safely.
2. **TypeScript runtime plugin (`plugin/`)** — loads through OpenCode's public plugin API, reads the same fallback schema from `opencode.json`, and performs runtime fallback through `chat.message` and event hooks.

The schema boundary is `agent.<name>.options.fallback_models`. `agent.<name>.model` remains the primary model for backward compatibility. `options.fallback_models` stores ordered fallback entries after the primary. OpenCode's `AgentConfig.normalize()` relocates unknown sibling keys into `options`, so writing directly to `options` is the structurally-correct extension point.

## Key Decisions

### D1 — Config shape

Canonical path: `agent.<name>.options.fallback_models`.

Rationale: direct inspection of `sst/opencode/packages/opencode/src/config/agent.ts` showed allowlisted top-level agent keys and a `normalize()` transform that moves unknown sibling keys into `options`. The design therefore avoids relying on relocation side effects and writes the documented extension slot directly.

### D2 — Shared schema

`schema/fallback-schema.json` defines fallback array item pattern, min/max constraints, and documentation for the canonical JSON path. Go and TypeScript code reference the same field name constants / schema documentation; `schema-contract-check.sh` guards drift.

### D3 — Go data model and apply path

- `Target.FallbackModels []string` stores discovered chain state.
- `PreferencesConfig.TargetFallbacks map[string][]string` stores desired writes.
- `ApplyPreferences` writes `agent.<name>.model` plus `agent.<name>.options.fallback_models`, preserves existing `options.*`, and clears `fallback_models` when the desired chain is empty.
- Writes are backup-first and atomic.

### D4 — TUI authoring

The TUI shows fallback chain count in assignment rows and provides a focused fallback editor for add/remove/reorder. Validation uses existing model mapping checks plus schema constraints.

### D5 — Plugin loading and config parsing

The plugin reads `agent.<name>.options.fallback_models` from OpenCode config. It also defensively reads legacy sibling `agent.<name>.fallback_models` and emits a one-time deprecation log if encountered.

### D6 — Runtime fallback triggers

- `session.error` is the primary error signal.
- `session.status` retry events and text-part scanning are secondary/tertiary conservative detection layers.
- TTFT timer starts when a prompt attempt begins and clears only when first stream content arrives.
- Preemptive skip occurs in `chat.message` when the current model is inside cooldown.

### D7 — Replay sequence

Fallback replay sequence is `abort()` → approximately 150ms wait → `revert()` → `prompt()` with the next fallback model, preserving the original user message parts. A per-session mutex and short dedup window prevent concurrent/double fallback cascades.

### D8 — State and limits

Health/cooldown state is in-memory only. Defaults: TTFT 60s, cooldown 5 minutes, max fallback depth 3. Fallback depth resets when the user manually changes model so manual TUI action becomes a fresh intent.

### D9 — Monorepo packaging

Top-level Makefile orchestrates Go and plugin build/test/lint. `plugin/` owns its own package metadata, TypeScript config, and tests. Dependencies are exact-pinned to the verified OpenCode package versions.

## Independent Validator Outcome

The design validator returned `CAUTION` with two findings, both resolved before design gate completion:

1. The config path was corrected from sibling `agent.<name>.fallback_models` to `agent.<name>.options.fallback_models` after OpenCode source verification.
2. The alternative of using `Smart-Coders-HQ/opencode-model-fallback` verbatim was surfaced. User chose a new plugin with heavy borrowing and Apache-2.0 NOTICE attribution.

No unresolved `CONFLICT` remained at design completion.

## Review-Phase Amendments

During acceptance review, the user approved three additional in-scope hardening/parser amendments:

1. `ApplyPreferences` and `SetAgentOrder` write `opencode.json` with `0600` owner-only permissions.
2. `ApplyPreferences` prunes `.omp-backup.*` files after successful writes, keeping the 5 most recent backups.
3. Markdown frontmatter parsing supports both inline and multi-line YAML list forms for `fallback_models`.
