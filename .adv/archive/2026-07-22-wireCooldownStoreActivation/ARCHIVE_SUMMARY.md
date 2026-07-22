# Archive: Wire cooldown store activation

**Change ID:** wireCooldownStoreActivation
**Archived:** 2026-07-22T20:32:50.232Z
**Created:** 2026-07-22T19:08:05.942Z

## Tasks Completed

- ✅ Wire CooldownStore into production plugin init path
  > Task checkpoint completed
- ✅ Production-path regression test + bundle marker assertion
  > Task checkpoint completed
- ⏭️ Diagnostic trace + reproduce/pin same-process mystery
- ✅ Conditional same-process fix (AC4 — depends on diagnostic result)
  > Task checkpoint completed
- ✅ Cleanup diagnostic + full verification + build + redeploy readiness
  > Task checkpoint completed
- ✅ Classifier message-scan gap fix (P23 campsite rule)
  > Task checkpoint completed

## Specs Modified


## Wisdom Accumulated

- **[gotcha]** attemptFallback's cooldown-marking is gated on `if (current)` where current = state.currentModel. If chat.message's resolveAgentName fails (returns null — e.g. messages not yet committed for a freshly-spawned sub-agent), applyPreemptiveSkip returns early at `if (!agentName) return` WITHOUT setting state.currentModel. The subsequent session.error's attemptFallback then sees current=undefined → skips cooldown entirely → model never marked unhealthy → re-spawn hits the same dead model. Fix: set state.currentModel from output.message.model in handleChatMessage BEFORE the agentName-dependent applyPreemptiveSkip call, so currentModel is populated even when agentName resolution fails.
