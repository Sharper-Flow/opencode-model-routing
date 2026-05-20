# Openchad Tmux Integration

> **Version:** 1.0.0
> **Updated:** 2026-02-27

## Purpose

Capability: Openchad Tmux Integration

## Requirements

### Tmux popup keybinding launches omp from OpenCode session

**ID:** `rq-ompPopupBind` | **Priority:** **[MUST]**

open-chad must provide a tmux keybinding that opens omp in a popup from within an active OpenCode session using display-popup -EE so successful runs close automatically and failures remain visible.

**Tags:** `tmux`, `integration`, `ux`

#### Scenarios

**Open popup from active OpenCode session** (`rq-ompPopupBind.1`)

**Given:**
- an active open-chad tmux session is running OpenCode
- tmux version is 3.2 or newer

**When:** the user presses prefix+m

**Then:**
- a tmux popup opens and runs omp
- the popup default size is 80%x80% unless overridden

**Successful omp run closes popup** (`rq-ompPopupBind.2`)

**Given:**
- omp is launched inside the popup

**When:** the user exits omp successfully

**Then:**
- the popup closes automatically
- focus returns to the previous OpenCode pane

**Failed omp run remains visible** (`rq-ompPopupBind.3`)

**Given:**
- omp exits with a non-zero status

**When:** the popup command finishes

**Then:**
- the popup remains visible
- failure output is visible for diagnosis

---

### Popup flow preserves graceful user-close semantics

**ID:** `rq-ompGracefulExit` | **Priority:** **[MUST]**

omp must treat user-initiated close actions (q, esc, ctrl+c) as graceful exits with status code 0 so popup usage does not produce error flashes.

**Tags:** `omp`, `exit-handling`, `bubbletea`

#### Scenarios

**User quits with q or esc** (`rq-ompGracefulExit.1`)

**Given:**
- omp is running in a tmux popup

**When:** the user presses q or esc

**Then:**
- omp exits with status code 0
- the popup closes and returns focus to OpenCode

**User interrupts with ctrl+c** (`rq-ompGracefulExit.2`)

**Given:**
- omp is running in a tmux popup

**When:** the user presses ctrl+c

**Then:**
- omp exits with status code 0
- no error banner or failure flash is shown

**Preference changes apply on next invocation** (`rq-ompGracefulExit.3`)

**Given:**
- a user updates an agent or sub-agent model in omp
- omp exits successfully

**When:** the user invokes that agent or sub-agent flow in OpenCode

**Then:**
- the updated model preference is read from ~/.config/opencode/opencode.json
- the new model is used on the next invocation

---
