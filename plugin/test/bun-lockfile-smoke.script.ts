// Bun compatibility smoke test script for proper-lockfile.
//
// Invoked as a subprocess by bun-lockfile-compat.test.ts:
//   bun plugin/test/bun-lockfile-smoke.script.ts <cooldownPath> <writerId>
//
// Acquires a proper-lockfile lock on the cooldown file, reads existing state,
// merges in a writer-specific entry, writes atomically, releases lock.

import fs from "node:fs";
import path from "node:path";
import { lock } from "proper-lockfile";

async function main(): Promise<void> {
  const cooldownPath = process.argv[2];
  const writerId = process.argv[3];
  if (!cooldownPath || !writerId) {
    console.error(
      "usage: bun bun-lockfile-smoke.script.ts <cooldownPath> <writerId>",
    );
    process.exit(2);
  }

  // Ensure parent directory exists.
  const dir = path.dirname(cooldownPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error(`mkdir failed: ${(e as Error).message}`);
    process.exit(3);
  }

  const SCHEMA = "opencode-model-routing/cooldown@1";
  const VERSION = 1;

  // Acquire lock with explicit fail-open options (KD1):
  //   - realpath:false  → target file may not exist on first run
  //   - onCompromised   → log + continue (default throws; would violate C1)
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(cooldownPath, {
      retries: { retries: 3, minTimeout: 100, maxTimeout: 500 },
      stale: 10_000,
      realpath: false,
      onCompromised: () => console.log(`${writerId}: compromised`),
      update: 1000,
    });
  } catch (e) {
    console.error(
      `${writerId}: lock acquisition failed: ${(e as Error).message}`,
    );
    process.exit(4);
  }

  try {
    // Read existing file (if any).
    let entries: Record<
      string,
      { expiresAt: number; reason: string; setAt: number }
    > = {};
    try {
      const text = fs.readFileSync(cooldownPath, "utf-8");
      const parsed = JSON.parse(text);
      if (parsed?.entries && typeof parsed.entries === "object") {
        entries = parsed.entries;
      }
    } catch {
      // Missing/malformed → start empty.
    }

    // Merge in this writer's entry.
    entries[writerId] = {
      expiresAt: Date.now() + 3_600_000,
      reason: "smoke",
      setAt: Date.now(),
    };

    const doc = { schema: SCHEMA, version: VERSION, entries };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));

    // Atomic write: temp file in same dir (avoid EXDEV) + rename, 0600.
    const tmpPath = `${cooldownPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    try {
      fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
      fs.renameSync(tmpPath, cooldownPath);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
      console.error(
        `${writerId}: write/rename failed: ${(e as Error).message}`,
      );
      process.exit(5);
    }

    console.log(`${writerId}: wrote`);
  } finally {
    try {
      if (release) await release();
    } catch {
      // Release failure non-fatal.
    }
  }
}

main().catch((e) => {
  console.error(`outer failure: ${(e as Error).message}`);
  process.exit(99);
});
