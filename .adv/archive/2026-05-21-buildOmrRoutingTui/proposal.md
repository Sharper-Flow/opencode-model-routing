# Build OMR routing TUI

## Why

OMR currently uses an imported/legacy OMP-shaped Go TUI for configuring model preferences, but OMR now owns a broader runtime model-routing product: primary model selection, ordered fallback chains, runtime retry behavior, TTFT timeout handling, cooldown behavior, and OpenCode plugin readiness. The old OMP UX is model-preferences-first; OMR needs a self-contained routing-first configuration tool that does not require or position the standalone OMP project as a dependency.

## What Changes

Build an OMR-native successor to OMP inside this repository. Reuse selected OMP-derived code only where it remains useful, but reshape the product around OMR routing concepts:

- First-class routing stacks per target: primary model plus ordered fallback models.
- Routing-first target detail view rather than a model-only assignment list.
- Validation before save/apply for schema, duplicates, chain length, unavailable models, and unsafe config writes.
- Preview-before-apply for changes to OpenCode config.
- Diagnostics for plugin/config readiness where practical.
- Clear legacy boundary: old standalone OMP is a reference/source, not a required runtime or user-facing dependency.

## Success Criteria

- Users can configure an agent or sub-agent routing stack in OMR without using the standalone OMP project.
- The UI makes primary model and fallback chain state visible together for each target.
- The tool writes the canonical OpenCode config path `agent.<name>.options.fallback_models` for fallback chains.
- The tool validates fallback chains against the existing schema constraints before applying: max 8 entries, unique entries, valid `provider/model` shape, and no consecutive dots.
- The tool previews config mutations before writing `opencode.json` or `opencode.jsonc`.
- The tool preserves existing config safety behavior: backup before mutation and owner-only permissions for OpenCode config writes.
- Existing Go and plugin tests remain green, and new tests cover the routing-stack UI/domain behavior.

## Scope

### In Scope

- Design and implement an OMR-native routing-first configuration UI in this repository.
- Reuse useful OMP-derived code while removing old OMP product assumptions from the user experience.
- Introduce routing-stack domain structure for validation, diff preview, and testability.
- Add preview-before-apply for OpenCode config mutations.
- Preserve and test canonical fallback chain writes to `agent.<name>.options.fallback_models`.
- Add an `omr` binary/path while avoiding supported dependency on old standalone OMP.
- Update docs and product language to present the tool as part of OMR.

### Out of Scope

- Maintaining the old standalone OMP repository as a product.
- Requiring the standalone OMP project at runtime.
- Rewriting the TypeScript runtime plugin unless a UI integration contract gap is found during design.
- Supported automatic migration from old OMP preferences.
- Built-in routing presets/templates in v1.
- Repo-wide UI framework migration away from Go/Bubbletea.

### Must Not

- Must not silently change or invent a new fallback config path.
- Must not remove backup/permission safeguards around OpenCode config writes.
- Must not rely on heuristics alone for chain correctness; validation must be schema-backed or otherwise structural.
- Must not make standalone OMP a required dependency for OMR users.
- Must not add built-in routing presets/templates in v1.
- Must not build supported automatic migration for legacy OMP preferences.
- Must not expand unrelated OpenCode plugin runtime behavior without explicit design justification.
