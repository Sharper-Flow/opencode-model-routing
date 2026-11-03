// routing-marker-store.test.ts — persisted session routing marker contract.
//
// Mirrors the cooldown-store contract family: fail-open reads, validated V1
// shape, owner-only perms, TTL prune on read and write, entry cap, atomic
// cross-process merge under the cooperative lock, and serialized writes.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ROUTING_MARKER_ENTRIES,
  RoutingMarkerStore,
} from "../src/state/routing-marker-store.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omr-marker-test-"));
  tempDirs.push(dir);
  return dir;
}

function storeAt(file: string, now: () => number = () => Date.now()) {
  return new RoutingMarkerStore(file, { now });
}

function writeRaw(file: string, text: string) {
  writeFileSync(file, text, { mode: 0o600 });
}

describe("RoutingMarkerStore.readMarker — fail-open invariants", () => {
  test("returns null when file is missing", () => {
    const store = storeAt(join(tempDir(), "absent.json"));
    expect(store.readMarker("s1")).toBeNull();
  });

  test("returns null when JSON is malformed", () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    writeRaw(file, "{not json");
    expect(storeAt(file).readMarker("s1")).toBeNull();
  });

  test("returns null when schema is wrong", () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    writeRaw(
      file,
      JSON.stringify({
        schema: "opencode-model-routing/cooldown@1",
        version: 1,
        entries: {},
      }),
    );
    expect(storeAt(file).readMarker("s1")).toBeNull();
  });

  test("returns null when version is wrong", () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    writeRaw(
      file,
      JSON.stringify({
        schema: "opencode-model-routing/session-routing@1",
        version: 2,
        entries: {},
      }),
    );
    expect(storeAt(file).readMarker("s1")).toBeNull();
  });

  test("returns null when top-level keys are unexpected", () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    writeRaw(
      file,
      JSON.stringify({
        schema: "opencode-model-routing/session-routing@1",
        version: 1,
        entries: {},
        extra: true,
      }),
    );
    expect(storeAt(file).readMarker("s1")).toBeNull();
  });

  test("returns null when entry shape is malformed", () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    writeRaw(
      file,
      JSON.stringify({
        schema: "opencode-model-routing/session-routing@1",
        version: 1,
        entries: { s1: { served: "a/one" } },
      }),
    );
    expect(storeAt(file).readMarker("s1")).toBeNull();
  });

  test("returns null when file has group-readable perms", () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    writeRaw(
      file,
      JSON.stringify({
        schema: "opencode-model-routing/session-routing@1",
        version: 1,
        entries: {
          s1: { served: "a/one", original: "a/one", at: Date.now() },
        },
      }),
    );
    chmodSync(file, 0o640);
    expect(storeAt(file).readMarker("s1")).toBeNull();
  });

  test("prunes TTL-expired entries on read", () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    const now = 10_000_000_000;
    writeRaw(
      file,
      JSON.stringify({
        schema: "opencode-model-routing/session-routing@1",
        version: 1,
        entries: {
          old: {
            served: "a/one",
            original: "a/one",
            at: now - 15 * 24 * 60 * 60 * 1000,
          },
          live: { served: "b/two", original: "a/one", at: now - 1000 },
        },
      }),
    );
    const store = storeAt(file, () => now);
    expect(store.readMarker("old")).toBeNull();
    expect(store.readMarker("live")).toEqual({
      served: "b/two",
      original: "a/one",
      at: now - 1000,
    });
  });
});

describe("RoutingMarkerStore.writeMarker — happy path + merge", () => {
  test("creates the file on first write and reads it back", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    const store = storeAt(file);
    await store.writeMarker("s1", "b/two", "a/one");
    expect(store.readMarker("s1")).toEqual({
      served: "b/two",
      original: "a/one",
      at: expect.any(Number),
    });
  });

  test("second store instance reads the persisted marker (cross-process)", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    await storeAt(file).writeMarker("s1", "b/two", "a/one");
    expect(storeAt(file).readMarker("s1")).toMatchObject({
      served: "b/two",
      original: "a/one",
    });
  });

  test("distinct sessions merge; an update replaces only its session", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    const store = storeAt(file);
    await store.writeMarker("s1", "b/two", "a/one");
    await store.writeMarker("s2", "c/three", "c/three");
    await store.writeMarker("s1", "a/one", "a/one");
    expect(store.readMarker("s1")).toMatchObject({
      served: "a/one",
      original: "a/one",
    });
    expect(store.readMarker("s2")).toMatchObject({
      served: "c/three",
      original: "c/three",
    });
  });

  test("dedup: unchanged marker writes are no-ops", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    const store = storeAt(file);
    await store.writeMarker("s1", "b/two", "a/one");
    const before = storeAt(file).readMarker("s1")!.at;
    await new Promise((r) => setTimeout(r, 5));
    await store.writeMarker("s1", "b/two", "a/one");
    const after = storeAt(file).readMarker("s1")!.at;
    expect(after).toBe(before);
  });

  test("clearMarker removes exactly one session's marker", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    const store = storeAt(file);
    await store.writeMarker("s1", "b/two", "a/one");
    await store.writeMarker("s2", "c/three", "c/three");
    await store.clearMarker("s1");
    expect(storeAt(file).readMarker("s1")).toBeNull();
    expect(storeAt(file).readMarker("s2")).toMatchObject({
      served: "c/three",
    });
  });

  test("drops oldest entries past the cap", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    let tick = 1_000_000;
    const store = storeAt(file, () => tick);
    for (let i = 0; i <= MAX_ROUTING_MARKER_ENTRIES; i++) {
      tick += 100;
      await store.writeMarker(`s${i}`, "a/one", "a/one");
    }
    const fresh = storeAt(file, () => tick + 1);
    expect(fresh.readMarker("s0")).toBeNull(); // oldest dropped
    expect(fresh.readMarker(`s${MAX_ROUTING_MARKER_ENTRIES}`)).toMatchObject({
      served: "a/one",
    });
  });

  test("two store instances writing concurrently preserve both markers", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    mkdirSync(dir, { recursive: true });
    const a = storeAt(file);
    const b = storeAt(file);
    await Promise.all([
      a.writeMarker("s1", "b/two", "a/one"),
      b.writeMarker("s2", "c/three", "a/one"),
    ]);
    const fresh = storeAt(file, () => Date.now() + 5000);
    expect(fresh.readMarker("s1")).toMatchObject({ served: "b/two" });
    expect(fresh.readMarker("s2")).toMatchObject({ served: "c/three" });
  });

  test("serialized writes never contend with themselves (chain order)", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    const store = storeAt(file);
    await Promise.all([
      store.writeMarker("s1", "b/two", "a/one"),
      store.writeMarker("s1", "a/one", "a/one"),
      store.writeMarker("s2", "b/two", "a/one"),
    ]);
    await store.flush();
    const fresh = storeAt(file, () => Date.now() + 5000);
    expect(fresh.readMarker("s1")).toMatchObject({ served: "a/one" });
    expect(fresh.readMarker("s2")).toMatchObject({ served: "b/two" });
  });

  test("an oversized single entry is abandoned (byte-cap terminal branch)", async () => {
    const dir = tempDir();
    const file = join(dir, "session-routing.json");
    const store = storeAt(file);
    // One entry whose serialization alone exceeds the byte cap: nothing to
    // drop, so the write resolves fail-open and records nothing.
    const giantId = "s".repeat(70_000);
    await expect(
      store.writeMarker(giantId, "a/one", "a/one"),
    ).resolves.toBeUndefined();
    await store.flush();
    expect(
      storeAt(file, () => Date.now() + 5000).readMarker(giantId),
    ).toBeNull();
  });

  test("fail-open: unwritable directory logs and resolves", async () => {
    const store = storeAt("/dev/null/omr-marker-unwritable");
    await expect(
      store.writeMarker("s1", "a/one", "a/one"),
    ).resolves.toBeUndefined();
  });
});
