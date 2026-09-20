// Unit tests for plugin/src/availability/quota-state.ts
//
// Covers the provider-reported quota boundary reader: descriptor-bound
// fail-open file reads, schema v2 validation, the freshness gate
// (stale cache falls back → null), the provider-prefix mapping, the
// earliest-of-zero-remaining rule, and the once-per-failure refresh
// trigger.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getQuotaStateDir,
  parseQuotaProviderState,
  readFreshQuotaBoundary,
  refreshQuotaProviderState,
  resolveProviderReportedBoundary,
  QUOTA_CACHE_FRESH_TTL_MS,
  QUOTA_FUTURE_SKEW_MS,
  QUOTA_REFRESH_COMMAND,
  QUOTA_REFRESH_TIMEOUT_MS,
  MAX_QUOTA_STATE_FILES,
  type QuotaRefreshExec,
} from "../src/availability/quota-state.ts";
import type { ModelKey } from "../src/types.ts";

let dir: string;
let now: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-quota-"));
  now = Date.now();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Producer-realistic entry (mirrors @slkiser/opencode-quota 4.5.1 output).
function providerReportedEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    name: "OpenAI (Pro) Weekly",
    group: "OpenAI (Pro)",
    label: "Weekly:",
    percentRemaining: 0,
    resetTimeIso: new Date(now + 40 * 3_600_000).toISOString(),
    ...overrides,
  };
}

function providerStateDoc(
  providerId: string,
  entries: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    packageVersion: "4.5.1",
    key: `${providerId}|anthropicBinaryPath=claude`,
    providerId,
    timestamp: now,
    result: {
      attempted: true,
      entries,
      errors: [],
    },
    ...overrides,
  };
}

function writeCacheFile(
  name: string,
  content: string | Record<string, unknown>,
  opts: { mode?: number } = {},
): string {
  const filePath = path.join(dir, name);
  const text = typeof content === "string" ? content : JSON.stringify(content);
  fs.writeFileSync(filePath, text);
  // Producer writes 0664 (group/world read) — the reader must accept it.
  fs.chmodSync(filePath, opts.mode ?? 0o664);
  return filePath;
}

describe("readFreshQuotaBoundary — freshness gate (stale falls back)", () => {
  test("fresh zero-remaining entry yields its reset boundary", () => {
    const entry = providerReportedEntry();
    writeCacheFile("openai-abc.json", providerStateDoc("openai", [entry]));
    const boundary = readFreshQuotaBoundary("openai/gpt-5", { dir, now });
    expect(boundary).toBe(Date.parse(entry.resetTimeIso as string));
  });

  test("cache older than the TTL gates out to null (category-constant fallback)", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()], {
        timestamp: now - QUOTA_CACHE_FRESH_TTL_MS - 1,
      }),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });

  test("cache at exactly the TTL is still fresh", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()], {
        timestamp: now - QUOTA_CACHE_FRESH_TTL_MS,
      }),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).not.toBeNull();
  });

  test("timestamp in the future beyond the skew is rejected", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()], {
        timestamp: now + QUOTA_FUTURE_SKEW_MS + 1,
      }),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });
});

describe("readFreshQuotaBoundary — provider-to-model mapping", () => {
  test("matches providerId against the model key prefix before the first slash", () => {
    writeCacheFile(
      "zai-abc.json",
      providerStateDoc("zai", [providerReportedEntry()]),
    );
    // The zai file must not answer an openai model key.
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
    expect(readFreshQuotaBoundary("zai/glm-5", { dir, now })).not.toBeNull();
  });

  test("model key without a slash yields null", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()]),
    );
    expect(
      readFreshQuotaBoundary("openai" as ModelKey, { dir, now }),
    ).toBeNull();
  });

  test("earliest resetTimeIso wins among multiple zero-remaining windows", () => {
    const fiveHour = new Date(now + 5 * 3_600_000).toISOString();
    const weekly = new Date(now + 80 * 3_600_000).toISOString();
    writeCacheFile(
      "zai-abc.json",
      providerStateDoc("zai", [
        providerReportedEntry({
          name: "Z.ai 5h",
          percentRemaining: 0,
          resetTimeIso: weekly,
        }),
        providerReportedEntry({
          name: "Z.ai Weekly",
          percentRemaining: 0,
          resetTimeIso: fiveHour,
        }),
      ]),
    );
    expect(readFreshQuotaBoundary("zai/glm-5", { dir, now })).toBe(
      Date.parse(fiveHour),
    );
  });

  test("provider with nothing exhausted returns null (budget-style entry)", () => {
    // Mirrors the real openrouter entry: percentRemaining above zero and no
    // resetTimeIso at all (JSON.stringify drops the undefined key).
    writeCacheFile(
      "openrouter-abc.json",
      providerStateDoc("openrouter", [
        providerReportedEntry({
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          name: "OpenRouter budget",
          percentRemaining: 81.65,
          resetTimeIso: undefined,
        }),
      ]),
    );
    expect(readFreshQuotaBoundary("openrouter/auto", { dir, now })).toBeNull();
  });
});

describe("readFreshQuotaBoundary — entry authority and tolerance", () => {
  test("entries without provider-reported authority are ignored", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [
        providerReportedEntry({
          accounting: {
            resultType: "quota",
            authority: "derived",
          },
        }),
        providerReportedEntry({
          accounting: undefined,
        }),
      ]),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });

  test("entries without a parseable resetTimeIso are skipped, valid ones still contribute", () => {
    const good = new Date(now + 40 * 3_600_000).toISOString();
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [
        providerReportedEntry({ resetTimeIso: "not-a-date" }),
        providerReportedEntry({ resetTimeIso: good }),
      ]),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBe(
      Date.parse(good),
    );
  });

  test("boundary in the past is still reported by the reader; the caller rejects it", () => {
    const past = new Date(now - 3_600_000).toISOString();
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [
        providerReportedEntry({ resetTimeIso: past }),
      ]),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBe(
      Date.parse(past),
    );
  });
});

describe("readFreshQuotaBoundary — fail-open file handling", () => {
  test("missing directory yields null", () => {
    expect(
      readFreshQuotaBoundary("openai/gpt-5", {
        dir: path.join(dir, "absent"),
        now,
      }),
    ).toBeNull();
  });

  test("malformed JSON yields null", () => {
    writeCacheFile("openai-abc.json", "{not valid json}");
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });

  test("duplicate JSON keys yield null", () => {
    const doc = JSON.stringify(
      providerStateDoc("openai", [providerReportedEntry()]),
    );
    // Inject a second providerId key — parseStrictJson must reject it.
    const raw = doc.replace(
      '"providerId":"openai"',
      '"providerId":"openai","providerId":"openai"',
    );
    writeCacheFile("openai-abc.json", raw);
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });

  test("wrong schema version yields null", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()], { version: 1 }),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });

  test("world-writable file is rejected", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()]),
      { mode: 0o646 },
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });

  test("producer-mode 0664 (group-writable, world-readable) is accepted", () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()]),
      { mode: 0o664 },
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).not.toBeNull();
  });

  test("scan caps at MAX_QUOTA_STATE_FILES entries", () => {
    for (let i = 0; i < MAX_QUOTA_STATE_FILES; i++) {
      writeCacheFile(`filler-${i}.json`, providerStateDoc("other", []));
    }
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()]),
    );
    expect(readFreshQuotaBoundary("openai/gpt-5", { dir, now })).toBeNull();
  });
});

describe("parseQuotaProviderState — file-level shape", () => {
  test("non-record, empty providerId, non-finite timestamp → null", () => {
    expect(parseQuotaProviderState(null)).toBeNull();
    expect(parseQuotaProviderState("x")).toBeNull();
    expect(parseQuotaProviderState({ version: 2 })).toBeNull();
    expect(
      parseQuotaProviderState(
        providerStateDoc("openai", [], { providerId: "" }),
      ),
    ).toBeNull();
    expect(
      parseQuotaProviderState(
        providerStateDoc("openai", [], { timestamp: Number.NaN }),
      ),
    ).toBeNull();
  });

  test("result envelope violations → null", () => {
    expect(
      parseQuotaProviderState(
        providerStateDoc("openai", [], { result: undefined }),
      ),
    ).toBeNull();
    const notAttempted = providerStateDoc("openai", []);
    (notAttempted.result as Record<string, unknown>).attempted = false;
    expect(parseQuotaProviderState(notAttempted)).toBeNull();
    const noEntries = providerStateDoc("openai", []);
    delete (noEntries.result as Record<string, unknown>).entries;
    expect(parseQuotaProviderState(noEntries)).toBeNull();
  });
});

describe("getQuotaStateDir — env override", () => {
  test("explicit override wins; ~ expands; unset falls back to the default", () => {
    const env = { OPENCODE_QUOTA_PROVIDER_STATE_DIR: "~/quota-cache" };
    expect(getQuotaStateDir(env)).toBe(path.join(os.homedir(), "quota-cache"));
    expect(getQuotaStateDir({})).toBe(
      path.join(os.homedir(), ".cache", "opencode", "quota-provider-state"),
    );
    expect(getQuotaStateDir({ OPENCODE_QUOTA_PROVIDER_STATE_DIR: "" })).toBe(
      path.join(os.homedir(), ".cache", "opencode", "quota-provider-state"),
    );
  });
});

describe("resolveProviderReportedBoundary — refresh-then-read", () => {
  test("refreshes once via `opencode-quota show`, then reads the boundary", async () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()]),
    );
    const execCalls: Array<{ cmd: string; args: string[]; timeout: number }> =
      [];
    const exec: QuotaRefreshExec = async (cmd, args, opts) => {
      execCalls.push({ cmd, args, timeout: opts.timeout });
      return { stdout: "", stderr: "" };
    };
    const boundary = await resolveProviderReportedBoundary("openai/gpt-5", {
      dir,
      now,
      exec,
    });
    expect(boundary).toBe(
      Date.parse(providerReportedEntry().resetTimeIso as string),
    );
    expect(execCalls).toEqual([
      {
        cmd: QUOTA_REFRESH_COMMAND,
        args: ["show"],
        timeout: QUOTA_REFRESH_TIMEOUT_MS,
      },
    ]);
  });

  test("refresh failure is fail-open: the cached state is still consulted", async () => {
    writeCacheFile(
      "openai-abc.json",
      providerStateDoc("openai", [providerReportedEntry()]),
    );
    const exec: QuotaRefreshExec = async () => {
      throw new Error("ENOENT: opencode-quota not found");
    };
    const boundary = await resolveProviderReportedBoundary("openai/gpt-5", {
      dir,
      now,
      exec,
    });
    expect(boundary).not.toBeNull();
  });

  test("custom timeoutMs is forwarded to the refresh invocation", async () => {
    const execCalls: Array<{ timeout: number }> = [];
    const exec: QuotaRefreshExec = async (_cmd, _args, opts) => {
      execCalls.push({ timeout: opts.timeout });
      return undefined;
    };
    await refreshQuotaProviderState({ exec, timeoutMs: 1234 });
    expect(execCalls).toEqual([{ timeout: 1234 }]);
  });
});
