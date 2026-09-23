import { describe, expect, test } from "bun:test";

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();

describe("package runtime contract", () => {
  test("loads the bundled ESM runtime entry, not raw TypeScript source", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.main).not.toContain("src/");
    expect(pkg.main).not.toEndWith(".ts");
  });

  test("declares type and server exports for OpenCode resolution", () => {
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(pkg.exports?.["./server"]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
  });

  test("has build and package lifecycle scripts", () => {
    expect(pkg.scripts?.build).toBe("tsup");
    expect(pkg.scripts?.prepack).toBe("bun run build");
  });

  test("built runtime exposes the dual V1/V2 default plugin module", async () => {
    const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode, new TextDecoder().decode(install.stderr)).toBe(0);

    const build = Bun.spawnSync(["bun", "run", "build"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

    // AC1: CooldownStore must NOT be tree-shaken out of the production bundle.
    // Before the wiring fix, new FallbackStore() passed no cooldownStore, so
    // CooldownStore was dead code and tree-shaken (0 markers). After the fix,
    // the production init path instantiates it — these markers must be present.
    const distPath = new URL("../dist/index.js", import.meta.url);
    const distContent = await Bun.file(distPath).text();
    expect(
      distContent,
      "CooldownStore class must be in the bundle (not tree-shaken)",
    ).toContain("CooldownStore");
    expect(
      distContent,
      "cooldown.json path constant must be in the bundle",
    ).toContain("cooldown.json");

    // Dual-runtime entrypoint: only the default export (the legacy V1 loader
    // treats every function-valued module export as a plugin), carrying the
    // V1 server() and the V2 { id, setup } members from one object.
    const mod = (await import(
      new URL("../dist/index.js", import.meta.url).href
    )) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(typeof mod.default).toBe("object");
    const pluginModule = mod.default as Record<string, unknown>;
    expect(Object.keys(pluginModule).sort()).toEqual(["id", "server", "setup"]);
    expect(pluginModule.id).toBe("@sharper-flow/opencode-model-routing-plugin");
    expect(typeof pluginModule.server).toBe("function");
    expect(typeof pluginModule.setup).toBe("function");

    // The V2 setup must reject a context that lacks the session domain it
    // registers hooks on — a structural mismatch must be loud, not silent.
    const setup = pluginModule.setup as (ctx: unknown) => Promise<unknown>;
    await expect(setup({})).rejects.toThrow(
      "invalid OpenCode 2 plugin context",
    );
    await expect(setup(null)).rejects.toThrow(
      "invalid OpenCode 2 plugin context",
    );

    // V2 decode + hook registration against the built artifact (the bytes
    // an installed package ships): OpenCode 2 reads default.id + default.setup;
    // setup must register the context and retry hooks on a valid host and
    // return a working cleanup.
    const registered: string[] = [];
    let cleanupRan = false;
    const controller = new AbortController();
    const v2SetupResult = await setup({
      options: { agents: { general: { fallback_models: ["a/one"] } } },
      session: {
        get: async () => ({}),
        context: async () => [],
        switchModel: async () => ({}),
        interrupt: async () => ({}),
        prompt: async () => ({}),
        hook: async (name: unknown) => {
          registered.push(String(name));
          return { dispose: async () => {} };
        },
      },
      event: {
        subscribe: (opts?: { signal?: AbortSignal }) => {
          opts?.signal?.addEventListener("abort", () => controller.abort());
          // Live-stream stand-in: never yields, ends only via abort.
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise<IteratorResult<unknown>>(() => {}),
              };
            },
          };
        },
      },
    });
    expect(registered.sort()).toEqual(["context", "retry"]);
    expect(typeof v2SetupResult).toBe("function");
    (v2SetupResult as () => void)();
    cleanupRan = controller.signal.aborted;
    expect(cleanupRan).toBe(true);

    // The V1 half stays loadable from the same artifact: server() is the
    // async Plugin function OpenCode 1.18.29+ calls, and it guards its init
    // input.
    const server = pluginModule.server as (
      input: unknown,
      options?: unknown,
    ) => Promise<Record<string, unknown>>;
    expect(typeof server).toBe("function");
    await expect(server({ client: {} })).rejects.toThrow(
      "invalid initialization input",
    );
  }, 20_000);
});
