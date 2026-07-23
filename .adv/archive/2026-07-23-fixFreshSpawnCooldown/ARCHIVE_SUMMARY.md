# Archive: Fix fresh spawn cooldown

**Change ID:** fixFreshSpawnCooldown
**Archived:** 2026-07-23T05:17:44.767Z
**Created:** 2026-07-23T03:49:55.414Z

## Tasks Completed

- ✅ T1: Plumb structural agent identity (input.agent → session.get.agent → message scan)
  > Added optional agent to normalized chat-message input. Refactored session metadata read so it caches parentID-derived isSubagent and persisted agent together; detectSubagent reuses that cache. handleChatMessage now prefers/cache input.agent, falls back to session metadata, then message history. Added fresh-empty-history tests for hook and session-record paths.
- ✅ T2: Fix both first-dispatch paths to redirect on fresh spawns
  > Extended fresh-spawn production-context suite with a cooled, empty-history child whose chat.message omits agent while session.get returns adv-engineer; asserts first healthy fallback, exactly one session.get, zero message reads, and zero replay calls.
- ✅ T3: Identity-unavailable deterministic behavior (never silent cooled dispatch)
  > Refactored preemptive selection to inspect the current model before agent-chain lookup. Added deterministic unique-chain fallback and ambiguity/zero-match error logging for known-cooled models with unavailable identity, plus regression tests for all three branches.
- ✅ T4: TTFT stalled sub-agent abort — hand control back to parent
  > handleTtftTimeout inspects attemptFallback's subagentSkipped result and issues one best-effort session.abort only for a subagent TTFT stall. Abort failures are logged and do not crash routing. Added regression asserting abort while preserving no replay calls.
- ✅ T5: Core regression suite (AC1-AC4 + task_id resume) through production createPluginContext()
  > Added fresh-spawn-cooldown.test.ts using real createPluginContext and an isolated persistent cooldown path. It proves pre-dispatch fallback selection with no committed messages/provider replay calls for same-process state, cross-context read-through, and resumed-child-shaped first hook.
- ✅ T6: Adjacent-path scan + document why previous tests passed
  > Documented that archived respawn tests pre-seeded messagesWithAgent(AGENT), masking the fresh-hook race, and that scenario 5 only tested later error cooldown marking. Classified preemptive/availability as fixed first-dispatch gates; TTFT/failure/replay/config paths are not initial provider selection gates.
- ✅ T7: Full verification — focused RED/GREEN then full repo check green
  > Latest authoritative verification: bun run test passed 395/395 across 24 files. Independent reviewer READY; typecheck/lint/build prior evidence remains green.
- ⏭️ T8 (RELEASE-PHASE): Deploy from merged default + live fresh-spawn verification

## Specs Modified


## Wisdom Accumulated

- **[gotcha]** OPENCODE VERSION-CONFUSION TRAP (root cause of repeated agent errors on opencode-core facts). Three divergent sources existed simultaneously: (1) deployed runtime `~/.opencode/bin/opencode` = 1.18.4; (2) local checkout `~/dev/opencode` = 1.17.18 on an anomalyco FORK, branch `dev`; (3) OMR plugin's bundled types `@opencode-ai/plugin@1.4.8`/`@opencode-ai/sdk@1.4.17`. Reading (2) or (3) as if they were the runtime produced a WRONG conclusion: the stale 1.4.17 SDK `Session` type omitted `agent`, leading to "session.get can't return agent" — which is FALSE at 1.18.4. RULE: for opencode-core facts, do NOT trust local checkouts or bundled node_modules SDK types. Delete stale `~/dev/opencode`. Use MCP codesearch (searchcode) against github.com/sst/opencode and PIN to the deployed version (check `opencode --version`, then verify packages/opencode/package.json version in the fetched result). Major 1.18+ changes make pre-1.18 sources actively misleading.
- **[pattern]** FRESH SUB-AGENT AGENT IDENTITY — authoritative sources at opencode 1.18.4 (codesearch-verified, commit fada1a5). A fresh sub-agent's agent name IS available pre-provider-dispatch via TWO structural sources: (1) chat.message hook `input.agent` — populated with the sub-agent name: Task tool calls `ops.prompt({agent: next.name})` (tool/task.ts:210) → `plugin.trigger("chat.message", {agent: input.agent})` (session/prompt.ts:1002) → hook input type `{sessionID, agent?: string, model?, messageID?, variant?}` (packages/plugin/src/index.ts:237). (2) `session.get().agent` — the session record persists agent: created via `sessions.create({parentID, title, agent: next.name})` (tool/task.ts:160), loaded as `agent: row.agent ?? undefined` (session/session.ts:85-87), persisted `agent: info.agent` (session.ts:130). OMR bug: `resolveAgentName` (agent-resolver.ts) only reads committed `session.messages` (empty on fresh spawn → null), and `normalizeChatMessageInput` DISCARDS the hook `input.agent`. Fix priority: hook input.agent (free/sync) → session.get.agent (reuse detectSubagent's existing session.get call, no extra API) → message scan (last resort).
