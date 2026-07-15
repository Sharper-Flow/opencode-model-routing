// Shared types for the OpenCode model-routing plugin.
//
// ModelKey: `${provider}/${modelID}` — matches the schema regex in
// schema/fallback-schema.json. Stored as a template literal type to keep
// callsites that build keys from provider+modelID strongly typed.

export type ModelKey = `${string}/${string}`;

// Categories of failure that can trigger a fallback rotation. Maps from
// session.error payloads ({name, data:{statusCode, message, responseBody, ...}})
// and session.status retry events (typed action.reason first, then text)
// via plugin/src/detection/classifier.ts. `unknown` is the catch-all bucket.
export type ErrorCategory =
  | "rate_limit"
  | "server_error"
  | "unknown_model"
  | "auth_error"
  | "ttft_timeout"
  | "quota_exhausted"
  | "unknown";

// Plugin behaviour configuration. Defaults defined in src/plugin.ts; values
// may be overridden by a per-project `.opencode/model-routing.json` file.
export interface PluginConfig {
  // Time-to-first-token window in ms. If no token arrives within this window,
  // the active model is aborted and the next chain entry is tried.
  ttftMs: number;
  // Cooldown window in ms after a failure. Models in this window are skipped
  // preemptively on the next chat.message round.
  cooldownMs: number;
  // Max fallback depth per session. Prevents infinite cascades.
  maxDepth: number;
  // Dedup window in ms. Two fallback triggers within this window for the
  // same session are collapsed into one.
  dedupWindowMs: number;
  // Pause between abort() and revert() in ms. Empirically chosen by the
  // canonical reference plugin to avoid a race where revert is rejected
  // mid-abort.
  abortWaitMs: number;
  // When true, a model that fails mid-turn has its completed assistant work
  // (tool calls + text) summarised and prepended to the re-prompt so the next
  // model in the chain continues from where the previous one stopped, instead
  // of restarting from the bare user message. Defaults to true (safe-by-default);
  // any summary-extraction failure degrades to the bare prompt.
  preserveContext: boolean;
}

export interface ReplayResult {
  success: boolean;
  fallbackModel?: ModelKey;
  fromModel?: ModelKey | null;
  error?: string;
}

// Default config values. PluginConfig type doc lists units; this object
// supplies the conservative defaults the agreement constrains us to.
export const defaultConfig: PluginConfig = {
  ttftMs: 60_000,
  cooldownMs: 5 * 60_000,
  maxDepth: 3,
  dedupWindowMs: 3_000,
  abortWaitMs: 150,
  preserveContext: true,
};
