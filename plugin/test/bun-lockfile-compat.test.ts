// Bun compatibility smoke test for proper-lockfile (C6).
//
// Spawns TWO real `bun` subprocesses that contend for the same cooldown file
// lock. Catches issues that in-process tests cannot (true OS-level lock
// contention, process-level fs.mkdir cooperation).
//
// Verification for ADV task tk-c3280415f03e.

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve(import.meta.dirname, "bun-lockfile-smoke.script.ts");

interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnBun(args: string[]): Promise<SubprocessResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("bun", args, { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
    proc.on("error", reject);
  });
}

describe("bun + proper-lockfile smoke (C6)", () => {
  test("two bun subprocesses contend for same lockfile; both entries preserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omr-bun-smoke-"));
    const cooldownPath = join(dir, "cooldown.json");
    try {
      const start = Date.now();
      const results = await Promise.all([
        spawnBun([scriptPath, cooldownPath, "writer-a"]),
        spawnBun([scriptPath, cooldownPath, "writer-b"]),
      ]);
      const elapsed = Date.now() - start;

      // Both subprocesses should exit 0.
      for (const r of results) {
        if (r.exitCode !== 0) {
          console.error("subprocess failure", {
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
          });
        }
        expect(r.exitCode).toBe(0);
      }

      // Total wall time bounded (~300ms worst-case lock retry + ~10ms work
      // per writer + bun startup overhead).
      expect(elapsed).toBeLessThan(10_000);

      // File exists and contains BOTH writers' entries (no sibling erasure —
      // the AC2 invariant under real OS-level contention).
      expect(existsSync(cooldownPath)).toBe(true);
      const text = readFileSync(cooldownPath, "utf-8");
      const parsed = JSON.parse(text);
      expect(parsed.entries["writer-a"]).toBeDefined();
      expect(parsed.entries["writer-b"]).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("four bun subprocesses contend for same lockfile; all entries preserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omr-bun-smoke-4-"));
    const cooldownPath = join(dir, "cooldown.json");
    try {
      const results = await Promise.all([
        spawnBun([scriptPath, cooldownPath, "writer-1"]),
        spawnBun([scriptPath, cooldownPath, "writer-2"]),
        spawnBun([scriptPath, cooldownPath, "writer-3"]),
        spawnBun([scriptPath, cooldownPath, "writer-4"]),
      ]);

      for (const r of results) {
        expect(r.exitCode).toBe(0);
      }

      const text = readFileSync(cooldownPath, "utf-8");
      const parsed = JSON.parse(text);
      expect(parsed.entries["writer-1"]).toBeDefined();
      expect(parsed.entries["writer-2"]).toBeDefined();
      expect(parsed.entries["writer-3"]).toBeDefined();
      expect(parsed.entries["writer-4"]).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
