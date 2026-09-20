// availability/quota-state.ts — read-only consumer of the per-provider quota
// state cache written by @slkiser/opencode-quota (schema v2) under
// ~/.cache/opencode/quota-provider-state/, plus the one-shot refresh trigger.
//
// Authority rules:
//   - The cache is written only by `opencode-quota show` (fetch side
//     effect); `show --json` is cache-only, and nothing on the host
//     schedules either. A purely passive reader would consume boundaries
//     days old, so the refresh runs once per classified quota/rate-limit
//     failure — never on a routing decision — and the freshness gate
//     bounds what a failed refresh can contribute.
//   - Files are keyed by providerId, and each entry describes a plan-level
//     window covering every model under that provider. OMR keys are
//     `providerID/modelID`, so the boundary for a failed model comes from
//     the file whose providerId equals the key prefix before the first
//     slash. When the covering plan entry is not determinable, the
//     boundary is the earliest resetTimeIso among zero-remaining entries —
//     it cannot outlast a window that has already reset.
//
// Reader shape mirrors availability/snapshot.ts: one descriptor opened
// O_RDONLY|O_NONBLOCK|O_NOFOLLOW, fstat on the same descriptor, bounded
// read, strict UTF-8, strict JSON (duplicate keys rejected),
// freshness-gated, fail-open — every anomaly yields null and the caller
// falls back to the category constant. The permission gate differs where
// the producer requires it: cache files are written 0664 (group-writable,
// single-user host, user's own primary group), and the cache holds only
// advisory usage metadata that seeds an expiresAt value into the 0600
// cooldown store — so only WORLD-writable files are rejected; ownership
// must still match the current uid.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelKey } from "../types.ts";
import { isRecord } from "../utils/type-guards.ts";
import { parseStrictJson } from "./snapshot.ts";

// Schema version of the quota-provider-state files this module consumes.
export const QUOTA_STATE_VERSION = 2;

// Freshness gate. A boundary observation older than the quota_exhausted
// probe interval is not meaningfully fresher than the category constant it
// would replace, so it is gated out. FUTURE_SKEW tolerates producer clock
// jumps without admitting undated observations.
export const QUOTA_CACHE_FRESH_TTL_MS = 10 * 60_000;
export const QUOTA_FUTURE_SKEW_MS = 60_000;

// Per-file byte cap (largest observed producer file is ~2.5 KB) and the
// directory scan cap.
export const MAX_QUOTA_STATE_BYTES = 16_384;
export const MAX_QUOTA_STATE_FILES = 64;

// Refresh budget for one `opencode-quota show` invocation.
export const QUOTA_REFRESH_TIMEOUT_MS = 8_000;
export const QUOTA_REFRESH_COMMAND = "opencode-quota";

const DEFAULT_QUOTA_STATE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "quota-provider-state",
);

// Mirrors the expandHome semantics of availability/snapshot.ts.
export function expandHome(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function getQuotaStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENCODE_QUOTA_PROVIDER_STATE_DIR;
  if (!raw) return DEFAULT_QUOTA_STATE_DIR;
  return expandHome(raw) ?? DEFAULT_QUOTA_STATE_DIR;
}

// ---------------------------------------------------------------------------
// Shape validation (schema v2).
// ---------------------------------------------------------------------------

export interface QuotaProviderStateV2 {
  providerId: string;
  // Producer wall-clock epoch ms at fetch time; the freshness gate reads it.
  timestamp: number;
  // Epoch-ms reset boundaries of entries reporting zero remaining under
  // provider-reported authority. Earliest wins at the caller.
  boundaries: number[];
}

// Entry-level tolerance: one provider file mixes window kinds (quota
// windows, rate limits, budgets without resetTimeIso). Entries that do not
// carry a usable zero-remaining boundary are skipped, not fatal — one odd
// entry must not discard the provider's real boundaries. File-level shape
// violations (version, providerId, timestamp, result envelope) are fatal.
export function parseQuotaProviderState(
  value: unknown,
): QuotaProviderStateV2 | null {
  if (!isRecord(value)) return null;
  if (value.version !== QUOTA_STATE_VERSION) return null;
  if (typeof value.providerId !== "string" || value.providerId.length === 0)
    return null;
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp))
    return null;
  const result = value.result;
  if (!isRecord(result)) return null;
  if (result.attempted !== true) return null;
  if (!Array.isArray(result.entries)) return null;

  const boundaries: number[] = [];
  for (const entry of result.entries) {
    if (!isRecord(entry)) continue;
    if (entry.percentRemaining !== 0) continue;
    if (typeof entry.resetTimeIso !== "string") continue;
    const ms = Date.parse(entry.resetTimeIso);
    if (!Number.isFinite(ms)) continue;
    const accounting = entry.accounting;
    if (!isRecord(accounting)) continue;
    if (accounting.authority !== "provider_reported") continue;
    boundaries.push(ms);
  }
  return {
    providerId: value.providerId,
    timestamp: value.timestamp,
    boundaries,
  };
}

// ---------------------------------------------------------------------------
// Descriptor-bound reader — mirrors availability/snapshot.ts and
// state/cooldown-store.ts.
// ---------------------------------------------------------------------------

export interface QuotaStateStat {
  uid: number;
  mode: number;
  size: number;
  isFile(): boolean;
}

export interface QuotaStateIo {
  open(p: string, flags: number): number;
  fstat(fd: number): QuotaStateStat;
  read(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  close(fd: number): void;
  getuid(): number;
  constants: { O_RDONLY: number; O_NONBLOCK: number; O_NOFOLLOW: number };
}

const nodeIo: QuotaStateIo = {
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

// Reads and parses one cache file. Returns the parsed JSON value or null —
// every failure is a no-op (fail-open), never a throw.
function readQuotaStateFile(
  io: QuotaStateIo,
  filePath: string,
): unknown | null {
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
    return null; // missing, symlink (ELOOP), permission, not-a-file, etc.
  }

  try {
    let stat: QuotaStateStat;
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
    if ((stat.mode & 0o002) !== 0) return null; // world-writable: reject
    if (stat.size > MAX_QUOTA_STATE_BYTES) return null;

    const buffer = new Uint8Array(MAX_QUOTA_STATE_BYTES + 1);
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
    if (total > MAX_QUOTA_STATE_BYTES) return null; // grew past cap mid-read

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, total),
      );
    } catch {
      return null;
    }

    try {
      return parseStrictJson(text);
    } catch {
      return null;
    }
  } finally {
    try {
      io.close(fd);
    } catch {
      // Close failure leaves nothing actionable; read result stands.
    }
  }
}

// ---------------------------------------------------------------------------
// Boundary resolution.
// ---------------------------------------------------------------------------

export interface ReadQuotaBoundaryOptions {
  dir?: string;
  now?: number;
  io?: QuotaStateIo;
  // Directory listing seam; defaults to fs.readdirSync. Tests inject it
  // together with `io` when faking the filesystem.
  listDir?: (dir: string) => string[];
}

/**
 * Resolve the provider-reported reset boundary for a failed model from the
 * quota state cache. Returns the earliest resetTimeIso (epoch ms) among
 * fresh, zero-remaining, provider-reported entries of the cache file whose
 * providerId matches the model key's prefix before the first slash — or
 * null when no such boundary is available. Null is the caller's signal to
 * fall back to the category constant.
 */
export function readFreshQuotaBoundary(
  modelKey: ModelKey,
  opts: ReadQuotaBoundaryOptions = {},
): number | null {
  const io = opts.io ?? nodeIo;
  const listDir = opts.listDir ?? ((dir: string) => fs.readdirSync(dir));
  const now = opts.now ?? Date.now();
  const dir = opts.dir ?? getQuotaStateDir();

  const slash = modelKey.indexOf("/");
  const providerID = slash > 0 ? modelKey.slice(0, slash) : "";
  if (!providerID) return null;

  let names: string[];
  try {
    names = listDir(dir).sort();
  } catch {
    return null;
  }

  let earliest: number | null = null;
  let scanned = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (scanned >= MAX_QUOTA_STATE_FILES) break;
    scanned += 1;

    const parsed = readQuotaStateFile(io, path.join(dir, name));
    if (parsed === null) continue;
    const state = parseQuotaProviderState(parsed);
    if (!state) continue;
    if (state.providerId !== providerID) continue;

    // Freshness gate: an observation in the future beyond skew, or older
    // than the TTL, must not authorize a cooldown boundary.
    if (state.timestamp > now + QUOTA_FUTURE_SKEW_MS) continue;
    if (now - state.timestamp > QUOTA_CACHE_FRESH_TTL_MS) continue;

    for (const boundary of state.boundaries) {
      if (earliest === null || boundary < earliest) earliest = boundary;
    }
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Refresh trigger + production resolver.
// ---------------------------------------------------------------------------

export type QuotaBoundaryResolver = (
  modelKey: ModelKey,
) => Promise<number | null>;

export type QuotaRefreshExec = (
  cmd: string,
  args: string[],
  opts: { timeout: number },
) => Promise<unknown>;

const execFileP = promisify(execFile);

export interface QuotaResolverOptions extends ReadQuotaBoundaryOptions {
  exec?: QuotaRefreshExec;
  timeoutMs?: number;
}

/**
 * Run `opencode-quota show` once for its fetch side effect: it is the only
 * command that refreshes the per-provider cache files, and nothing else on
 * the host runs it on a schedule. Fail-open: a missing binary, nonzero
 * exit, or timeout leaves the previous cache in place and the freshness
 * gate decides what the subsequent read may consume.
 */
export async function refreshQuotaProviderState(
  opts: Pick<QuotaResolverOptions, "exec" | "timeoutMs"> = {},
): Promise<void> {
  try {
    await (opts.exec ?? execFileP)(QUOTA_REFRESH_COMMAND, ["show"], {
      timeout: opts.timeoutMs ?? QUOTA_REFRESH_TIMEOUT_MS,
    });
  } catch {
    // Fail-open: stale cache + freshness gate is the fallback path.
  }
}

/**
 * Production QuotaBoundaryResolver: refresh once, then read the boundary
 * for the failed model. Wired only on the classified-failure dispatch path
 * (attemptFallback for quota_exhausted / rate_limit) — never on routing
 * decisions — so the subprocess stays off the hot path.
 */
export async function resolveProviderReportedBoundary(
  modelKey: ModelKey,
  opts: QuotaResolverOptions = {},
): Promise<number | null> {
  await refreshQuotaProviderState(opts);
  return readFreshQuotaBoundary(modelKey, opts);
}
