# Agreement

## Objectives

1. Make OMR self-contained by shipping an OMR-native routing configuration UI as part of this repository.
2. Present each configurable OpenCode target as a routing stack: primary model plus ordered fallback chain.
3. Preserve existing fallback schema and OpenCode config write-safety guarantees.
4. Add preview-before-apply through pure planning/diff logic before mutation.
5. Keep v1 manual-only: users choose provider/model pairs and chain order themselves.
6. Avoid any supported dependency on the old standalone OMP project.

## Acceptance Criteria

1. OMR ships an `omr` configuration binary/path for the routing-first UI; old standalone OMP is not required.
2. The UI presents each configurable target as a routing stack: primary model plus ordered fallback chain.
3. Users can manually add fallback models, remove entries, and move/reorder chain entries.
4. No built-in routing presets/templates are included in v1.
5. No automatic legacy OMP migration/support is required; any existing prefs may be migrated manually once.
6. Preview-before-apply shows intended OpenCode config mutations before writing.
7. Apply preserves existing safety behavior: backup before mutation, atomic write, owner-only config permissions.
8. Fallback chains are structurally validated before preview/apply: max 8, unique entries, valid `provider/model`, no consecutive dots.
9. The canonical fallback path remains `agent.<name>.options.fallback_models`.
10. Tests cover routing-stack behavior, chain editing/reordering, preview/apply planning, and config safety.

## Constraints

- Preserve the canonical fallback config contract: `agent.<name>.options.fallback_models`.
- Preserve backup-before-mutation, atomic writes, and owner-only permissions for OpenCode config writes.
- Keep correctness structural: schema-backed validation and pure planning/diff logic before file mutation.
- Keep Go/Bubbletea unless design validation finds a hard blocker; current evidence supports retaining it.
- Keep old standalone OMP as reference/source only, not a required runtime dependency.

## Avoidances

- Do not silently change or invent a new fallback config path.
- Do not remove backup/permission safeguards around OpenCode config writes.
- Do not rely on heuristics alone for chain correctness.
- Do not require standalone OMP for OMR users.
- Do not add built-in routing presets/templates in v1.
- Do not build supported automatic migration for legacy OMP preferences.
- Do not expand plugin runtime behavior unless design identifies a necessary contract gap.

## Decisions

### User Decisions

- Product/tool name: add an `omr` binary/path for the OMR-native routing UI.
- Legacy migration: no supported automatic migration or OMP-user support path; any current preferences can be migrated manually once.
- Presets: manual-only v1. Users choose provider/model pairs and chain order.
- Chain editing: v1 must support adding fallback entries and moving/reordering them.

### Agent Decisions (LBP)

- Keep Go/Bubbletea. Official Bubbletea docs support MVU via `Init`, `Update`, and `View`; Bubbles provides list/input/viewport components sufficient for target browsing, editing, and preview flows.
- Split the current large TUI model into smaller state-specific files/methods while keeping a single root model.
- Introduce pure planning/diff functions before config mutation so preview and apply share one structural path.
- Reuse existing validation in `internal/config/fallback.go` as the writer-side schema-aligned guard.

## Deferred Questions

None.

## Sign-Off

Acceptance criteria approved by user via inline reply: `approve`.
