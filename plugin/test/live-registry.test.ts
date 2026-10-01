import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LiveSessionRegistry,
  LIVE_REGISTRY_FRESH_MS,
  sessionFileName,
} from "../src/routing/live-registry.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omr-live-registry-"));
}

const HOUR = 3_600_000;

describe("LiveSessionRegistry", () => {
  test("upsert writes one atomic owner-only entry and leaves no temp files", () => {
    const dir = tmpDir();
    const registry = new LiveSessionRegistry(dir);
    registry.upsert("ses_abc", "zai-coding-plan/glm-5.3");

    const file = path.join(dir, sessionFileName("ses_abc"));
    expect(fs.existsSync(file)).toBe(true);
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(entry.sessionID).toBe("ses_abc");
    expect(entry.pid).toBe(process.pid);
    expect(entry.model).toBe("zai-coding-plan/glm-5.3");
    expect(typeof entry.updatedAt).toBe("number");

    registry.upsert("ses_abc", "commandcode/glm-5.3-flash");
    const updated = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(updated.model).toBe("commandcode/glm-5.3-flash");
    expect(fs.readdirSync(dir).some((n) => n.includes(".tmp."))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("hostile session ids cannot escape the directory", () => {
    expect(sessionFileName("../../etc/passwd")).toBe(".._.._etc_passwd.json");
    expect(sessionFileName("a/b/c")).toBe("a_b_c.json");
  });

  test("remove drops the entry and tolerates a missing file", () => {
    const dir = tmpDir();
    const registry = new LiveSessionRegistry(dir);
    registry.upsert("s1", "a/one");
    expect(fs.existsSync(path.join(dir, sessionFileName("s1")))).toBe(true);
    registry.remove("s1");
    expect(fs.existsSync(path.join(dir, sessionFileName("s1")))).toBe(false);
    expect(() => registry.remove("never-existed")).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("countByProvider counts only fresh entries with live pids", () => {
    const dir = tmpDir();
    const now = 1_000_000_000_000;
    const DEAD_PID = 2_000_000_001;
    const registry = new LiveSessionRegistry(dir, {
      now: () => now,
      processAlive: (pid) => pid === process.pid,
    });
    // Live + fresh, provider a (two sessions — the parallel-spawn case).
    registry.upsert("busy-1", "prov-a/one");
    registry.upsert("busy-2", "prov-a/two");
    // Live + fresh, provider b.
    registry.upsert("busy-3", "prov-b/one");
    // Dead pid → not counted.
    fs.writeFileSync(
      path.join(dir, "dead.json"),
      JSON.stringify({
        sessionID: "dead",
        pid: DEAD_PID,
        model: "prov-a/three",
        updatedAt: now,
      }),
      { mode: 0o600 },
    );
    // Stale beyond the freshness window → not counted.
    fs.writeFileSync(
      path.join(dir, "stale.json"),
      JSON.stringify({
        sessionID: "stale",
        pid: process.pid,
        model: "prov-a/four",
        updatedAt: now - LIVE_REGISTRY_FRESH_MS - 1,
      }),
      { mode: 0o600 },
    );
    // Future beyond the skew guard → not counted.
    fs.writeFileSync(
      path.join(dir, "future.json"),
      JSON.stringify({
        sessionID: "future",
        pid: process.pid,
        model: "prov-a/five",
        updatedAt: now + LIVE_REGISTRY_FRESH_MS + HOUR,
      }),
      { mode: 0o600 },
    );
    // Malformed JSON and wrong shape → skipped, never fatal.
    fs.writeFileSync(path.join(dir, "junk.json"), "{not json", { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, "wrong-shape.json"),
      JSON.stringify({ hello: "world" }),
      { mode: 0o600 },
    );

    expect(registry.countByProvider("prov-a")).toBe(2);
    expect(registry.countByProvider("prov-b")).toBe(1);
    expect(registry.countByProvider("prov-zzz")).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("cross-process: another live process counts, an exited one stops counting", async () => {
    const dir = tmpDir();
    const registry = new LiveSessionRegistry(dir);
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
    try {
      // Simulate the other OpenCode process writing its own entry.
      fs.writeFileSync(
        path.join(dir, sessionFileName("external-1")),
        JSON.stringify({
          sessionID: "external-1",
          pid: child.pid,
          model: "zai-coding-plan/glm-5.3",
          updatedAt: Date.now(),
        }),
        { mode: 0o600 },
      );
      expect(registry.countByProvider("zai-coding-plan")).toBe(1);

      child.kill();
      await child.exited;
      // Give the kernel a beat to release the pid.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registry.countByProvider("zai-coding-plan")).toBe(0);
    } finally {
      child.kill(9);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a missing directory reads as zero live sessions", () => {
    const registry = new LiveSessionRegistry(
      path.join(tmpDir(), "does-not-exist"),
    );
    expect(registry.snapshot()).toEqual([]);
    expect(registry.countByProvider("prov-a")).toBe(0);
  });
});
