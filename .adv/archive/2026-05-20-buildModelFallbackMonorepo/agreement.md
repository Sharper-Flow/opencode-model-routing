# Agreement: Build model fallback monorepo

## Objectives

1. **Hygiene cleanup**: Bring the imported omp codebase to production quality — correct module identity, opt-in hooks, fresh dependencies, resolved lint findings, atomic config writes, and pre-mutation backup.

2. **Fallback authoring in omp**: Extend omp's data model, discovery, preferences schema, TUI, and apply path to support ordered fallback chains (`[primary, fallback1, fallback2, ...]`) per agent/subagent.

3. **Shared schema contract**: A single JSON schema document defines the fallback config shape. omp writes it; the plugin reads it. Drift between writer and reader is a defect.

4. **Runtime fallback plugin**: A TypeScript OpenCode plugin in `plugin/` that consumes the schema at session time, providing:
   - **Error-driven fallback**: provider failures (429, 5xx, model-not-found, quota, transient errors) trigger advancement to the next model in the chain
   - **TTFT timeout**: if no tokens arrive within 60 seconds (default, configurable), abort and try next model. Streaming-safe: once any token arrives, TTFT no longer applies
   - **Preemptive skip**: models in a cooldown window (default 5 minutes, configurable) after a failure are skipped on the next message attempt

5. **Monorepo packaging**: Go binary and TypeScript plugin build, test, and version independently within one repository. Top-level Makefile orchestrates both.

## Acceptance Criteria

### Hygiene

- [ ] `go.mod` module path is `github.com/Sharper-Flow/opencode-model-routing` and all 7 internal imports updated
- [ ] `make install` does NOT touch `.git/hooks/`. Separate `make install-hooks` target exists with documentation explaining what the hook does
- [ ] Pre-push hook calls `make build && make test`, not `make install`
- [ ] `go mod tidy` completes without changes (deps refreshed against current bubbletea/lipgloss/etc)
- [ ] `go vet ./...` passes clean; 0 remaining warning-severity lint findings in `internal/config/`
- [ ] `ApplyPreferences` writes a timestamped backup before mutation (path: `<configPath>.omp-backup.<timestamp>`)
- [ ] `ApplyPreferences` uses `writeFileAtomic` instead of `os.WriteFile` for crash safety
- [ ] `make test` target exists and runs `go test ./... -count=1`
- [ ] `make lint` target exists and runs `go vet ./...`
- [ ] `ApplyPreferences` and `SetAgentOrder` write `opencode.json` with owner-only permissions (`0600`) because the file can contain provider credentials
- [ ] After successful `ApplyPreferences`, timestamped `.omp-backup.*` files are pruned to keep the 5 most recent backups

### Fallback authoring

- [ ] `Target` struct has `FallbackModels []string` field
- [ ] `PreferencesConfig` has `TargetFallbacks map[string][]string` field
- [ ] `discoverTargets()` reads `fallback_models` from JSON config (`agent.<name>.options.fallback_models`) and from markdown frontmatter
- [ ] `discoverTargets()` supports markdown frontmatter `fallback_models` in both inline YAML list form (`["provider/model"]`) and common multi-line YAML list form (`fallback_models:\n  - provider/model`)
- [ ] `sanitizePreferences()` validates `TargetFallbacks` keys against `IsModelMappable()`
- [ ] TUI shows fallback chain count per target in the assignments view
- [ ] TUI provides a way to add, remove, and reorder fallback models for a selected target
- [ ] `ApplyPreferences` writes `agent.<name>.options.fallback_models` as a JSON array alongside `agent.<name>.model`
- [ ] `ApplyPreferences` clears `options.fallback_models` when a target's fallback chain is emptied
- [ ] `ApplyPreferences` preserves any existing sibling fields under `agent.<name>.options.*` when writing the fallback chain
- [ ] All existing tests continue to pass; new fallback CRUD tests cover read/write/sanitize/display

### Schema contract

- [ ] A single JSON schema file (e.g., `schema/fallback-schema.json`) defines the `fallback_models` field shape, valid value patterns, and constraints
- [ ] omp's Go code references this schema (or its documentation) for field naming and validation
- [ ] Plugin's TypeScript code references this schema (or its documentation) for field naming and parsing
- [ ] Schema drift between omp and plugin is a documented defect category
- [ ] Schema documentation calls out the canonical JSON path: `agent.<name>.options.fallback_models` (the `options` slot is OpenCode's documented extension surface; unknown sibling keys are relocated into it at config load time by `AgentConfig.normalize()`)

### Runtime plugin

- [ ] Plugin loads in OpenCode via `plugin` array in `opencode.json` (publishable as npm package or local path)
- [ ] Plugin reads `agent.<name>.options.fallback_models` from config via the `config` hook at initialization
- [ ] Plugin defensively reads `agent.<name>.fallback_models` as a transitional/legacy path and emits a one-time deprecation log line if found
- [ ] Plugin detects errors via `session.error` events (status-code classification) and `session.status` retry events (pattern matching on message text)
- [ ] Plugin implements preemptive redirect via `chat.message` hook (mutate `output.message.model` when current model is in cooldown)
- [ ] Replay sequence: `abort()` → wait ~150ms → `revert()` → `prompt()` with fallback model, preserving original message parts
- [ ] TTFT timeout: 60s default, configurable. Monitors first token arrival. Once streaming, no interruption.
- [ ] Cooldown: 5-minute default, configurable. Failed model marked unhealthy. Auto-recovery after window expires.
- [ ] Max fallback depth: 3 by default, configurable. Prevents infinite cascade.
- [ ] Per-session mutex prevents concurrent fallback triggers for the same session
- [ ] 3-second dedup window prevents stale event double-trigger
- [ ] Fallback depth resets when user manually changes model (TUI revert detection)
- [ ] Plugin logs fallback events to stderr (structured, no file logging in v1)
- [ ] Tests use mock-client pattern (following Smart-Coders-HQ approach) for all replay/error/preemptive scenarios

### Monorepo

- [ ] `plugin/` directory contains the TypeScript plugin with its own `package.json`, `tsconfig.json`, and `src/`
- [ ] Top-level `Makefile` has targets for: `build`, `install`, `build-plugin`, `test`, `lint`, `clean`
- [ ] `make test` runs both Go and TypeScript tests
- [ ] `go install github.com/Sharper-Flow/opencode-model-routing/cmd/omp@latest` succeeds
- [ ] README documents install for both omp binary and plugin, including the `options.fallback_models` config example

### Out of Scope (confirmed)

- Patching, forking, or shimming OpenCode core
- Provider-protocol proxy (LiteLLM-style daemon)
- Cost-based routing, spend caps, token budgeting
- TUI for editing runtime plugin parameters (TTFT threshold, cooldown)
- Cross-session health persistence (survives OpenCode restart)
- Inter-token gap detection (stall-mid-stream)
- Compaction-aware fallback
- Migration tooling from third-party plugin schemas
- Per-file attribution headers for derivative code

## Constraints

- Apache-2.0 license for whole repository. NOTICE file credits Smart-Coders-HQ/opencode-model-fallback. No per-file headers.
- TypeScript plugin uses only `@opencode-ai/plugin` and `@opencode-ai/sdk` published packages (currently v1.4.8 and v1.4.17 respectively). No private/internal OpenCode APIs.
- Go binary stays on charmbracelet bubbletea/lipgloss + tidwall gjson/sjson.
- opencode.json mutations MUST use `writeFileAtomic` and MUST create timestamped backup before any change.
- opencode.json writes MUST use owner-only permissions (`0600`) because the file can contain provider credentials.
- Timestamped `.omp-backup.*` files are retained only for the 5 most recent backups after successful `ApplyPreferences` writes.
- Conservative defaults: TTFT 60s, cooldown 5min, max depth 3.
- No additional system services: plugin runs in-process with OpenCode.
- Plugin version pinned to exact `@opencode-ai/plugin` and `@opencode-ai/sdk` versions (no ranges) due to API surface stability concerns noted in research.

## Architectural Decisions (from discovery)

| Decision | Choice | Rationale |
|---|---|---|
| Config location | `agent.<name>.options.fallback_models` inside `opencode.json` | OpenCode's `AgentConfig.normalize()` relocates unknown sibling keys into `options`; writing directly to `options` matches the documented extension slot rather than relying on transform side-effects (see Design § D1 for the source citation). Verified against `sst/opencode/packages/opencode/src/config/agent.ts` at 4702cdd. |
| Error detection | `session.error` (primary) + `session.status` retry events (secondary) + text-part scanning (tertiary) | Three-layer detection matches both reference plugins' approach; catches errors that bypass `session.error` |
| Preemptive mechanism | `chat.message` hook → mutate `output.message.model` | Confirmed working by Smart-Coders-HQ; avoids unnecessary API call on known-unhealthy model |
| Replay sequence | `abort() → 150ms wait → revert() → prompt()` | Canonical pattern from both reference plugins |
| Agent name resolution | Fetch from messages API, cache per session | `session.error` doesn't include agent in typed props; both reference plugins use this approach |
| Health tracking | In-memory per session, no persistence | Simplest v1; no cross-session state to manage |
| Test harness | Mock-client pattern | Proven by Smart-Coders-HQ; allows testing replay/error/preemptive without running OpenCode |
| Plugin config | Hardcoded defaults + optional config file (`.opencode/model-routing.json`) | Conservative TTFT/cooldown/depth overrides without TUI; config file is optional, defaults work out of box |

## Design-Phase Amendments (Phase 4.1)

Recorded 2026-05-20 during `/adv-design`. None constitute a compromise of the original objectives; both are technical corrections that strengthen structural correctness:

1. **Config path correction** — Original ACs referenced `agent.<name>.fallback_models` as a sibling key. The independent design validator surfaced — and direct inspection of `sst/opencode` confirmed — that OpenCode's `AgentConfig.normalize()` relocates non-allowlisted sibling keys into `options`. The canonical path is now `agent.<name>.options.fallback_models` on both writer and reader sides. All affected ACs above have been updated. No agreement objective is compromised; the corrected path is the structurally-correct realization of Objective 4 ("Plugin consumes the schema at session time").

2. **Reference plugin borrowing scope** — User explicitly confirmed during design phase that the new `plugin/` will heavily borrow from `Smart-Coders-HQ/opencode-model-fallback` (Apache-2.0). NOTICE attribution remains at repo root; module shape and mock-client test pattern are adopted; net-new layered on top: TTFT timer, `options.fallback_models` integration, shared schema contract with `omp`. This is consistent with the existing "NOTICE file credits Smart-Coders-HQ/opencode-model-fallback" constraint; no agreement change required.

## Review-Phase Amendments

Recorded 2026-05-20 during acceptance review drift handling. The user approved all three via structured choice before remediation:

1. **Owner-only config permissions** — Tighten `opencode.json` writes from `0644` to `0600` because the file routinely contains provider API keys. This applies to both `ApplyPreferences` and `SetAgentOrder`.

2. **Backup retention cap** — After successful `ApplyPreferences`, automatically prune timestamped `.omp-backup.*` files and keep the 5 most recent backups. This preserves rollback evidence while avoiding unbounded credential-bearing backup accumulation.

3. **Multi-line frontmatter list support** — Extend markdown frontmatter parsing so `fallback_models` supports both inline YAML array form and common multi-line YAML list form.
