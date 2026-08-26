// Logger sink-gating contract.
//
// The console sink (stderr) is visible inside the OpenCode TUI, so routine
// routing narrative (info/debug) must stay off it by default. The optional
// file sink exists precisely to capture that narrative for post-hoc debugging.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging/logger.ts";

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function levels(lines: string[]): string[] {
  return lines.map((line) => (JSON.parse(line) as { level: string }).level);
}

describe("logger console sink gate", () => {
  test("info events are suppressed from the console sink by default", () => {
    const { lines, write } = capture();
    const logger = createLogger({ write });
    logger.info("fallback.success", { model: "x" });
    expect(lines).toEqual([]);
  });

  test("debug events are suppressed from the console sink by default", () => {
    const { lines, write } = capture();
    const logger = createLogger({ write });
    logger.debug("failure.signal", { category: "rate_limit" });
    expect(lines).toEqual([]);
  });

  test("warn and error events reach the console sink by default", () => {
    const { lines, write } = capture();
    const logger = createLogger({ write });
    logger.warn("loader.warning", { message: "m" });
    logger.error("fallback.abort_failed", {});
    expect(levels(lines)).toEqual(["warn", "error"]);
  });

  test("explicit minLevel debug passes everything through the seam", () => {
    const { lines, write } = capture();
    const logger = createLogger({ minLevel: "debug", write });
    logger.debug("failure.signal", {});
    logger.info("config.loaded", { agentCount: 1 });
    logger.warn("loader.warning", {});
    logger.error("fallback.abort_failed", {});
    expect(levels(lines)).toEqual(["debug", "info", "warn", "error"]);
  });

  test("records are single-line JSON with envelope fields", () => {
    const { lines, write } = capture();
    const logger = createLogger({ write });
    logger.warn("evt", { k: "v" });
    expect(lines).toHaveLength(1);
    expect(lines[0].includes("\n")).toBe(false);
    const rec = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(rec.plugin).toBe("opencode-model-routing");
    expect(rec.event).toBe("evt");
    expect(rec.k).toBe("v");
    expect(typeof rec.ts).toBe("string");
  });
});

describe("logger file sink", () => {
  test("captures debug narrative while the console seam stays quiet", () => {
    const dir = mkdtempSync(join(tmpdir(), "omr-log-"));
    const file = join(dir, "omr.log");
    try {
      const { lines, write } = capture();
      const logger = createLogger({ write, file });
      logger.debug("failure.signal", { category: "rate_limit" });
      logger.info("fallback.success", { model: "m" });
      logger.warn("loader.warning", { message: "m" });
      expect(levels(lines)).toEqual(["warn"]);
      const fileLines = readFileSync(file, "utf8").trim().split("\n");
      expect(levels(fileLines)).toEqual(["debug", "info", "warn"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("independent of the console seam override", () => {
    const dir = mkdtempSync(join(tmpdir(), "omr-log-"));
    const file = join(dir, "omr.log");
    try {
      const { lines, write } = capture();
      const logger = createLogger({ minLevel: "error", write, file });
      logger.info("config.loaded", { agentCount: 2 });
      expect(lines).toEqual([]);
      const fileLines = readFileSync(file, "utf8").trim().split("\n");
      expect(levels(fileLines)).toEqual(["info"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unwritable file path never throws", () => {
    const logger = createLogger({ file: "/dev/null/omr-cannot/append" });
    expect(() => logger.warn("evt", {})).not.toThrow();
  });
});
