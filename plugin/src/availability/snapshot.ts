// availability/snapshot.ts — descriptor-bound consumer for the Claude Max
// availability snapshot protocol (V1).
//
// Protocol authority rules (contract C2/C4):
//   - Open the configured snapshot with ONE descriptor using
//     O_RDONLY | O_NONBLOCK | O_NOFOLLOW. Runtimes that cannot supply any of
//     those flags fail closed (no snapshot → no-op).
//   - fstat the SAME descriptor: current UID, regular file, no group/world
//     permission bits, reported size ≤ 4096 bytes.
//   - Read up to 4097 bytes from the same descriptor (a 4097th byte proves a
//     growing/overflowing file → reject), strict UTF-8 decode, close finally.
//   - Strict V1 JSON: duplicate keys rejected before use (including escaped
//     forms like "\u0073tate"), exact key set, all state relations and the
//     freshness invariant must hold.
//   - Missing, stale, malformed, wrong-permission, unknown-version, or
//     otherwise unexpected snapshot → null → routing no-op. Error text never
//     authorizes routing (DONT3); only a structurally valid fresh snapshot
//     carries authority.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../utils/type-guards.ts";

export const SNAPSHOT_SCHEMA = "opencode-claude-max/availability@1";
export const SNAPSHOT_VERSION = 1;
export const UNAVAILABLE_MARKER = "CLAUDE_MAX_UNAVAILABLE";

// Bounds. MAX_SNAPSHOT_BYTES is the protocol size cap; reads use one extra
// byte to detect overflow. NORMAL_TTL_MS governs states without an active
// cooldown; unavailable snapshots remain authoritative until retry_at (the
// producer-persisted cooldown expiry) capped by MAX_UNAVAILABLE_HORIZON_MS.
// FUTURE_SKEW_MS tolerates small producer/consumer clock skew.
export const MAX_SNAPSHOT_BYTES = 4096;
export const NORMAL_TTL_MS = 60_000;
export const FUTURE_SKEW_MS = 5_000;
export const MAX_UNAVAILABLE_HORIZON_MS = 3_600_000;
export const RETRY_AT_MIN_AGE_MS = 60_000;

export type AvailabilityState = "available" | "degraded" | "unavailable" | "disabled" | "unconfigured";

export interface AvailabilitySnapshotV1 {
  schema: typeof SNAPSHOT_SCHEMA;
  version: typeof SNAPSHOT_VERSION;
  generated_at: string;
  state: AvailabilityState;
  accounts: { configured: number; enabled: number; usable: number };
  retry_at: number | null;
  marker?: typeof UNAVAILABLE_MARKER;
}

export const DEFAULT_AVAILABILITY_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode-claude-max",
  "availability.json",
);

// Mirrors the producer's expandHome semantics ("~" and "~/..." only).
export function expandHome(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function getAvailabilityPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.OPENCODE_CLAUDE_MAX_AVAILABILITY) ?? DEFAULT_AVAILABILITY_PATH;
}

// ---------------------------------------------------------------------------
// Descriptor IO seam. Production binds node:fs; tests inject fakes for paths
// that are not reproducible as an unprivileged user (uid mismatch, growing
// files, unsupported flag constants).
// ---------------------------------------------------------------------------

export interface SnapshotStat {
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
}

export interface SnapshotIo {
  open(path: string, flags: number): number;
  fstat(fd: number): SnapshotStat;
  // Reads up to `length` bytes into buffer starting at offset; returns the
  // number of bytes read (0 = EOF).
  read(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  close(fd: number): void;
  getuid(): number;
  constants: { O_RDONLY: number; O_NONBLOCK: number; O_NOFOLLOW: number };
}

const nodeIo: SnapshotIo = {
  open: (p, flags) => fs.openSync(p, flags),
  fstat: (fd) => fs.fstatSync(fd),
  read: (fd, buf, off, len) => fs.readSync(fd, buf, off, len, null),
  close: (fd) => fs.closeSync(fd),
  getuid: () => {
    if (typeof process.getuid !== "function") {
      throw new Error("process.getuid unavailable on this platform");
    }
    return process.getuid();
  },
  constants: {
    O_RDONLY: fs.constants.O_RDONLY,
    O_NONBLOCK: fs.constants.O_NONBLOCK,
    O_NOFOLLOW: fs.constants.O_NOFOLLOW,
  },
};

// ---------------------------------------------------------------------------
// Strict JSON parsing. JSON.parse cannot reject duplicate object keys (they
// collapse silently), and the protocol requires rejection of duplicates
// including escape-encoded forms. Input is bounded (≤4097 bytes) by the
// reader, so a small recursive-descent parser is the structural choice (P33).
// Semantics otherwise match JSON.parse: standard grammar, \u escapes with
// surrogate-pair decoding, IEEE-754 numbers.
// ---------------------------------------------------------------------------

class StrictJsonParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skipWs();
    const value = this.parseValue();
    this.skipWs();
    if (this.pos !== this.text.length) throw new Error("trailing content after JSON value");
    return value;
  }

  private peek(): string {
    return this.text[this.pos] ?? "";
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private parseValue(): unknown {
    const c = this.peek();
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"') return this.parseString();
    if (c === "t") return this.parseLiteral("true", true);
    if (c === "f") return this.parseLiteral("false", false);
    if (c === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseLiteral(word: string, value: unknown): unknown {
    if (!this.text.startsWith(word, this.pos)) throw new Error(`invalid literal at ${this.pos}`);
    this.pos += word.length;
    return value;
  }

  private parseObject(): Record<string, unknown> {
    this.pos++; // consume '{'
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipWs();
    if (this.peek() === "}") {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.peek() !== '"') throw new Error("expected object key string");
      const key = this.parseString();
      if (seen.has(key)) throw new Error(`duplicate object key: ${JSON.stringify(key)}`);
      seen.add(key);
      this.skipWs();
      if (this.peek() !== ":") throw new Error("expected ':' after object key");
      this.pos++;
      this.skipWs();
      obj[key] = this.parseValue();
      this.skipWs();
      const c = this.peek();
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return obj;
      }
      throw new Error("expected ',' or '}' in object");
    }
  }

  private parseArray(): unknown[] {
    this.pos++; // consume '['
    const arr: unknown[] = [];
    this.skipWs();
    if (this.peek() === "]") {
      this.pos++;
      return arr;
    }
    for (;;) {
      this.skipWs();
      arr.push(this.parseValue());
      this.skipWs();
      const c = this.peek();
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return arr;
      }
      throw new Error("expected ',' or ']' in array");
    }
  }

  private parseString(): string {
    this.pos++; // consume opening quote
    const units: number[] = [];
    for (;;) {
      if (this.pos >= this.text.length) throw new Error("unterminated string");
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x22 /* " */) {
        this.pos++;
        return String.fromCharCode(...units);
      }
      if (code === 0x5c /* \ */) {
        this.pos++;
        const esc = this.text[this.pos];
        switch (esc) {
          case '"':
            units.push(0x22);
            this.pos++;
            break;
          case "\\":
            units.push(0x5c);
            this.pos++;
            break;
          case "/":
            units.push(0x2f);
            this.pos++;
            break;
          case "b":
            units.push(0x08);
            this.pos++;
            break;
          case "f":
            units.push(0x0c);
            this.pos++;
            break;
          case "n":
            units.push(0x0a);
            this.pos++;
            break;
          case "r":
            units.push(0x0d);
            this.pos++;
            break;
          case "t":
            units.push(0x09);
            this.pos++;
            break;
          case "u": {
            this.pos++;
            const hi = this.parseHex4();
            // Decode a surrogate pair only when a low-surrogate \u escape
            // immediately follows; otherwise keep the lone code unit,
            // matching JSON.parse behavior.
            if (
              hi >= 0xd800 &&
              hi <= 0xdbff &&
              this.text[this.pos] === "\\" &&
              this.text[this.pos + 1] === "u"
            ) {
              const save = this.pos;
              this.pos += 2;
              const lo = this.parseHex4();
              if (lo >= 0xdc00 && lo <= 0xdfff) {
                units.push(hi, lo);
              } else {
                units.push(hi);
                this.pos = save;
              }
            } else {
              units.push(hi);
            }
            break;
          }
          default:
            throw new Error(`invalid escape '\\${esc ?? ""}'`);
        }
        continue;
      }
      if (code < 0x20) throw new Error("unescaped control character in string");
      units.push(code);
      this.pos++;
    }
  }

  private parseHex4(): number {
    const hex = this.text.slice(this.pos, this.pos + 4);
    if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new Error("invalid \\u escape");
    }
    this.pos += 4;
    return Number.parseInt(hex, 16);
  }

  private parseNumber(): number {
    const start = this.pos;
    if (this.peek() === "-") this.pos++;
    if (this.peek() === "0") {
      this.pos++;
    } else if (this.peek() >= "1" && this.peek() <= "9") {
      while (this.peek() >= "0" && this.peek() <= "9") this.pos++;
    } else {
      throw new Error(`invalid number at ${this.pos}`);
    }
    if (this.peek() === ".") {
      this.pos++;
      if (!(this.peek() >= "0" && this.peek() <= "9")) throw new Error("invalid fraction");
      while (this.peek() >= "0" && this.peek() <= "9") this.pos++;
    }
    const e = this.peek();
    if (e === "e" || e === "E") {
      this.pos++;
      const sign = this.peek();
      if (sign === "+" || sign === "-") this.pos++;
      if (!(this.peek() >= "0" && this.peek() <= "9")) throw new Error("invalid exponent");
      while (this.peek() >= "0" && this.peek() <= "9") this.pos++;
    }
    return Number(this.text.slice(start, this.pos));
  }
}

export function parseStrictJson(text: string): unknown {
  return new StrictJsonParser(text).parse();
}

// ---------------------------------------------------------------------------
// V1 validation + freshness invariant.
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set([
  "schema",
  "version",
  "generated_at",
  "state",
  "accounts",
  "retry_at",
  "marker",
]);
const REQUIRED_KEYS = ["schema", "version", "generated_at", "state", "accounts", "retry_at"];
const ACCOUNT_KEYS = new Set(["configured", "enabled", "usable"]);
const STATES = new Set<AvailabilityState>([
  "available",
  "degraded",
  "unavailable",
  "disabled",
  "unconfigured",
]);

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 999;
}

/**
 * validateSnapshotV1 checks the exact V1 shape, all state relations, and the
 * freshness invariant against `now` (epoch ms). Returns the typed snapshot or
 * null — every rejection is a routing no-op (fail closed).
 */
export function validateSnapshotV1(value: unknown, now: number): AvailabilitySnapshotV1 | null {
  if (!isRecord(value)) return null;
  for (const key of REQUIRED_KEYS) {
    if (!(key in value)) return null;
  }
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) return null;
  }

  if (value.schema !== SNAPSHOT_SCHEMA) return null;
  if (value.version !== SNAPSHOT_VERSION) return null;

  // Canonical UTC ISO-8601 round-trip: only the producer's exact
  // Date#toISOString() form is accepted.
  if (typeof value.generated_at !== "string") return null;
  const generatedMs = Date.parse(value.generated_at);
  if (!Number.isFinite(generatedMs)) return null;
  if (new Date(generatedMs).toISOString() !== value.generated_at) return null;

  if (typeof value.state !== "string" || !STATES.has(value.state as AvailabilityState)) return null;
  const state = value.state as AvailabilityState;

  const accounts = value.accounts;
  if (!isRecord(accounts)) return null;
  const accountKeys = Object.keys(accounts);
  if (accountKeys.length !== ACCOUNT_KEYS.size) return null;
  for (const key of accountKeys) {
    if (!ACCOUNT_KEYS.has(key)) return null;
  }
  const { configured, enabled, usable } = accounts as {
    configured: unknown;
    enabled: unknown;
    usable: unknown;
  };
  if (!isCount(configured) || !isCount(enabled) || !isCount(usable)) return null;
  if (!(usable <= enabled && enabled <= configured)) return null;

  const retryAt = value.retry_at;
  if (retryAt !== null && (typeof retryAt !== "number" || !Number.isSafeInteger(retryAt))) {
    return null;
  }

  const marker = value.marker;

  // State relations.
  if (state === "unavailable") {
    if (usable !== 0) return null;
    if (marker !== UNAVAILABLE_MARKER) return null;
    if (retryAt === null) return null;
  } else {
    if (marker !== undefined) return null;
    if (retryAt !== null) return null;
    if ((state === "available" || state === "degraded") && usable === 0) return null;
  }

  if (retryAt !== null) {
    if (retryAt < generatedMs - RETRY_AT_MIN_AGE_MS) return null;
    if (retryAt > generatedMs + MAX_UNAVAILABLE_HORIZON_MS) return null;
  }

  // Freshness invariant.
  if (now < generatedMs - FUTURE_SKEW_MS) return null;
  if (state === "unavailable") {
    // Authoritative for the producer-persisted cooldown interval: valid until
    // retry_at (horizon-bounded above), NOT the 60s normal TTL. Exact
    // retry_at expiry is a no-op.
    if (now >= (retryAt as number)) return null;
  } else {
    if (now - generatedMs > NORMAL_TTL_MS) return null;
  }

  return value as unknown as AvailabilitySnapshotV1;
}

// ---------------------------------------------------------------------------
// Descriptor-bound reader.
// ---------------------------------------------------------------------------

export interface ReadSnapshotOptions {
  path?: string;
  now?: number;
  io?: SnapshotIo;
}

/**
 * readAvailabilitySnapshot opens the configured snapshot with one descriptor
 * (O_RDONLY | O_NONBLOCK | O_NOFOLLOW), validates ownership/type/mode/size via
 * fstat on that descriptor, reads up to 4097 bytes, strict-decodes UTF-8,
 * rejects duplicate keys, validates the exact V1 relations + freshness, and
 * closes the descriptor in `finally`.
 *
 * Every failure returns null: the caller treats the snapshot as absent and
 * routing is a no-op. Unsupported flag constants fail closed before any open.
 */
export function readAvailabilitySnapshot(opts: ReadSnapshotOptions = {}): AvailabilitySnapshotV1 | null {
  const io = opts.io ?? nodeIo;
  const now = opts.now ?? Date.now();
  const snapshotPath = opts.path ?? getAvailabilityPath();

  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = io.constants;
  if (!Number.isInteger(O_RDONLY) || !Number.isInteger(O_NONBLOCK) || !Number.isInteger(O_NOFOLLOW)) {
    return null;
  }

  let fd: number;
  try {
    fd = io.open(snapshotPath, (O_RDONLY as number) | (O_NONBLOCK as number) | (O_NOFOLLOW as number));
  } catch {
    return null; // missing, symlink (ELOOP), permission, not-a-file, etc.
  }

  try {
    let stat: SnapshotStat;
    try {
      stat = io.fstat(fd);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    let uid: number;
    try {
      uid = io.getuid();
    } catch {
      return null;
    }
    if (!Number.isInteger(uid) || stat.uid !== uid) return null;
    if ((stat.mode & 0o077) !== 0) return null;
    if (stat.size > MAX_SNAPSHOT_BYTES) return null;

    const buffer = new Uint8Array(MAX_SNAPSHOT_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      let n: number;
      try {
        n = io.read(fd, buffer, total, buffer.length - total);
      } catch {
        return null;
      }
      if (n <= 0) break;
      total += n;
    }
    if (total > MAX_SNAPSHOT_BYTES) return null; // grew past the cap mid-read

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = parseStrictJson(text);
    } catch {
      return null;
    }

    return validateSnapshotV1(parsed, now);
  } finally {
    try {
      io.close(fd);
    } catch {
      // Close failure leaves nothing actionable; the read result stands.
    }
  }
}
