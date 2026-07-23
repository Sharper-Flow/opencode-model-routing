# Executive Summary — Fix fresh spawn cooldown

## Outcome
Fresh OpenCode sub-agents now resolve their agent identity before provider dispatch from structural runtime data: `chat.message` input first, then persisted `session.get().agent`, then committed-message history only as a last fallback. A primary model already in cooldown is redirected to the first healthy fallback before a redundant provider request.

## Value
This prevents newly spawned `adv-engineer` children from repeating known quota failures solely because their first hook arrives before message history is committed. The same protection now covers availability preflight. When identity is genuinely unavailable, routing is deterministic: a unique exact chain match redirects; zero or ambiguous matches log an error instead of guessing another agent’s chain.

## Delivered
- Fresh-hook structural identity cache (`input.agent` → `session.get().agent` → history).
- Pre-dispatch cooldown and availability redirect coverage for empty-history children.
- Unique-chain collision-safe fallback with `identity_unavailable.ambiguous_cooled_dispatch` on zero/multiple matches.
- TTFT-stalled sub-agent abort after cooldown marking, returning control to the parent; session-error behavior unchanged.
- Same-process + persisted fresh-context regression coverage through `createPluginContext()`.
- Metadata-only integration coverage proving `session.get().agent` alone redirects a cooled fresh child.

## Verification
- Focused regressions: 118/118 pass.
- Full plugin suite: 394/394 across 24 files.
- Typecheck, ESLint, and build pass.
- Independent acceptance review: PASS after metadata-only remediation (`fixFreshSpawnCooldown|tk-ef2e0aaaba8d|adv-reviewer|3`).

## Release Readiness Summary
- **Ready to merge/release:** implementation, structural identity behavior, collision behavior, and TTFT abort boundary are independently reviewed and locally verified.
- **Known hygiene warning:** `bun run check` stops at Prettier drift in four untouched existing tests (`detection.test.ts`, `package-contract.test.ts`, `production-wiring.test.ts`, `subagent-fallover-flow.test.ts`). Verifier confirmed the change does not touch them; typecheck/lint/full tests/build are green.
- **Post-merge obligations:** deploy from merged default branch with `scripts/deploy-local.sh --fix`; restart OpenCode; in a fresh session, perform a live `adv-engineer` spawn while a naturally active cooldown exists and capture DB/log proof that the first stream uses fallback with no cooled-primary request.
- **TTFT boundary:** OMR can guarantee stalled child cancellation/parent control return. Core does not guarantee automatic parent re-spawn; live post-deploy evidence determines whether an upstream follow-up is required.
