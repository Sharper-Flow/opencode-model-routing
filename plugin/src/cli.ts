#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import {
  CooldownStore,
  getCooldownPath,
  type CooldownEntry,
} from "./state/cooldown-store.ts";
import type { ModelKey } from "./types.ts";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface CliOptions {
  command?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  model?: string;
}

interface CliError {
  message: string;
  exitCode: 1 | 2;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const usage = `Usage: omr-cooldown <command> [options]

Commands:
  list                       List active cooldowns
  status [--model <model>]  Show cooldown status
  reset [--model <model>]   Clear cooldowns

Options:
  --json                    Print machine-readable JSON
  --help                    Show this help
  --version                 Show package version
`;

function usageError(message: string): CliError {
  return { message, exitCode: 2 };
}

function parseArgs(argv: string[]): CliOptions | CliError {
  const options: CliOptions = {
    json: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help") {
      options.help = true;
    } else if (arg === "--version") {
      options.version = true;
    } else if (arg === "--model") {
      const model = argv[i + 1];
      if (!model || model.startsWith("--")) {
        return usageError("--model requires a value");
      }
      options.model = model;
      i += 1;
    } else if (arg.startsWith("--")) {
      return usageError(`unknown option: ${arg}`);
    } else if (options.command === undefined) {
      options.command = arg;
    } else {
      return usageError(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

function humanizeRemaining(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  if (wholeSeconds < 3600) {
    return `${Math.floor(wholeSeconds / 60)}m${wholeSeconds % 60}s`;
  }
  return `${Math.floor(wholeSeconds / 3600)}h${Math.floor((wholeSeconds % 3600) / 60)}m`;
}

function expiresUtc(expiresAt: number): string {
  return new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function entryJson(model: string, entry: CooldownEntry) {
  return {
    model,
    expiresAt: entry.expiresAt,
    reason: entry.reason,
    setAt: entry.setAt,
  };
}

function sortedEntries(store: CooldownStore): Array<[string, CooldownEntry]> {
  return [...store.readCooldowns().entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function renderList(
  entries: Array<[string, CooldownEntry]>,
  now: number,
  io: CliIo,
  json: boolean,
): void {
  const rendered = entries.map(([model, entry]) => entryJson(model, entry));
  if (json) {
    writeJson(io, { entries: rendered });
    return;
  }
  if (rendered.length === 0) {
    io.stdout("(no active cooldowns)\n");
    return;
  }

  io.stdout("MODEL                    EXPIRES (UTC)        REMAINING  REASON\n");
  for (const [model, entry] of entries) {
    io.stdout(
      `${model.padEnd(24)} ${expiresUtc(entry.expiresAt).padEnd(20)} ${humanizeRemaining((entry.expiresAt - now) / 1000).padEnd(10)} ${entry.reason}\n`,
    );
  }
}

function renderSummary(
  entries: Array<[string, CooldownEntry]>,
  now: number,
  io: CliIo,
  json: boolean,
): void {
  if (json) {
    writeJson(io, {
      count: entries.length,
      entries: entries.map(([model, entry]) => entryJson(model, entry)),
    });
    return;
  }
  io.stdout(`Active cooldowns: ${entries.length}\n`);
  renderList(entries, now, io, false);
}

function renderStatus(
  model: string,
  entry: CooldownEntry | undefined,
  now: number,
  io: CliIo,
  json: boolean,
): void {
  const state = entry && entry.expiresAt > now ? "cooled" : "clear";
  if (json) {
    writeJson(
      io,
      entry
        ? {
            ...entryJson(model, entry),
            state,
            remaining: humanizeRemaining((entry.expiresAt - now) / 1000),
          }
        : {
            model,
            state,
            expiresAt: null,
            reason: null,
            remaining: null,
          },
    );
    return;
  }

  io.stdout(`Model: ${model}\nState: ${state}\n`);
  if (entry && state === "cooled") {
    io.stdout(`Reason: ${entry.reason}\n`);
    io.stdout(`Remaining: ${humanizeRemaining((entry.expiresAt - now) / 1000)}\n`);
    io.stdout(`Expires: ${expiresUtc(entry.expiresAt)}\n`);
  } else {
    io.stdout("Reason: -\nRemaining: -\nExpires: -\n");
  }
}

function readVersion(): string {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json has no valid version");
  }
  return packageJson.version;
}

function emitError(error: CliError, options: CliOptions, io: CliIo): number {
  if (options.json) {
    writeJson(io, { error: error.message });
  } else {
    io.stderr(`${error.message}\n`);
    io.stderr(usage);
  }
  return error.exitCode;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = defaultIo,
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("message" in parsed) return emitError(parsed, { json: false, help: false, version: false }, io);

  if (parsed.help || (parsed.command === undefined && !parsed.version)) {
    io.stderr(usage);
    return 0;
  }
  if (parsed.version) {
    try {
      if (parsed.json) writeJson(io, { version: readVersion() });
      else io.stdout(`${readVersion()}\n`);
      return 0;
    } catch (error) {
      return emitError(
        { message: `failed to read version: ${(error as Error).message}`, exitCode: 1 },
        parsed,
        io,
      );
    }
  }

  const command = parsed.command;
  if (command !== "list" && command !== "status" && command !== "reset") {
    return emitError(usageError(`unknown subcommand: ${command}`), parsed, io);
  }
  if (command === "list" && parsed.model !== undefined) {
    return emitError(usageError("--model is only valid with status or reset"), parsed, io);
  }

  try {
    const store = new CooldownStore(getCooldownPath(env));
    if (command === "list") {
      renderList(sortedEntries(store), Date.now(), io, parsed.json);
      return 0;
    }

    if (command === "status") {
      const entries = store.readCooldowns();
      const now = Date.now();
      if (parsed.model !== undefined) {
        renderStatus(
          parsed.model,
          entries.get(parsed.model as ModelKey),
          now,
          io,
          parsed.json,
        );
      } else {
        const sorted = [...entries.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        renderSummary(sorted, now, io, parsed.json);
      }
      return 0;
    }

    const result = await store.clearCooldowns(parsed.model as ModelKey | undefined);
    if (parsed.json) {
      writeJson(io, result);
    } else {
      const names = result.cleared.length > 0 ? `: ${result.cleared.join(", ")}` : "";
      io.stdout(`cleared ${result.cleared.length} entries${names}\n`);
    }
    return 0;
  } catch (error) {
    return emitError(
      { message: `runtime error: ${(error as Error).message}`, exitCode: 1 },
      parsed,
      io,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
