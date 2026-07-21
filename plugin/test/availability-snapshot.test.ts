import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAvailabilityPath,
  parseStrictJson,
  readAvailabilitySnapshot,
  validateSnapshotV1,
  type SnapshotIo,
} from "../src/availability/snapshot.ts";

const T0 = 1_800_000_000_000;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function validAvailable(): Record<string, unknown> {
  return {
    schema: "opencode-claude-max/availability@1",
    version: 1,
    generated_at: isoAt(T0),
    state: "available",
    accounts: { configured: 2, enabled: 2, usable: 2 },
    retry_at: null,
  };
}

function validUnavailable(): Record<string, unknown> {
  return {
    schema: "opencode-claude-max/availability@1",
    version: 1,
    generated_at: isoAt(T0),
    state: "unavailable",
    accounts: { configured: 2, enabled: 2, usable: 0 },
    retry_at: T0 + 300_000,
    marker: "CLAUDE_MAX_UNAVAILABLE",
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omr-avail-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRaw(
  name: string,
  content: string | Uint8Array,
  mode = 0o600,
): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

function writeSnapshot(doc: unknown, mode = 0o600): string {
  return writeRaw("availability.json", JSON.stringify(doc), mode);
}

interface FakeIoResult {
  io: SnapshotIo;
  calls: string[];
  content: Uint8Array;
}

function fakeIo(overrides: Partial<SnapshotIo> = {}): FakeIoResult {
  const calls: string[] = [];
  const content = new TextEncoder().encode(JSON.stringify(validUnavailable()));
  const io: SnapshotIo = {
    open: () => {
      calls.push("open");
      return 3;
    },
    fstat: () => {
      calls.push("fstat");
      return {
        uid: 1000,
        mode: 0o100600,
        size: content.length,
        isFile: () => true,
      };
    },
    read: (_fd, buf, off, len) => {
      calls.push("read");
      const slice = content.subarray(off, Math.min(content.length, off + len));
      buf.set(slice, off);
      return slice.length;
    },
    close: () => {
      calls.push("close");
    },
    getuid: () => 1000,
    constants: { O_RDONLY: 0, O_NONBLOCK: 0o4000, O_NOFOLLOW: 0o100000 },
    ...overrides,
  };
  return { io, calls, content };
}

describe("readAvailabilitySnapshot — descriptor safety (real fs)", () => {
  test("missing file → null (no-op)", () => {
    expect(
      readAvailabilitySnapshot({
        path: join(dir, "absent.json"),
        now: T0 + 1_000,
      }),
    ).toBeNull();
  });

  test("directory path → null (non-regular)", () => {
    expect(readAvailabilitySnapshot({ path: dir, now: T0 + 1_000 })).toBeNull();
  });

  test("symlink to valid snapshot → null (O_NOFOLLOW)", () => {
    const target = writeSnapshot(validUnavailable());
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    expect(
      readAvailabilitySnapshot({ path: link, now: T0 + 1_000 }),
    ).toBeNull();
  });

  test("FIFO → null and does not block (O_NONBLOCK + non-regular)", () => {
    const fifo = join(dir, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
    expect(
      readAvailabilitySnapshot({ path: fifo, now: T0 + 1_000 }),
    ).toBeNull();
  });

  test("group/world permissions → null", () => {
    expect(
      readAvailabilitySnapshot({
        path: writeSnapshot(validUnavailable(), 0o640),
        now: T0 + 1_000,
      }),
    ).toBeNull();
    expect(
      readAvailabilitySnapshot({
        path: writeSnapshot(validUnavailable(), 0o604),
        now: T0 + 1_000,
      }),
    ).toBeNull();
    expect(
      readAvailabilitySnapshot({
        path: writeSnapshot(validUnavailable(), 0o644),
        now: T0 + 1_000,
      }),
    ).toBeNull();
  });

  test("owner-only 0600 valid unavailable snapshot → parsed (proves Bun flag/read support)", () => {
    const path = writeSnapshot(validUnavailable());
    const snap = readAvailabilitySnapshot({ path, now: T0 + 1_000 });
    expect(snap).not.toBeNull();
    expect(snap?.state).toBe("unavailable");
    expect(snap?.marker).toBe("CLAUDE_MAX_UNAVAILABLE");
    expect(snap?.retry_at).toBe(T0 + 300_000);
  });

  test("owner-only 0400 valid available snapshot → parsed", () => {
    const path = writeSnapshot(validAvailable(), 0o400);
    const snap = readAvailabilitySnapshot({ path, now: T0 + 1_000 });
    expect(snap?.state).toBe("available");
  });

  test("exactly 4096 bytes (whitespace-padded JSON) → accepted", () => {
    const base = JSON.stringify(validUnavailable());
    const padded = base + " ".repeat(4096 - base.length);
    const path = writeRaw("availability.json", padded);
    const snap = readAvailabilitySnapshot({ path, now: T0 + 1_000 });
    expect(snap?.state).toBe("unavailable");
  });

  test("reported size 4097 → null even when content would parse", () => {
    const base = JSON.stringify(validUnavailable());
    const padded = base + " ".repeat(4097 - base.length);
    const path = writeRaw("availability.json", padded);
    expect(readAvailabilitySnapshot({ path, now: T0 + 1_000 })).toBeNull();
  });

  test("invalid UTF-8 bytes → null", () => {
    const path = writeRaw(
      "availability.json",
      new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    );
    expect(readAvailabilitySnapshot({ path, now: T0 + 1_000 })).toBeNull();
  });

  test("truncated UTF-8 multibyte sequence → null", () => {
    const prefix = new TextEncoder().encode(
      '{"schema":"opencode-claude-max/availability@1","version":1,"generated_at":"',
    );
    const path = writeRaw(
      "availability.json",
      new Uint8Array([...prefix, 0xc3]),
    );
    expect(readAvailabilitySnapshot({ path, now: T0 + 1_000 })).toBeNull();
  });

  test("empty file → null", () => {
    const path = writeRaw("availability.json", "");
    expect(readAvailabilitySnapshot({ path, now: T0 + 1_000 })).toBeNull();
  });

  test("malformed JSON → null", () => {
    const path = writeRaw("availability.json", '{"schema":');
    expect(readAvailabilitySnapshot({ path, now: T0 + 1_000 })).toBeNull();
  });

  test("duplicate keys (plain) → null", () => {
    const raw = JSON.stringify(validUnavailable()).replace(
      "{",
      '{"schema":"opencode-claude-max/availability@1",',
    );
    const path = writeRaw("availability.json", raw);
    expect(readAvailabilitySnapshot({ path, now: T0 + 1_000 })).toBeNull();
  });

  test("duplicate keys (escaped \\u0073chema form) → null", () => {
    const raw = JSON.stringify(validUnavailable()).replace(
      "{",
      '{"\\u0073chema":"opencode-claude-max/availability@1",',
    );
    const path = writeRaw("availability.json", raw);
    expect(readAvailabilitySnapshot({ path, now: T0 + 1_000 })).toBeNull();
  });
});

describe("readAvailabilitySnapshot — injected IO", () => {
  test("unsupported flags (O_NOFOLLOW undefined) → null, open never called", () => {
    const { io, calls } = fakeIo({
      constants: {
        O_RDONLY: 0,
        O_NONBLOCK: 0o4000,
        O_NOFOLLOW: undefined as unknown as number,
      },
    });
    expect(
      readAvailabilitySnapshot({ path: "/whatever", now: T0 + 1_000, io }),
    ).toBeNull();
    expect(calls).not.toContain("open");
  });

  test("wrong uid → null, descriptor closed", () => {
    const { io, calls } = fakeIo({ getuid: () => 1001 });
    expect(
      readAvailabilitySnapshot({ path: "/whatever", now: T0 + 1_000, io }),
    ).toBeNull();
    expect(calls).toContain("close");
  });

  test("growing file: fstat small but reads past 4096 → null, descriptor closed", () => {
    const { io, calls } = fakeIo({
      fstat: () => ({
        uid: 1000,
        mode: 0o100600,
        size: 100,
        isFile: () => true,
      }),
      read: (_fd, buf, off, len) => {
        buf.fill(0x20, off, off + len);
        return len;
      },
    });
    expect(
      readAvailabilitySnapshot({ path: "/whatever", now: T0 + 1_000, io }),
    ).toBeNull();
    expect(calls).toContain("close");
  });

  test("open failure → null", () => {
    const { io } = fakeIo({
      open: () => {
        throw new Error("ENOENT");
      },
    });
    expect(
      readAvailabilitySnapshot({ path: "/whatever", now: T0 + 1_000, io }),
    ).toBeNull();
  });

  test("descriptor closed on success, fstat failure, and parse failure", () => {
    const ok = fakeIo();
    expect(
      readAvailabilitySnapshot({ path: "/x", now: T0 + 1_000, io: ok.io }),
    ).not.toBeNull();
    expect(ok.calls).toContain("close");

    const badStat = fakeIo({
      fstat: () => {
        throw new Error("EIO");
      },
    });
    expect(
      readAvailabilitySnapshot({ path: "/x", now: T0 + 1_000, io: badStat.io }),
    ).toBeNull();
    expect(badStat.calls).toContain("close");

    const badJson = fakeIo({
      read: (_fd, buf, off, _len) => {
        buf.set(new TextEncoder().encode("{nope"), off);
        return 5;
      },
    });
    expect(
      readAvailabilitySnapshot({ path: "/x", now: T0 + 1_000, io: badJson.io }),
    ).toBeNull();
    expect(badJson.calls).toContain("close");
  });
});

describe("validateSnapshotV1 — schema and relations", () => {
  const now = T0 + 1_000;

  test("valid available → accepted", () => {
    expect(validateSnapshotV1(validAvailable(), now)?.state).toBe("available");
  });

  test("valid unavailable → accepted", () => {
    expect(validateSnapshotV1(validUnavailable(), now)?.state).toBe(
      "unavailable",
    );
  });

  test("wrong schema → null", () => {
    expect(
      validateSnapshotV1({ ...validAvailable(), schema: "other@1" }, now),
    ).toBeNull();
  });

  test("unknown version → null", () => {
    expect(
      validateSnapshotV1({ ...validAvailable(), version: 2 }, now),
    ).toBeNull();
    expect(
      validateSnapshotV1({ ...validAvailable(), version: "1" }, now),
    ).toBeNull();
  });

  test("extra top-level key → null", () => {
    expect(
      validateSnapshotV1({ ...validAvailable(), path: "/etc/passwd" }, now),
    ).toBeNull();
  });

  test("missing required key → null", () => {
    const { retry_at: _drop, ...rest } = validAvailable();
    expect(validateSnapshotV1(rest, now)).toBeNull();
  });

  test("non-canonical generated_at → null", () => {
    expect(
      validateSnapshotV1(
        { ...validAvailable(), generated_at: "2027-01-01T00:00:00Z" },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1(
        { ...validAvailable(), generated_at: "not a date" },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1({ ...validAvailable(), generated_at: 123 }, now),
    ).toBeNull();
  });

  test("unknown state → null", () => {
    expect(
      validateSnapshotV1({ ...validAvailable(), state: "broken" }, now),
    ).toBeNull();
  });

  test("count bounds: non-integer, negative, >999 → null", () => {
    const base = validAvailable();
    expect(
      validateSnapshotV1(
        { ...base, accounts: { configured: 2, enabled: 2, usable: 0.5 } },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1(
        { ...base, accounts: { configured: 2, enabled: -1, usable: 0 } },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1(
        { ...base, accounts: { configured: 1000, enabled: 2, usable: 2 } },
        now,
      ),
    ).toBeNull();
  });

  test("count ordering: usable ≤ enabled ≤ configured", () => {
    const base = validAvailable();
    expect(
      validateSnapshotV1(
        { ...base, accounts: { configured: 2, enabled: 1, usable: 2 } },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1(
        { ...base, accounts: { configured: 1, enabled: 2, usable: 0 } },
        now,
      ),
    ).toBeNull();
  });

  test("accounts with extra key → null", () => {
    const base = validAvailable();
    expect(
      validateSnapshotV1(
        {
          ...base,
          accounts: { configured: 2, enabled: 2, usable: 2, ids: ["a"] },
        },
        now,
      ),
    ).toBeNull();
  });

  test("unavailable requires usable 0, marker, and retry_at", () => {
    const base = validUnavailable();
    expect(
      validateSnapshotV1(
        { ...base, accounts: { configured: 2, enabled: 2, usable: 1 } },
        now,
      ),
    ).toBeNull();
    const { marker: _m, ...noMarker } = base;
    expect(validateSnapshotV1(noMarker, now)).toBeNull();
    expect(
      validateSnapshotV1({ ...base, marker: "SOMETHING_ELSE" }, now),
    ).toBeNull();
    expect(validateSnapshotV1({ ...base, retry_at: null }, now)).toBeNull();
  });

  test("non-unavailable states must not carry marker or retry_at", () => {
    expect(
      validateSnapshotV1(
        { ...validAvailable(), marker: "CLAUDE_MAX_UNAVAILABLE" },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1({ ...validAvailable(), retry_at: T0 + 1_000 }, now),
    ).toBeNull();
    const disabled = {
      ...validAvailable(),
      state: "disabled",
      accounts: { configured: 2, enabled: 0, usable: 0 },
    };
    expect(
      validateSnapshotV1(
        { ...disabled, marker: "CLAUDE_MAX_UNAVAILABLE" },
        now,
      ),
    ).toBeNull();
  });

  test("available/degraded require usable > 0", () => {
    const base = validAvailable();
    expect(
      validateSnapshotV1(
        { ...base, accounts: { configured: 2, enabled: 2, usable: 0 } },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1(
        {
          ...base,
          state: "degraded",
          accounts: { configured: 2, enabled: 2, usable: 0 },
        },
        now,
      ),
    ).toBeNull();
    expect(
      validateSnapshotV1(
        {
          ...base,
          state: "degraded",
          accounts: { configured: 2, enabled: 2, usable: 1 },
        },
        now,
      ),
    ).not.toBeNull();
  });

  test("retry_at must be safe integer within [generated-60s, generated+1h]", () => {
    const base = validUnavailable();
    expect(
      validateSnapshotV1({ ...base, retry_at: T0 + 300_000.5 }, now),
    ).toBeNull();
    expect(
      validateSnapshotV1({ ...base, retry_at: T0 - 61_000 }, now),
    ).toBeNull();
    expect(
      validateSnapshotV1({ ...base, retry_at: T0 + 3_600_001 }, now),
    ).toBeNull();
    expect(
      validateSnapshotV1({ ...base, retry_at: T0 + 3_600_000 }, now),
    ).not.toBeNull();
    expect(
      validateSnapshotV1({ ...base, retry_at: T0 - 60_000 }, now),
    ).toBeNull(); // expired anyway
  });
});

describe("validateSnapshotV1 — freshness invariant", () => {
  test("available: 59s old → valid; 61s old → null", () => {
    expect(validateSnapshotV1(validAvailable(), T0 + 59_000)).not.toBeNull();
    expect(validateSnapshotV1(validAvailable(), T0 + 61_000)).toBeNull();
  });

  test("available: 4s future skew → valid; 6s future skew → null", () => {
    expect(validateSnapshotV1(validAvailable(), T0 - 4_000)).not.toBeNull();
    expect(validateSnapshotV1(validAvailable(), T0 - 6_000)).toBeNull();
  });

  test("unavailable: valid until retry_at even beyond 60s normal TTL", () => {
    // Covers the TTL-vs-cooldown gap: snapshot stays authoritative for the
    // full active cooldown interval the producer persisted.
    expect(validateSnapshotV1(validUnavailable(), T0 + 120_000)).not.toBeNull();
    expect(validateSnapshotV1(validUnavailable(), T0 + 299_999)).not.toBeNull();
  });

  test("unavailable: exact retry_at expiry → null (no-op)", () => {
    expect(validateSnapshotV1(validUnavailable(), T0 + 300_000)).toBeNull();
    expect(validateSnapshotV1(validUnavailable(), T0 + 300_001)).toBeNull();
  });

  test("unavailable: future skew beyond 5s → null", () => {
    expect(validateSnapshotV1(validUnavailable(), T0 - 6_000)).toBeNull();
  });

  test("unavailable: over-horizon retry_at → null", () => {
    const doc = { ...validUnavailable(), retry_at: T0 + 7_200_000 };
    expect(validateSnapshotV1(doc, T0 + 1_000)).toBeNull();
  });
});

describe("parseStrictJson", () => {
  test("parses values equivalent to JSON.parse", () => {
    const doc = validUnavailable();
    expect(parseStrictJson(JSON.stringify(doc))).toEqual(doc);
  });

  test("rejects duplicate nested keys", () => {
    expect(() => parseStrictJson('{"a":{"x":1,"x":2}}')).toThrow();
  });

  test("rejects duplicate keys decoded from escapes", () => {
    expect(() => parseStrictJson('{"\\u0078":1,"x":2}')).toThrow();
  });

  test("rejects trailing content, bad numbers, bad escapes, control chars", () => {
    expect(() => parseStrictJson("{} garbage")).toThrow();
    expect(() => parseStrictJson("[01]")).toThrow();
    expect(() => parseStrictJson('"\\q"')).toThrow();
    expect(() => parseStrictJson('{"a":"\u0001"}')).toThrow();
    expect(() => parseStrictJson("[1,]")).toThrow();
    expect(() => parseStrictJson('{"a":1,}')).toThrow();
  });
});

describe("getAvailabilityPath", () => {
  test("env override used literally", () => {
    expect(
      getAvailabilityPath({ OPENCODE_CLAUDE_MAX_AVAILABILITY: "/tmp/x.json" }),
    ).toBe("/tmp/x.json");
  });

  test("~ expansion", () => {
    const p = getAvailabilityPath({
      OPENCODE_CLAUDE_MAX_AVAILABILITY: "~/snap.json",
    });
    expect(p.endsWith("/snap.json")).toBe(true);
    expect(p.startsWith("~")).toBe(false);
  });

  test("default when unset", () => {
    const p = getAvailabilityPath({});
    expect(p.endsWith(".config/opencode-claude-max/availability.json")).toBe(
      true,
    );
  });
});
