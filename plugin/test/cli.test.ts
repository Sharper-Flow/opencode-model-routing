import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COOLDOWN_SCHEMA,
  COOLDOWN_VERSION,
  type CooldownEntry,
} from "../src/state/cooldown-store.ts";
import { runCli, type CliIo } from "../src/cli.ts";

let dir: string;
let cooldownPath: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-cli-"));
  cooldownPath = path.join(dir, "cooldown.json");
  env = { ...process.env, OPENCODE_MODEL_ROUTING_COOLDOWN: cooldownPath };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(entries: Record<string, CooldownEntry>): void {
  fs.writeFileSync(
    cooldownPath,
    JSON.stringify({
      schema: COOLDOWN_SCHEMA,
      version: COOLDOWN_VERSION,
      entries,
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(cooldownPath, 0o600);
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

const live = (overrides: Partial<CooldownEntry> = {}): CooldownEntry => ({
  expiresAt: Date.now() + 60_000,
  reason: "unknown",
  setAt: Date.now(),
  ...overrides,
});

describe("omr-cooldown CLI", () => {
  test("dispatches list, status, and reset subcommands", async () => {
    seed({ "openai/gpt-5.6-sol": live() });

    const list = capture();
    expect(await runCli(["list"], env, list.io)).toBe(0);
    expect(list.stdout.join("")).toContain("MODEL");

    const status = capture();
    expect(
      await runCli(["status", "--model", "openai/gpt-5.6-sol"], env, status.io),
    ).toBe(0);
    expect(status.stdout.join("")).toContain("cooled");

    const reset = capture();
    expect(await runCli(["reset"], env, reset.io)).toBe(0);
    expect(reset.stdout.join("")).toContain("cleared 1 entries");
  });

  test("list prints empty human and JSON output", async () => {
    const human = capture();
    expect(await runCli(["list"], env, human.io)).toBe(0);
    expect(human.stdout.join("")).toContain("(no active cooldowns)");

    const json = capture();
    expect(await runCli(["list", "--json"], env, json.io)).toBe(0);
    expect(JSON.parse(json.stdout.join(""))).toEqual({ entries: [] });
  });

  test("list renders entries as a table and valid JSON", async () => {
    seed({
      "openai/gpt-5.6-sol": live({ reason: "unknown" }),
      "kimi-for-coding/k3-256k": live({ reason: "rate_limited" }),
    });

    const human = capture();
    expect(await runCli(["list"], env, human.io)).toBe(0);
    const output = human.stdout.join("");
    expect(output).toContain("MODEL");
    expect(output).toContain("EXPIRES (UTC)");
    expect(output).toContain("REMAINING");
    expect(output).toContain("REASON");
    expect(output).toContain("openai/gpt-5.6-sol");
    expect(output).toContain("rate_limited");

    const json = capture();
    expect(await runCli(["list", "--json"], env, json.io)).toBe(0);
    expect(JSON.parse(json.stdout.join("")).entries).toHaveLength(2);
  });

  test("reset without a model clears every entry", async () => {
    seed({ "openai/a": live(), "kimi/b": live() });
    const output = capture();

    expect(await runCli(["reset"], env, output.io)).toBe(0);
    expect(JSON.parse(fs.readFileSync(cooldownPath, "utf8")).entries).toEqual(
      {},
    );
    expect(output.stdout.join("")).toContain("cleared 2 entries");
  });

  test("reset with a model preserves other entries and names the cleared model", async () => {
    seed({ "openai/a": live(), "kimi/b": live() });
    const output = capture();

    expect(await runCli(["reset", "--model", "openai/a"], env, output.io)).toBe(
      0,
    );
    const entries = JSON.parse(fs.readFileSync(cooldownPath, "utf8")).entries;
    expect(entries["openai/a"]).toBeUndefined();
    expect(entries["kimi/b"]).toBeDefined();
    expect(output.stdout.join("")).toContain("openai/a");
  });

  test("reset absent model is successful and reports zero", async () => {
    seed({ "openai/a": live() });
    const output = capture();

    expect(
      await runCli(["reset", "--model", "missing/model"], env, output.io),
    ).toBe(0);
    expect(output.stdout.join("")).toContain("cleared 0");
  });

  test("reset on a missing cooldown file is successful", async () => {
    const output = capture();

    expect(await runCli(["reset"], env, output.io)).toBe(0);
    expect(output.stdout.join("")).toContain("cleared 0");
  });

  test("help exits zero and unknown subcommand exits two", async () => {
    const help = capture();
    expect(await runCli(["--help"], env, help.io)).toBe(0);
    expect(help.stderr.join("")).toContain("Usage:");

    const unknown = capture();
    expect(await runCli(["unknown"], env, unknown.io)).toBe(2);
  });

  test("uses OPENCODE_MODEL_ROUTING_COOLDOWN from the supplied environment", async () => {
    seed({ "openai/env": live() });
    const output = capture();

    expect(
      await runCli(["status", "--model", "openai/env"], env, output.io),
    ).toBe(0);
    expect(output.stdout.join("")).toContain("cooled");
  });

  test("JSON output is valid for list, status, and reset", async () => {
    seed({ "openai/json": live({ reason: "rate_limited" }) });

    const list = capture();
    expect(await runCli(["list", "--json"], env, list.io)).toBe(0);
    expect(JSON.parse(list.stdout.join("")).entries[0].model).toBe(
      "openai/json",
    );

    const status = capture();
    expect(
      await runCli(
        ["status", "--model", "openai/json", "--json"],
        env,
        status.io,
      ),
    ).toBe(0);
    expect(JSON.parse(status.stdout.join("")).state).toBe("cooled");

    const reset = capture();
    expect(await runCli(["reset", "--json"], env, reset.io)).toBe(0);
    expect(JSON.parse(reset.stdout.join(""))).toEqual({
      cleared: ["openai/json"],
    });
  });
});
