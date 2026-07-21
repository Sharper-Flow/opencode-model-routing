// Persistent cross-process cooldown store.
//
// Per-model cooldown map shared across all OpenCode plugin instances on the
// same host via a file protocol with cooperative locking around
// read-merge-write. Mirrors the descriptor-bound reader pattern from
// availability/snapshot.ts and adds a writer that survives concurrent
// processes by acquiring a proper-lockfile lock before merge.
//
// Contract authority (see agreement.md):
//   - C1: fail-open — missing/stale/malformed/wrong-perm cooldown file never
//     blocks fallback; every read failure returns an empty Map.
//   - C2: cooperative lock around read-merge-write prevents concurrent-writer
//     lost-update hazard.
//   - C3: owner-only perms (0600), matching Claude availability-snapshot.
//   - C5: TTL authority stays in callers (cooldownMsByCategory); this module
//     persists absolute expiresAt epoch-ms only.
//   - DONT1: any lock-acquisition/compromise failure fails open (log + resolve).
//   - DONT4: writes never extend a cooldown beyond what the caller specified;
//     max-merge picks the greater of (existing, proposed) per model only.
//
// Validator-driven KD1 options (adv-researcher Phase 3.5 findings):
//   - realpath:false  → target file may not exist on first run.
//   - onCompromised   → log + continue (default throws; would violate C1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import { parseStrictJson } from "../availability/snapshot.ts";
import type { ModelKey } from "../types.ts";

// ---------------------------------------------------------------------------
// Constants (Design-Derived Criteria — see design.md DDC1/DDC2/DDC4/DDC5).
// ---------------------------------------------------------------------------

export const COOLDOWN_SCHEMA = "opencode-model-routing/cooldown@1";
export const COOLDOWN_VERSION = 1;
export const MAX_COOLDOWN_BYTES = 16384; // ~200 model entries @ ~80 bytes
export const COOLDOWN_CACHE_TTL_MS = 2000;
export const LOCK_RETRIES = 3;
export const LOCK_STALE_MS = 10_000;
export const LOCK_MIN_TIMEOUT_MS = 100;
export const LOCK_MAX_TIMEOUT_MS = 500;
export const LOCK_UPDATE_MS = 1000;

const TOP_LEVEL_KEYS = new Set(["schema", "version", "entries"]);
const ENTRY_KEYS = new Set(["expiresAt", "reason", "setAt"]);

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface CooldownEntry {
  // Epoch ms at which the cooldown expires (absolute, wall-clock).
  expiresAt: number;
  // Reason category — matches caller's cooldownMsByCategory authority.
  reason: string;
  // Epoch ms at which the cooldown was first observed (informational).
  setAt: number;
}

export interface CooldownFile {
  schema: typeof COOLDOWN_SCHEMA;
  version: typeof COOLDOWN_VERSION;
  entries: Record<string, CooldownEntry>;
}

export interface CooldownStat {
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
}

export interface CooldownIo {
  open(p: string, flags: number): number;
  fstat(fd: number): CooldownStat;
  read(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  close(fd: number): void;
  getuid(): number;
  constants: { O_RDONLY: number; O_NONBLOCK: number; O_NOFOLLOW: number };
}

export interface CooldownLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

// ---------------------------------------------------------------------------
// Path resolution — mirrors availability/snapshot.ts expandHome convention.
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode-model-routing",
  "cooldown.json",
);

export function expandHome(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function getCooldownPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENCODE_MODEL_ROUTING_COOLDOWN;
  // Empty string AND undefined both fall through to default — matches the
  // semantics that an explicitly-empty env value means "no override".
  if (!raw) return DEFAULT_COOLDOWN_PATH;
  return expandHome(raw) ?? DEFAULT_COOLDOWN_PATH;
}

// ---------------------------------------------------------------------------
// Node IO binding. Production uses nodeIo; tests inject fakes for paths that
// cannot be reproduced as unprivileged user (uid mismatch, growing files, etc.).
// ---------------------------------------------------------------------------

const nodeIo: CooldownIo = {
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

const silentLogger: CooldownLogger = {
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Shape validation.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateCooldownFile(v: unknown): CooldownFile | null {
  if (!isRecord(v)) return null;
  for (const k of ["schema", "version", "entries"]) {
    if (!(k in v)) return null;
  }
  for (const k of Object.keys(v)) {
    if (!TOP_LEVEL_KEYS.has(k)) return null;
  }
  if (v.schema !== COOLDOWN_SCHEMA) return null;
  if (v.version !== COOLDOWN_VERSION) return null;

  const entries = v.entries;
  if (!isRecord(entries)) return null;

  const validEntries: Record<string, CooldownEntry> = {};
  for (const [k, entryVal] of Object.entries(entries)) {
    if (!isRecord(entryVal)) return null;
    for (const ek of Object.keys(entryVal)) {
      if (!ENTRY_KEYS.has(ek)) return null;
    }
    const { expiresAt, reason, setAt } = entryVal as {
      expiresAt?: unknown;
      reason?: unknown;
      setAt?: unknown;
    };
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
      return null;
    if (typeof reason !== "string") return null;
    if (typeof setAt !== "number" || !Number.isFinite(setAt)) return null;
    validEntries[k] = { expiresAt, reason, setAt };
  }
  return {
    schema: COOLDOWN_SCHEMA,
    version: COOLDOWN_VERSION,
    entries: validEntries,
  };
}

// ---------------------------------------------------------------------------
// Descriptor-bound reader — mirrors availability/snapshot.ts pattern.
// Returns raw entries (NOT pruned); caller prunes if needed.
// Every failure returns an empty record (fail-open, never throws).
// ---------------------------------------------------------------------------

function readCooldownFileFromDisk(
  io: CooldownIo,
  filePath: string,
): Record<string, CooldownEntry> {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = io.constants;
  if (
    !Number.isInteger(O_RDONLY) ||
    !Number.isInteger(O_NONBLOCK) ||
    !Number.isInteger(O_NOFOLLOW)
  ) {
    return {};
  }

  let fd: number;
  try {
    fd = io.open(
      filePath,
      (O_RDONLY as number) | (O_NONBLOCK as number) | (O_NOFOLLOW as number),
    );
  } catch {
    return {}; // missing, symlink (ELOOP), permission, not-a-file, etc.
  }

  try {
    let stat: CooldownStat;
    try {
      stat = io.fstat(fd);
    } catch {
      return {};
    }
    if (!stat.isFile()) return {};

    let uid: number;
    try {
      uid = io.getuid();
    } catch {
      return {};
    }
    if (!Number.isInteger(uid) || stat.uid !== uid) return {};
    if ((stat.mode & 0o077) !== 0) return {}; // no group/world perms
    if (stat.size > MAX_COOLDOWN_BYTES) return {};

    const buffer = new Uint8Array(MAX_COOLDOWN_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      let n: number;
      try {
        n = io.read(fd, buffer, total, buffer.length - total);
      } catch {
        return {};
      }
      if (n <= 0) break;
      total += n;
    }
    if (total > MAX_COOLDOWN_BYTES) return {}; // grew past cap mid-read

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, total),
      );
    } catch {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = parseStrictJson(text);
    } catch {
      return {};
    }

    const validated = validateCooldownFile(parsed);
    if (!validated) return {};
    return validated.entries;
  } finally {
    try {
      io.close(fd);
    } catch {
      // Close failure leaves nothing actionable; read result stands.
    }
  }
}

// ---------------------------------------------------------------------------
// CooldownStore — public API.
// ---------------------------------------------------------------------------

export interface CooldownStoreOptions {
  io?: CooldownIo;
  now?: () => number;
  logger?: CooldownLogger;
}

export class CooldownStore {
  private readonly io: CooldownIo;
  private readonly now: () => number;
  private readonly logger: CooldownLogger;
  private readonly filePath: string;
  // Cache: avoids hot-path file reads when state hasn't changed (KD4).
  private cachedAt = 0;
  private cachedEntries: Map<ModelKey, CooldownEntry> = new Map();

  constructor(filePath: string, opts: CooldownStoreOptions = {}) {
    this.filePath = filePath;
    this.io = opts.io ?? nodeIo;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? silentLogger;
  }

  /**
   * Read current cooldown entries with TTL-bounded cache (KD4).
   * Cache hit and fresh (≤COOLDOWN_CACHE_TTL_MS) → zero IO.
   * Cache miss or stale → bounded descriptor-bound read.
   * Returns a fresh Map; caller may mutate without affecting cache.
   * Expired entries are pruned on read (defensive; write path also prunes).
   * Fail-open: every error returns an empty Map (never throws).
   */
  readCooldowns(): Map<ModelKey, CooldownEntry> {
    const now = this.now();
    if (this.cachedAt > 0 && now - this.cachedAt < COOLDOWN_CACHE_TTL_MS) {
      return new Map(this.cachedEntries);
    }
    const raw = readCooldownFileFromDisk(this.io, this.filePath);
    const pruned = new Map<ModelKey, CooldownEntry>();
    for (const [k, v] of Object.entries(raw)) {
      if (v.expiresAt > now) {
        pruned.set(k as ModelKey, v);
      }
    }
    this.cachedEntries = pruned;
    this.cachedAt = now;
    return new Map(pruned);
  }

  /**
   * Persist a cooldown entry under cooperative lock around read-merge-write.
   *
   * Merge semantics (KD2): per-model expiresAt = max(existing, proposed).
   * Reason+setAt come from the winning entry. This prevents a sibling's
   * later-observed shorter cooldown from prematurely clearing an earlier
   * longer one.
   *
   * Prune-on-write (KD7): every successful write drops expired entries,
   * bounding file size.
   *
   * Fail-open (C1, DONT1): every failure path resolves normally without
   * throwing. Lock acquisition failure, lock compromise (onCompromised),
   * write failure, or outer exception → log + resolve. In-memory-only
   * updates are NOT performed on failure (caller's in-memory state stays
   * authoritative for the current process; siblings simply don't see it).
   *
   * KD1 options (validator-driven):
   *   - realpath:false  → target file may not exist on first run.
   *   - onCompromised   → log + continue (default throws; would violate C1).
   */
  async persistCooldown(
    modelKey: ModelKey,
    expiresAt: number,
    reason: string,
    setAt: number,
  ): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        this.logger.warn(`cooldown persist: mkdir failed for ${dir}`);
        return;
      }

      let release: (() => Promise<void>) | undefined;
      try {
        release = await lock(this.filePath, {
          retries: {
            retries: LOCK_RETRIES,
            minTimeout: LOCK_MIN_TIMEOUT_MS,
            maxTimeout: LOCK_MAX_TIMEOUT_MS,
          },
          stale: LOCK_STALE_MS,
          realpath: false,
          onCompromised: () => {
            this.logger.warn(
              "cooldown lock compromised — proceeding in-memory only",
            );
          },
          update: LOCK_UPDATE_MS,
        });
      } catch {
        this.logger.warn(
          `cooldown persist: lock acquisition failed for ${this.filePath}`,
        );
        return;
      }

      try {
        const now = this.now();
        const existing = readCooldownFileFromDisk(this.io, this.filePath);

        // Max-merge: existing wins if its expiresAt is strictly greater.
        const prev = existing[modelKey];
        const merged: CooldownEntry =
          prev && prev.expiresAt > expiresAt
            ? prev
            : { expiresAt, reason, setAt };

        // Build new entries map, dropping the model we're updating and
        // pruning any expired entries.
        const newEntries: Record<string, CooldownEntry> = {};
        for (const [k, v] of Object.entries(existing)) {
          if (k === modelKey) continue; // re-added below
          if (v.expiresAt <= now) continue; // prune expired
          newEntries[k] = v;
        }
        if (merged.expiresAt > now) {
          newEntries[modelKey] = merged;
        }

        const file: CooldownFile = {
          schema: COOLDOWN_SCHEMA,
          version: COOLDOWN_VERSION,
          entries: newEntries,
        };
        const text = JSON.stringify(file);
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > MAX_COOLDOWN_BYTES) {
          this.logger.warn(
            `cooldown persist: serialized size ${bytes.length} exceeds cap ${MAX_COOLDOWN_BYTES}`,
          );
          return;
        }

        // Atomic write: temp file in same directory (avoid EXDEV) + rename.
        const tmpPath = `${this.filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
        try {
          fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
          fs.renameSync(tmpPath, this.filePath);
        } catch (e) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            // tmp cleanup best-effort
          }
          this.logger.warn(
            `cooldown persist: write/rename failed: ${(e as Error).message}`,
          );
          return;
        }

        // Invalidate cache so next read reflects the new state.
        this.cachedAt = 0;
      } finally {
        if (release) {
          try {
            await release();
          } catch {
            // Release failure non-fatal.
          }
        }
      }
    } catch (e) {
      // Outer fail-open.
      this.logger.warn(
        `cooldown persist: outer failure: ${(e as Error).message}`,
      );
    }
  }
}
