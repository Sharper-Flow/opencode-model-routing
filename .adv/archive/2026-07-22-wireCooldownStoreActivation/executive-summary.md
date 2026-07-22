# Executive Summary

## Outcome

OMR now wires cross-process cooldown persistence into the production plugin init path, fixes a classifier message-scan gap, and resolves the same-process sub-agent fallover mystery. Sub-agents whose primary model hits a usage-limit/quota error will now roll over to the next healthy fallback model instead of hard-failing back to the orchestrator.

## Why It Matters

Three compounding defects prevented sub-agent model fallover:
1. **CooldownStore tree-shaken** — `addPersistentCrossProcess` shipped the persistence layer behind optional injection, but the production entry (`plugin-internal.ts:170`) never instantiated it. Cross-process cooldown was dead code.
2. **Classifier message-scan gap** — `classifySessionError` scanned `data.message` for hardcoded "rate limit"/"quota" only, missing "usage limit"/"billing cycle" (caught only in responseBody scan). Non-403 quota errors got 5min cooldown instead of 1h → thrash cycle.
3. **Same-process currentModel gap** — `handleChatMessage` didn't set `state.currentModel` when `resolveAgentName` failed (messages not yet committed for freshly-spawned sub-agents). The subsequent `session.error`'s `attemptFallback` hit `if (current)` → false → skipped cooldown entirely.

## What Was Built

- **CooldownStore wiring** (`plugin-internal.ts:170`): `new FallbackStore(() => Date.now(), new CooldownStore(getCooldownPath(), { logger }))`. Cross-process persistence now live. Bundle markers confirm (CooldownStore=2, cooldown.json=1 — was 0).
- **Classifier message-scan fix** (`classifier.ts`): added `classifyRetryStatusText(data.message)` after hardcoded checks, matching responseBody-scan coverage. Catches "5 hour usage limit reached" (opencode-go), "billing cycle" (Kimi) in the message field.
- **Same-process currentModel fix** (`plugin-internal.ts handleChatMessage`): sets `state.currentModel` from `output.message.model` BEFORE the agentName-dependent `applyPreemptiveSkip`. Ensures currentModel is always populated even when agentName resolution fails.
- **Test isolation** (`package.json`): test script sets `OPENCODE_MODEL_ROUTING_COOLDOWN` to isolated path, preventing host-state leakage.
- **8 new tests** across 3 files: production-wiring (3), classifier message-scan (3), sub-agent fallover flow (5).

## What Was Verified

- Full suite: 385 pass / 0 fail across 23 files.
- Typecheck: clean (`tsc --noEmit`).
- Build: 65KB, bundle markers confirmed (CooldownStore, cooldown.json, getCooldownPath present).
- TDD: RED→GREEN cycles recorded for all 3 fixes.
- Diagnostic reproduction: 5 scenarios prove fallover works end-to-end (same-process + cross-process) when currentModel is set, and confirm the defect when it isn't.
- Contract matrix: 23/23 passing (7 ACs, 6 constraints, 5 avoidances, 5 OOS).

## Remaining Concerns

- **Deploy**: rebuild from merged main (not worktree) + `scripts/deploy-local.sh --fix` + restart OpenCode. The worktree build is throwaway.
- **Toolbox side**: temporary Kimi→opencode-go primary swap for adv-engineer/build is still live in `~/.config/opencode/opencode.jsonc` — revert when the Kimi cycle refreshes, independent of this change.
- **No runtime diagnostic trace shipped**: the diagnostic was performed via integration tests, not a runtime trace module. If production fallover still fails after deploy (e.g., OpenCode event-delivery nuances not captured by the simulation), a future diagnostic pass with env-gated file-logging may be needed.
