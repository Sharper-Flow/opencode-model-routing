// env-isolation.test.ts — regression guard for the production-log leak.
//
// The failure this prevents is silent: tests pass, but fixture events land in
// the user's real omr.log. Nothing in the suite would notice. These assertions
// fail loudly if the bunfig preload stops running.

import { describe, expect, test } from "bun:test";

import { createLogger } from "../src/logging/logger.ts";

describe("test environment isolation", () => {
  test("OMR_LOG_FILE is neutralized so no file sink is attached", () => {
    // Falsy, not merely different from the production path: logger.ts guards on
    // `if (fileSink)`, so any truthy value would open a handle.
    expect(process.env.OMR_LOG_FILE).toBeFalsy();
  });

  test("cooldown store points at the unwritable isolation sentinel", () => {
    // Deliberately unwritable: /dev/null is not a directory, so cooldown writes
    // fail and no state persists between test files.
    expect(process.env.OPENCODE_MODEL_ROUTING_COOLDOWN).toBe(
      "/dev/null/omr-test-isolation",
    );
  });

  test("a default logger writes nothing to disk under the preload", () => {
    // Exercises the real default `write` path — the one the leaking test hit
    // via pluginModule.server(). Warn reaches the default console sink; a
    // file write does not, because the preload neutralized OMR_LOG_FILE.
    const lines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const logger = createLogger();
      logger.warn("test.isolation.probe", { marker: "should-not-reach-disk" });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(lines.join("")).toContain("test.isolation.probe");
  });
});
