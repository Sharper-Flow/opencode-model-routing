// v2-installed-package.test.ts — the installed-package V2 runtime contract.
//
// The migration guide's verification bar: "For a published package, test the
// installed package rather than only a workspace-linked copy." This suite
// packs the plugin the way a registry would (npm pack → npm install of the
// tarball into a throwaway prefix, resolving the proper-lockfile dependency
// for real), then loads the installed dist entry and drives it through the
// V2 contract shapes as installed @opencode/plugin declares them:
// SessionRetry { sessionID, agent, model: {providerID, id}, error:
// {type, message, status}, attempt, decision } and SessionInterruptInput
// { sessionID, resume }.
//
// check:v2-installed-plugin-load-and-hooks and check:v2-fallback-once-and-
// no-duplicate-replay are discharged here at the package level; the live
// binary-level verification lives in scripts/e2e-v2-runtime.sh.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PLUGIN_ROOT = new URL("..", import.meta.url).pathname;

interface Installed {
  entryHref: string;
  cleanup: () => void;
}

// Pack + install once for the whole suite; the tarball step runs the
// package's own prepack build, so the tested bytes are the shipped bytes.
// The stage dir holds the packed tarball plus a full node_modules install
// (~188 MB) on tmpfs, so every exit path must remove it: a failure inside
// installPackage removes it before rethrowing, and afterAll removes it on
// the success path.
async function installPackage(): Promise<Installed> {
  const stage = mkdtempSync(path.join(tmpdir(), "omr-v2-install-"));
  try {
    return await installInto(stage);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}

async function installInto(stage: string): Promise<Installed> {
  const pack = Bun.spawnSync(
    ["npm", "pack", "--json", "--pack-destination", stage],
    {
      cwd: PLUGIN_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (pack.exitCode !== 0) {
    throw new Error(
      `npm pack failed: ${new TextDecoder().decode(pack.stderr)}`,
    );
  }
  // The prepack build logs to stdout ahead of the JSON payload, so slice
  // from the first array marker instead of parsing the whole stream.
  const packOut = new TextDecoder().decode(pack.stdout);
  const jsonStart = packOut.indexOf("[");
  if (jsonStart < 0) {
    throw new Error(`npm pack produced no JSON payload: ${packOut}`);
  }
  const packed = JSON.parse(packOut.slice(jsonStart)) as Array<{
    filename: string;
  }>;
  const tarball = path.join(stage, packed[0]!.filename);
  const install = Bun.spawnSync(
    [
      "npm",
      "install",
      "--prefix",
      path.join(stage, "install"),
      "--no-save",
      "--loglevel=error",
      tarball,
    ],
    {
      cwd: PLUGIN_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `npm install failed: ${new TextDecoder().decode(install.stderr)}`,
    );
  }
  const pkgDir = path.join(
    stage,
    "install",
    "node_modules",
    "@sharper-flow",
    "opencode-model-routing-plugin",
  );
  return {
    entryHref: `file://${path.join(pkgDir, "dist", "index.js")}`,
    cleanup: () => rmSync(stage, { recursive: true, force: true }),
  };
}

const installed = await installPackage();

afterAll(() => {
  installed.cleanup();
});

describe("installed V2 package", () => {
  test("installs with its runtime dependency and loads the default-export module", async () => {
    // The tarball ships dist, the root index shim, and NOTICE. The dependency
    // tree comes from installation; the installed entry must be loadable.
    const pkgJson = await Bun.file(
      path.join(
        installed.entryHref.slice("file://".length),
        "../../package.json",
      ),
    ).json();
    expect(pkgJson.name).toBe("@sharper-flow/opencode-model-routing-plugin");

    const mod = (await import(installed.entryHref)) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual(["default"]);
    const pluginModule = mod.default as Record<string, unknown>;
    expect(Object.keys(pluginModule).sort()).toEqual(["id", "server", "setup"]);
    expect(pluginModule.id).toBe("@sharper-flow/opencode-model-routing-plugin");
    expect(typeof pluginModule.setup).toBe("function");
  });

  test("V2 setup registers hooks, advances fallback via host retry, and dedups repeats", async () => {
    const mod = (await import(installed.entryHref)) as Record<string, unknown>;
    const setup = (mod.default as Record<string, unknown>).setup as (
      ctx: unknown,
    ) => Promise<(() => void) | undefined>;

    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const hooks = new Map<string, (event: unknown) => unknown>();
    const chain = ["anthropic/claude-opus-4-1", "openai/gpt-5.2"];
    const cleanup = await setup({
      options: { agents: { general: { fallback_models: chain } } },
      session: {
        get: async (input: Record<string, unknown>) => {
          calls.push({ method: "get", args: input });
          return { id: input.sessionID };
        },
        context: async (input: Record<string, unknown>) => {
          calls.push({ method: "context", args: input });
          return [];
        },
        switchModel: async (input: Record<string, unknown>) => {
          calls.push({ method: "switchModel", args: input });
        },
        interrupt: async (input: Record<string, unknown>) => {
          calls.push({ method: "interrupt", args: input });
        },
        prompt: async (input: Record<string, unknown>) => {
          calls.push({ method: "prompt", args: input });
        },
        hook: async (name: unknown, callback: (event: unknown) => unknown) => {
          hooks.set(String(name), callback);
          return { dispose: async () => {} };
        },
      },
      event: {
        subscribe: () => (async function* () {})(),
      },
    });
    expect(typeof cleanup).toBe("function");
    expect([...hooks.keys()].sort()).toEqual(["context", "retry"]);

    // Real V2 SessionContext shape: model is { providerID, id }.
    await hooks.get("context")!({
      sessionID: "ses1",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
    });

    // Real V2 SessionRetry shape; the failure advances the chain once.
    const retry = (over: Record<string, unknown> = {}) => ({
      sessionID: "ses1",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
      error: { type: "APIError", message: "upstream exploded", status: 500 },
      attempt: 1,
      decision: { retry: true, delay: 1000 },
      ...over,
    });
    const first = retry();
    await hooks.get("retry")!(first);
    // OMR advanced the chain and approves exactly one host retry at a short
    // delay — the host re-drives the loop on the switched session model.
    expect(first.decision).toEqual({ retry: true, delay: 250 });
    expect(calls.filter((c) => c.method === "switchModel")).toEqual([
      {
        method: "switchModel",
        args: {
          sessionID: "ses1",
          model: { providerID: "openai", id: "gpt-5.2" },
        },
      },
    ]);
    // The replay is the host retry — the tail never interrupts, and the
    // V1-only prompt surface never fires under V2.
    expect(calls.filter((c) => c.method === "interrupt").length).toBe(0);
    expect(calls.filter((c) => c.method === "prompt").length).toBe(0);

    // A duplicate copy of the same failure must not replay again, and the
    // host decision on a duplicate is left untouched.
    const dup = retry();
    await hooks.get("retry")!(dup);
    expect(dup.decision).toEqual({ retry: true, delay: 1000 });
    expect(calls.filter((c) => c.method === "switchModel").length).toBe(1);
    expect(calls.filter((c) => c.method === "interrupt").length).toBe(0);

    cleanup?.();
  });
});
