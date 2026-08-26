// Structured logger for the model-routing plugin.
//
// Two independently gated sinks:
//   - console (stderr): warn+ by default. Plugin stderr is visible inside the
//     OpenCode TUI, so routine routing narrative (info/debug) must stay off
//     it; only actionable warnings and errors are emitted there.
//   - file (opts.file or OMR_LOG_FILE): debug+ whenever configured. Captures
//     the full routing narrative for post-hoc debugging, because opencode.log
//     does not capture plugin stderr.
//
// All log lines are emitted as single-line JSON. Format mirrors the
// reference Smart-Coders-HQ plugin for grep/jq compatibility.

import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  // Minimum level for the console/stderr sink. Default "warn".
  minLevel?: LogLevel;
  // Override the console sink — primarily a test seam. The file sink, when
  // configured, is unaffected by this override.
  write?: (line: string) => void;
  // Optional file path to append every line to (sync, best-effort). Falls
  // back to the OMR_LOG_FILE env var when unset.
  file?: string;
  // Minimum level for the file sink. Default "debug" (full narrative).
  fileMinLevel?: LogLevel;
}

const levelRank: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const consoleMin = opts.minLevel ?? "warn";
  const fileMin = opts.fileMinLevel ?? "debug";
  const fileSink = opts.file ?? process.env.OMR_LOG_FILE;
  const write =
    opts.write ?? ((line: string) => process.stderr.write(line + "\n"));

  function emit(
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ) {
    const toConsole = levelRank[level] >= levelRank[consoleMin];
    const toFile =
      fileSink !== undefined && levelRank[level] >= levelRank[fileMin];
    if (!toConsole && !toFile) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      plugin: "opencode-model-routing",
      event,
      ...(fields ?? {}),
    });
    if (toConsole) write(line);
    if (toFile) {
      try {
        appendFileSync(fileSink, line + "\n");
      } catch {
        // Best-effort: a bad log path must never break routing.
      }
    }
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
