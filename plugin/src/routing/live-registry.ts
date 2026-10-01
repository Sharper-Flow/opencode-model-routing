// routing/live-registry.ts — host-wide live-session registry (D4).
//
// One JSON file per busy session under the OMR state dir, shared by every
// OpenCode process on the host. Written atomically (temp + rename) when any
// session — routed or not, main or child — starts a turn, and removed on
// session.idle / session.status idle / session.deleted. Readers count a file
// only when its pid is alive and updatedAt is within the freshness window, so
// crashed processes and pid reuse cannot inflate a provider's live count.
//
// Per-session files need no lock and no merge: a writer only ever touches its
// own session's file. The reader applies the same descriptor-bound gate as
// availability/snapshot.ts and state/cooldown-store.ts — O_RDONLY |
// O_NONBLOCK | O_NOFOLLOW, uid match, no group/world perms, byte cap, strict
// UTF-8, strict JSON — and fails open: every anomaly yields "not counted",
// never a throw. A registry fault must never block a routing decision (D5).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelKey } from "../types.ts";
import { isRecord } from "../utils/type-guards.ts";
import { parseStrictJson } from "../availability/snapshot.ts";

// Freshness window. An entry older than this is not counted even when its
// pid is alive — the turn-start upsert keeps busy sessions fresh, so an old
// entry means the session stopped turning (or the process is wedged).
export const LIVE_REGISTRY_FRESH_MS = 30 * 60_000;

// Per-file byte cap. Entries are four fields of bounded size (~200 bytes).
export const MAX_LIVE_REGISTRY_BYTES = 4_096;

// Directory scan cap. 256 concurrent busy sessions is far above any observed
// host load; a larger directory signals a leak rather than a real fleet.
export const MAX_LIVE_REGISTRY_FILES = 256;

// Filename length cap (session ids are well under this; the cap bounds a
// hostile id before sanitization).
const MAX_SESSION_ID_LENGTH = 128;

export interface LiveSessionEntry {
  sessionID: string;
  pid: number;
  model: ModelKey;
  // Writer wall-clock epoch ms at upsert time; the freshness gate reads it.
  updatedAt: number;
}

export function expandHome(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

const DEFAULT_LIVE_REGISTRY_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode-model-routing",
  "live-sessions",
);

export function getLiveRegistryDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.OPENCODE_MODEL_ROUTING_LIVE_SESSIONS_DIR;
  if (!raw) return DEFAULT_LIVE_REGISTRY_DIR;
  return expandHome(raw) ?? DEFAULT_LIVE_REGISTRY_DIR;
}

// Session ids are alnum/underscore/dash on both OpenCode runtimes; anything
// outside that set (and path separators first of all) is replaced so a
// hostile id cannot escape the registry directory. Length is capped.
export function sessionFileName(sessionID: string): string {
  const safe = sessionID.replace(/[^A-Za-z0-9._-]/g, "_");
  const bounded =
    safe.length > MAX_SESSION_ID_LENGTH
      ? safe.slice(0, MAX_SESSION_ID_LENGTH)
      : safe;
  return `${bounded}.json`;
}

function parseLiveSessionEntry(value: unknown): LiveSessionEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionID !== "string" || value.sessionID.length === 0)
    return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid))
    return null;
  if (typeof value.model !== "string" || !value.model.includes("/"))
    return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt))
    return null;
  return {
    sessionID: value.sessionID,
    pid: value.pid,
    model: value.model as ModelKey,
    updatedAt: value.updatedAt,
  };
}

// Liveness probe: signal 0 checks existence without delivering a signal.
// ESRCH → no such process (dead). EPERM → the process exists but is owned by
// another user — still alive, and on a single-operator host that is still
// this operator's session under a different uid context.
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LiveRegistryStat {
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
}

export interface LiveRegistryIo {
  open(p: string, flags: number): number;
  fstat(fd: number): LiveRegistryStat;
  read(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  close(fd: number): void;
  getuid(): number;
  mkdir(p: string, opts: { recursive: true }): void;
  writeFile(p: string, data: Uint8Array, opts: { mode: number }): void;
  rename(from: string, to: string): void;
  unlink(p: string): void;
  constants: { O_RDONLY: number; O_NONBLOCK: number; O_NOFOLLOW: number };
}

const nodeIo: LiveRegistryIo = {
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
  mkdir: (p, opts) => fs.mkdirSync(p, opts),
  writeFile: (p, data, opts) => fs.writeFileSync(p, data, opts),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (p) => fs.unlinkSync(p),
  constants: {
    O_RDONLY: fs.constants.O_RDONLY,
    O_NONBLOCK: fs.constants.O_NONBLOCK,
    O_NOFOLLOW: fs.constants.O_NOFOLLOW,
  },
};

// Descriptor-bound read of one entry file. Returns null on every anomaly —
// missing, symlink, permission, wrong owner, group/world perms, oversized,
// malformed JSON, wrong shape.
function readEntryFile(
  io: LiveRegistryIo,
  filePath: string,
): LiveSessionEntry | null {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = io.constants;
  if (
    !Number.isInteger(O_RDONLY) ||
    !Number.isInteger(O_NONBLOCK) ||
    !Number.isInteger(O_NOFOLLOW)
  ) {
    return null;
  }

  let fd: number;
  try {
    fd = io.open(
      filePath,
      (O_RDONLY as number) | (O_NONBLOCK as number) | (O_NOFOLLOW as number),
    );
  } catch {
    return null;
  }

  try {
    let stat: LiveRegistryStat;
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
    if ((stat.mode & 0o077) !== 0) return null; // owner-only, like cooldown.json
    if (stat.size > MAX_LIVE_REGISTRY_BYTES) return null;

    const buffer = new Uint8Array(MAX_LIVE_REGISTRY_BYTES + 1);
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
    if (total > MAX_LIVE_REGISTRY_BYTES) return null;

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, total),
      );
    } catch {
      return null;
    }

    try {
      return parseLiveSessionEntry(parseStrictJson(text));
    } catch {
      return null;
    }
  } finally {
    try {
      io.close(fd);
    } catch {
      // Close failure leaves nothing actionable; the read result stands.
    }
  }
}

export interface LiveRegistryOptions {
  io?: LiveRegistryIo;
  now?: () => number;
  listDir?: (dir: string) => string[];
  processAlive?: (pid: number) => boolean;
}

export class LiveSessionRegistry {
  private readonly io: LiveRegistryIo;
  private readonly now: () => number;
  private readonly listDir: (dir: string) => string[];
  private readonly alive: (pid: number) => boolean;

  constructor(
    readonly dir: string,
    opts: LiveRegistryOptions = {},
  ) {
    this.io = opts.io ?? nodeIo;
    this.now = opts.now ?? (() => Date.now());
    this.listDir = opts.listDir ?? ((d: string) => fs.readdirSync(d));
    this.alive = opts.processAlive ?? processAlive;
  }

  // Record this host's busy session. Atomic temp + rename so a concurrent
  // reader never observes a half-written entry. Fail-open: a write failure
  // degrades capacity accounting, it must never break the turn.
  upsert(sessionID: string, model: ModelKey): void {
    if (!sessionID) return;
    const entry: LiveSessionEntry = {
      sessionID,
      pid: process.pid,
      model,
      updatedAt: this.now(),
    };
    let bytes: Uint8Array;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(entry));
    } catch {
      return;
    }
    try {
      try {
        this.io.mkdir(this.dir, { recursive: true });
      } catch {
        return;
      }
      const target = path.join(this.dir, sessionFileName(sessionID));
      const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      try {
        this.io.writeFile(tmp, bytes, { mode: 0o600 });
        this.io.rename(tmp, target);
      } catch {
        try {
          this.io.unlink(tmp);
        } catch {
          // tmp cleanup best-effort
        }
      }
    } catch {
      // Outer fail-open.
    }
  }

  // Remove this host's session entry (idle, status idle, deleted). Missing
  // file is a no-op; every failure is swallowed — removal is advisory.
  remove(sessionID: string): void {
    if (!sessionID) return;
    try {
      this.io.unlink(path.join(this.dir, sessionFileName(sessionID)));
    } catch {
      // Already gone or unreadable — nothing to recover.
    }
  }

  // Read every fresh, alive entry. Used by countByProvider and by tests that
  // assert registry content directly.
  private readSnapshot(): LiveSessionEntry[] | null {
    let names: string[];
    try {
      names = this.listDir(this.dir).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      return null;
    }
    const now = this.now();
    const out: LiveSessionEntry[] = [];
    let scanned = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      if (scanned >= MAX_LIVE_REGISTRY_FILES) break;
      scanned += 1;
      const entry = readEntryFile(this.io, path.join(this.dir, name));
      if (!entry) continue;
      if (now - entry.updatedAt > LIVE_REGISTRY_FRESH_MS) continue;
      if (now < entry.updatedAt - LIVE_REGISTRY_FRESH_MS) continue; // clock skew guard
      if (!this.alive(entry.pid)) continue;
      out.push(entry);
    }
    return out;
  }

  snapshot(): LiveSessionEntry[] {
    return this.readSnapshot() ?? [];
  }

  // Count live sessions whose model runs on the given provider (the ModelKey
  // prefix before the first slash). Fail-open: unreadable directory → 0.
  countByProvider(providerID: string): number | null {
    if (!providerID) return 0;
    const entries = this.readSnapshot();
    if (!entries) return null;
    return entries.filter((entry) => entry.model.split("/")[0] === providerID)
      .length;
  }
}
