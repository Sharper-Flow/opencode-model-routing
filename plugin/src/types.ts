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
  // Per-category cooldown overrides. When a model fails with a given
  // ErrorCategory, the cooldown applied is `cooldownMsByCategory[category]`
  // if present, otherwise the default `cooldownMs`. Categories absent from
  // this map fall through to `cooldownMs`. Useful for treating persistent
  // failure modes (quota exhaustion, auth) with longer windows than
  // transient ones (rate_limit, server_error) — prevents thrash cycles
  // where a 5-minute default cooldown expires, the model is retried, fails
  // again immediately, and triggers another fallback cascade.
  //
  // Set an entry to `Number.POSITIVE_INFINITY` for permanent-block within
  // the process lifetime (model never retried until plugin reload).
  cooldownMsByCategory?: Partial<Record<ErrorCategory, number>>;
}

export interface ReplayResult {
  success: boolean;
  fallbackModel?: ModelKey;
  fromModel?: ModelKey | null;
  error?: string;
  // True when the recovery was short-circuited because the session is a
  // subagent. The model was still marked unhealthy (with category-aware
  // cooldown) and `fallbackModel` reflects the next healthy chain entry,
  // but no abort/revert/prompt was issued. Consumers observing this flag
  // should not expect the session to resume on `fallbackModel` — the
  // parent's Task tool will spawn a replacement that hits preemptive
  // redirect instead.
  subagentSkipped?: boolean;
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
  // Category-aware defaults: persistent failure modes get longer cooldowns
  // than the 5-minute default. Quota exhaustion typically lasts hours (plan
  // reset cycle) — a 1-hour window prevents the thrash cycle while still
  // allowing eventual retry if the plan resets mid-process. Auth errors
  // rarely self-heal in 5 minutes; 30 minutes gives a reasonable window
  // for credential rotation. Transient categories (rate_limit, server_error,
  // ttft_timeout, unknown_model, unknown) intentionally fall through to the
  // 5-minute default — they ARE likely to recover quickly.
  cooldownMsByCategory: {
    quota_exhausted: 60 * 60_000, // 1 hour
    auth_error: 30 * 60_000, // 30 minutes
  },
};
