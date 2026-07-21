# Executive Summary

## Outcome

OMR now reconciles transient OpenCode failure events with the persisted assistant-message error signal. `session.error`, assistant-error `message.updated`, and typed retry `session.status` feed one normalized, idempotent failure pipeline. TTFT remains the true-silence fallback.

## Why It Matters

OpenCode already routes plugins through EventV2Bridge; no toggle or second event connection was missing. The reliability gap was dependence on transient `session.error`. `message.updated` provides a persistence-backed second signal, but duplicate delivery can otherwise dispatch fallback twice. Structural dedup now guarantees exactly-once recovery across event ordering and concurrent delivery.

## Verdict

READY — independent adv-reviewer found no issues or required edits.

## What Was Built

- Extended structural event normalization for legacy and V2 assistant `message.updated` payloads.
- Added a normalized typed failure handler shared by `session.error`, `message.updated`, and retry `session.status`.
- Added bounded `FailureDeduplicator` with exact message, transient error alias, and failure-family indexes; 30s TTL, 512 cap, deterministic pruning, session cleanup.
- Added typed error fingerprinting with bounded message/response-body identity inputs; raw response body never logged.
- Preserved lifecycle retry when events arrive before config by forgetting only a `no chain` dedup record.
- Added source-aware diagnostics and TTFT clearing only for accepted/duplicate typed failures.
- Added missing proper-lockfile typings and repaired two pre-existing ModelKey test annotations found by typecheck.

## What Was Verified

- Full suite: 374/374 pass across 21 files.
- Typecheck: pass.
- Build: pass.
- Exactly-one fallback: error→message, message→error, status→error, status→message, duplicate, and concurrent delivery.
- Legacy and V2 payload shapes.
- Aborted/malformed signals safely ignored.
- Persistent cooldown receives normalized category.
- No polling probe, direct SSE subscription, provider fetch/health probe, synthetic prompt, TTFT reduction, or OpenCode downgrade.
- Contract review: 23/23 required rows passing/respected.

## Remaining Concerns

- Change ID/title still references the original probe concept for continuity; artifacts and implementation correctly describe durable failure reconciliation.
- Dedup family alias uses session + category (not mutable currentModel) because fallback changes currentModel before terminal events arrive. This intentionally suppresses same-category repeat recovery within 30 seconds while cooldown is active.

## Consequence Context

| Category | Status |
|---|---|
| Delivered value | Exactly-once, zero-token failure reconciliation |
| Enabling-only/follow-up | None required |
| Ops readiness | No migration or operational runbook |
| Migration/data impact | None; existing cooldown projection retained |
| Frontend/preview impact | N/A |
| Collision/release risk | Low; localized plugin event/state changes |
| Open follow-ups | Optional upstream EventV2 regression coverage only |
| Next action | User acceptance, then direct merge/archive per repo no-PR convention |
