// Structured stderr logger for the model-routing plugin.
//
// All log lines are emitted as single-line JSON to stderr. Format mirrors the
// reference Smart-Coders-HQ plugin for grep/jq compatibility.
//
// Optional file sink: set OMR_LOG_FILE=/path/to/omr.log to ALSO append every
// line to that file (sync, best-effort). The default stderr-only sink is
// unchanged when unset. This exists because OpenCode's opencode.log does not
// capture plugin stderr, which made preemptive-redirect / cooldown verdicts
// invisible during rollover debugging (the "fallback unreachable" mystery).

import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  // Minimum level to emit. "debug" lets everything through; "info" suppresses
  // debug; etc.
  minLevel?: LogLevel;
  // Override stderr sink — primarily a test seam.
  write?: (line: string) => void;
  // Optional file path to additionally append every line to (sync,
  // best-effort). Falls back to the OMR_LOG_FILE env var when unset.
  file?: string;
}

const levelRank: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = opts.minLevel ?? "info";
  const fileSink = opts.file ?? process.env.OMR_LOG_FILE;
  const write =
    opts.write ??
    ((line) => {
      process.stderr.write(line + "\n");
      if (fileSink) {
        try {
          appendFileSync(fileSink, line + "\n");
        } catch {
          // Best-effort: a bad log path must never break routing.
        }
      }
    });

  function emit(
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ) {
    if (levelRank[level] < levelRank[minLevel]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      plugin: "opencode-model-routing",
      event,
      ...(fields ?? {}),
    };
    write(JSON.stringify(record));
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
