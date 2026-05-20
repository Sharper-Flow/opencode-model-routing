// Structured stderr logger for the model-routing plugin.
//
// All log lines are emitted as single-line JSON to stderr. No file logging
// in v1 per agreement. Format mirrors the reference Smart-Coders-HQ plugin
// for grep/jq compatibility.

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
}

const levelRank: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = opts.minLevel ?? "info";
  const write =
    opts.write ??
    ((line) => {
      // eslint-disable-next-line no-console
      process.stderr.write(line + "\n");
    });

  function emit(level: LogLevel, event: string, fields?: Record<string, unknown>) {
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
