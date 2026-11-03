// Persistent cross-restart routing marker store.
//
// Per-session {served, original} pairs recording what OMR last routed for a
// session: `served` is the model whose dispatch the session's last persisted
// user message names, `original` the model the session fell back FROM (equal
// to `served` on ordinary turns). A restarted OpenCode process loses the
// in-memory FallbackStore, and the TUI re-imports the persisted user
// message's model as the session's selection — without this marker a resumed
// session arrives pinned to a fallback rung with no in-process state left to
// know it was a fallback (CON-1686).
//
// Protocol mirrors cooldown-store.ts (same contract family):
//   - fail-open — missing/stale/malformed/wrong-perm file never blocks
//     routing; every read failure returns null, every write failure logs and
//     resolves;
//   - cooperative proper-lockfile around read-merge-write;
//   - owner-only perms (0600), atomic temp-file + rename;
//   - bounded: entries older than ROUTING_MARKER_TTL_MS are pruned on write,
//     and the oldest entries are dropped past MAX_ROUTING_MARKER_ENTRIES.
//
// Size is bounded by session churn, not model count: one entry per session
// that served at least one routed turn, each ~130 bytes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import { parseStrictJson } from "../availability/snapshot.ts";
import type { ModelKey } from "../types.ts";
import { expandHome } from "./cooldown-store.ts";

export const ROUTING_MARKER_SCHEMA = "opencode-model-routing/session-routing@1";
export const ROUTING_MARKER_VERSION = 1;
export const MAX_ROUTING_MARKER_BYTES = 65536;
export const MAX_ROUTING_MARKER_ENTRIES = 256;
// A marker older than the TTL names a session nobody resumed recently; the
// health state it depended on is long gone, so prune it on write. 14 days
// comfortably outlives every cooldown category while keeping the file small.
export const ROUTING_MARKER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const ROUTING_MARKER_CACHE_TTL_MS = 2000;
const LOCK_RETRIES = 3;
const LOCK_STALE_MS = 10_000;
const LOCK_MIN_TIMEOUT_MS = 100;
const LOCK_MAX_TIMEOUT_MS = 500;
const LOCK_UPDATE_MS = 1000;

const TOP_LEVEL_KEYS = new Set(["schema", "version", "entries"]);
const ENTRY_KEYS = new Set(["served", "original", "at"]);

export interface RoutingMarkerEntry {
  // Model whose dispatch the session's last persisted user message names.
  served: ModelKey;
  // Model the session was on before its latest OMR routing moved it (equals
  // `served` when no fallback is active).
  original: ModelKey;
  // Epoch ms of the last marker write (informational; drives pruning).
  at: number;
}

export interface RoutingMarkerFile {
  schema: typeof ROUTING_MARKER_SCHEMA;
  version: typeof ROUTING_MARKER_VERSION;
  entries: Record<string, RoutingMarkerEntry>;
}

export interface RoutingMarkerLogger {
  warn(msg: string): void;
}

const DEFAULT_ROUTING_MARKER_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode-model-routing",
  "session-routing.json",
);

export function getRoutingMarkerPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.OPENCODE_MODEL_ROUTING_SESSION_ROUTING;
  // Empty string AND undefined both fall through to default — same semantics
  // as getCooldownPath.
  if (!raw) return DEFAULT_ROUTING_MARKER_PATH;
  return expandHome(raw) ?? DEFAULT_ROUTING_MARKER_PATH;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateRoutingMarkerFile(v: unknown): RoutingMarkerFile | null {
  if (!isRecord(v)) return null;
  for (const k of ["schema", "version", "entries"]) {
    if (!(k in v)) return null;
  }
  for (const k of Object.keys(v)) {
    if (!TOP_LEVEL_KEYS.has(k)) return null;
  }
  if (v.schema !== ROUTING_MARKER_SCHEMA) return null;
  if (v.version !== ROUTING_MARKER_VERSION) return null;

  const entries = v.entries;
  if (!isRecord(entries)) return null;

  const validEntries: Record<string, RoutingMarkerEntry> = {};
  for (const [sessionId, entryVal] of Object.entries(entries)) {
    if (!sessionId || !isRecord(entryVal)) return null;
    for (const ek of Object.keys(entryVal)) {
      if (!ENTRY_KEYS.has(ek)) return null;
    }
    const { served, original, at } = entryVal as {
      served?: unknown;
      original?: unknown;
      at?: unknown;
    };
    if (typeof served !== "string" || served.length === 0) return null;
    if (typeof original !== "string" || original.length === 0) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    validEntries[sessionId] = {
      served: served as ModelKey,
      original: original as ModelKey,
      at,
    };
  }
  return {
    schema: ROUTING_MARKER_SCHEMA,
    version: ROUTING_MARKER_VERSION,
    entries: validEntries,
  };
}

// Bounded, owner-only, no-symlink read. Every failure returns an empty file
// (fail-open). Modeled on readCooldownFileFromDisk.
function readRoutingMarkerFile(
  filePath: string,
  now: number,
): Record<string, RoutingMarkerEntry> {
  let text: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return {};
    if (typeof process.getuid !== "function") return {};
    if (stat.uid !== process.getuid()) return {};
    if (stat.mode & 0o077) return {};
    if (stat.size > MAX_ROUTING_MARKER_BYTES) return {};
    text = fs.readFileSync(filePath, "utf-8");
    if (text.length > MAX_ROUTING_MARKER_BYTES) return {};
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch {
    return {};
  }

  const validated = validateRoutingMarkerFile(parsed);
  if (!validated) return {};
  const live: Record<string, RoutingMarkerEntry> = {};
  for (const [sessionId, entry] of Object.entries(validated.entries)) {
    if (entry.at > now - ROUTING_MARKER_TTL_MS) live[sessionId] = entry;
  }
  return live;
}

export class RoutingMarkerStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly logger: RoutingMarkerLogger;
  private cachedAt = 0;
  private cachedEntries: Record<string, RoutingMarkerEntry> = {};
  // Serialized write chain: each write joins behind the previous one, so one
  // store instance never contends with itself on the lock. flush() exposes
  // the chain's tail for callers (and tests) that need settle certainty.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    opts: { now?: () => number; logger?: RoutingMarkerLogger } = {},
  ) {
    this.filePath = filePath;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? { warn: () => {} };
  }

  /**
   * Read one session's marker. TTL-bounded cache; every failure returns
   * null (fail-open — routing proceeds as if no marker existed).
   */
  readMarker(sessionId: string): RoutingMarkerEntry | null {
    const entries = this.readEntries();
    return entries[sessionId] ?? null;
  }

  /** Await every write queued so far (fire-and-forget callers' settle point). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private readEntries(): Record<string, RoutingMarkerEntry> {
    const now = this.now();
    if (
      this.cachedAt > 0 &&
      now - this.cachedAt < ROUTING_MARKER_CACHE_TTL_MS
    ) {
      return this.cachedEntries;
    }
    this.cachedEntries = readRoutingMarkerFile(this.filePath, now);
    this.cachedAt = now;
    return this.cachedEntries;
  }

  /**
   * Persist one session's marker under the cooldown-store lock protocol
   * (mkdir, proper-lockfile, read-merge-write, prune, atomic rename).
   * No-op when the cached entry already matches — steady-state turns do no
   * IO. Fail-open: every failure logs and resolves without throwing.
   * Joins the serialized write chain (see writeChain).
   */
  writeMarker(
    sessionId: string,
    served: ModelKey,
    original: ModelKey,
  ): Promise<void> {
    this.writeChain = this.writeChain.then(() =>
      this.doWriteMarker(sessionId, served, original),
    );
    return this.writeChain;
  }

  private async doWriteMarker(
    sessionId: string,
    served: ModelKey,
    original: ModelKey,
  ): Promise<void> {
    try {
      const now = this.now();
      const cached = this.readEntries()[sessionId];
      if (
        cached &&
        cached.served === served &&
        cached.original === original &&
        now - cached.at < ROUTING_MARKER_TTL_MS
      ) {
        return;
      }

      const dir = path.dirname(this.filePath);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        this.logger.warn(`routing marker write: mkdir failed for ${dir}`);
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
              "routing marker lock compromised — skipping persist",
            );
          },
          update: LOCK_UPDATE_MS,
        });
      } catch {
        this.logger.warn(
          `routing marker write: lock acquisition failed for ${this.filePath}`,
        );
        return;
      }

      try {
        const existing = readRoutingMarkerFile(this.filePath, now);
        const entries = {
          ...existing,
          [sessionId]: { served, original, at: now },
        };

        // Bound the file: TTL prune happened in the read; drop oldest past
        // the entry cap so a long-lived host cannot grow it unbounded.
        const sessionIds = Object.keys(entries);
        if (sessionIds.length > MAX_ROUTING_MARKER_ENTRIES) {
          sessionIds.sort((a, b) => entries[a]!.at - entries[b]!.at);
          const drop = sessionIds.length - MAX_ROUTING_MARKER_ENTRIES;
          for (const id of sessionIds.slice(0, drop)) delete entries[id];
        }

        const file: RoutingMarkerFile = {
          schema: ROUTING_MARKER_SCHEMA,
          version: ROUTING_MARKER_VERSION,
          entries,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(file));
        if (bytes.length > MAX_ROUTING_MARKER_BYTES) {
          this.logger.warn(
            `routing marker write: serialized size ${bytes.length} exceeds cap ${MAX_ROUTING_MARKER_BYTES}`,
          );
          return;
        }

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
            `routing marker write: write/rename failed: ${(e as Error).message}`,
          );
          return;
        }

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
      this.logger.warn(
        `routing marker write: outer failure: ${(e as Error).message}`,
      );
    }
  }

  /** Remove one session's marker (session.deleted). Fail-open. */
  clearMarker(sessionId: string): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.doClearMarker(sessionId));
    return this.writeChain;
  }

  private async doClearMarker(sessionId: string): Promise<void> {
    try {
      const now = this.now();
      if (!this.readEntries()[sessionId]) return;

      const dir = path.dirname(this.filePath);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
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
              "routing marker lock compromised — skipping clear",
            );
          },
          update: LOCK_UPDATE_MS,
        });
      } catch {
        return;
      }

      try {
        const existing = readRoutingMarkerFile(this.filePath, now);
        if (!existing[sessionId]) return;
        const entries = { ...existing };
        delete entries[sessionId];
        const file: RoutingMarkerFile = {
          schema: ROUTING_MARKER_SCHEMA,
          version: ROUTING_MARKER_VERSION,
          entries,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(file));
        if (bytes.length > MAX_ROUTING_MARKER_BYTES) return;
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
            `routing marker clear: write/rename failed: ${(e as Error).message}`,
          );
          return;
        }
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
    } catch {
      // Outer fail-open.
    }
  }
}
