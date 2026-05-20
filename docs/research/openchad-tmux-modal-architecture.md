# Architecture Research: openchadTmuxPopupOmp

## Summary
This change direction is mostly sound: using tmux `display-popup` to launch `omp` is the canonical, boring integration for a modal-like workflow in tmux. The `omp` side already follows Bubble Tea's standard Model/Update/View architecture and separates UI from config I/O.

Research tooling was partially degraded in this environment (Context7 quota exhausted; Kagi and Google MCP auth unavailable), so findings are based on direct primary sources (tmux man page, tmux upstream CHANGES, Bubble Tea docs).

## Architecture Health Assessment

### Existing Architecture Classification: SOUND

The current `omp` code path keeps responsibilities reasonably separated:
- `cmd/omp/main.go` handles startup and process exit policy.
- `internal/config` handles config discovery and write operations.
- `internal/tui` handles Bubble Tea state transitions and rendering.

| Area | Existing Pattern | Reference Pattern | Deviation | Impact |
|------|------------------|-------------------|-----------|--------|
| CLI/TUI layering | Thin `main` + `config` + Bubble Tea `tui` model | Bubble Tea recommends Init/Update/View with side effects via commands | NONE | Low risk, easy to extend |
| tmux integration strategy | Planned popup launch via `display-popup -E omp` | tmux canonical popup command for transient UI is `display-popup` | NONE | Correct baseline |
| Runtime compatibility | Planned guard for tmux >= 3.2 | `display-popup` introduced in tmux 3.2 line | NONE | Guard is required and correct |
| User-exit behavior | `q`/`esc`/`ctrl+c` map to `tea.Quit` in TUI | Bubble Tea `tea.Quit` is normal exit path; interrupt errors should be handled explicitly | MINOR | Can leak non-zero exit on signal-path edge cases |

### Architecture Corrections Required
1. Treat Bubble Tea interrupt errors as graceful user exit where intended (in CLI entrypoint), not as fatal startup/runtime errors.

### Minimum Viable Correction
If full cross-repo hardening is deferred, the minimum safe correction is:
1. Keep tmux version guard + popup bind.
2. Add explicit `Program.Run` interrupt handling policy for user-triggered exits.
3. Add one integration test that asserts no duplicate keybinding on repeated install.

## Validated Decisions
- Use tmux popup (`display-popup`) for modal workflow.
- Keep popup size percentage-based (tmux natively supports `%` width/height values).
- Keep idempotency checks and install tests for repeated installs.

## Simplification Opportunities

| Current | Simpler Alternative | Effort | Recommendation |
|---------|---------------------|--------|----------------|
| `display-popup -E` always auto-closes | Use `-EE` to auto-close only on success and keep failures visible | Low | Prefer `-EE` for better failure visibility |
| Implicit popup dimensions | Centralize default `80%x80%` parsing in one helper | Low | Add one parser/validator and reuse in bind generation |
| Mixed error policy in `main` | Map Bubble Tea interrupt/user-close errors to exit code 0 | Low | Add explicit non-fatal exit branch |

## Concerns
- Cross-repo portion (`open-chad` install/theme integration) is not present in this repository, so implementation-level validation there must happen in the target repo during `/adv-apply`.
- Without explicit interrupt/error mapping in `cmd/omp/main.go`, ctrl+c edge paths may still bubble up as error exits.

## Anti-Patterns Detected
- None in current `omp` architecture.

## Over-Engineering Flags
- No over-engineering detected. Existing plan is mostly straightforward and boring.

## Detailed Findings

### tmux Popup Integration
**Current:** Bind `prefix+m` to `display-popup -E omp` with tmux >= 3.2 guard.
**Reference (by-the-book):** tmux popup workflow is provided by `display-popup` with `-E/-EE`, `%` sizing, and popup-specific options.
**Research:** tmux man page documents `display-popup`; `-E` closes when command exits, `-EE` closes only on success, width/height can be percentages.
**Simpler Option:** Keep one bind command and use `-EE` to preserve failing output.
**Recommendation:** Keep popup approach; prefer `-EE`; preserve version guard.
**Sources:**
- https://man7.org/linux/man-pages/man1/tmux.1.html

### tmux Version Requirement
**Current:** Require tmux >= 3.2 for popup support.
**Reference (by-the-book):** Feature introduction should be guarded by minimum version.
**Research:** tmux CHANGES section `CHANGES FROM 3.1c TO 3.2` includes introduction of transient popups created with `display-popup`.
**Simpler Option:** Hard guard and skip popup bind on older versions.
**Recommendation:** Keep hard guard; document fallback behavior.
**Sources:**
- https://github.com/tmux/tmux/blob/master/CHANGES

### Bubble Tea Exit Semantics
**Current:** `q`/`esc`/`ctrl+c` return `tea.Quit`; `main` exits non-zero on any `Program.Run` error.
**Reference (by-the-book):** Bubble Tea normal quit is `tea.Quit`; `Program.Run` returns typed errors for interrupts/kills.
**Research:** Bubble Tea docs define `Quit()` as program exit command and document `ErrInterrupted`/`ErrProgramKilled` from `Program.Run`.
**Simpler Option:** Explicitly treat user-intended interrupts as non-fatal in entrypoint.
**Recommendation:** Add a narrow `errors.Is(err, tea.ErrInterrupted)` policy in `cmd/omp/main.go` if requirement is exit code 0 for ctrl+c.
**Sources:**
- https://pkg.go.dev/github.com/charmbracelet/bubbletea
- https://github.com/charmbracelet/bubbletea

## Action Items
- [ ] Add task: open-chad popup bind should use `display-popup` with explicit success/failure behavior (`-EE` preferred).
- [ ] Add task: harden tmux version guard and document fallback path when version < 3.2.
- [ ] Add task: assert install idempotency (no duplicate keybind after repeated install).
- [ ] Add task: make Bubble Tea interrupt path return exit code 0 for user-initiated close semantics.

## Confidence
- High: tmux popup mechanics, tmux minimum version requirement, Bubble Tea quit/error semantics.
- Low: open-chad repo-specific implementation details (not locally available in this repo snapshot).
