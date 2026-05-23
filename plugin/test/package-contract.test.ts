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

  test("built runtime exposes only the V1 default plugin module", async () => {
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

    const mod = await import("../dist/index.js");
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(typeof mod.default).toBe("object");
    expect(Object.keys(mod.default).sort()).toEqual(["id", "server"]);
    expect(mod.default.id).toBe("@sharper-flow/opencode-model-routing-plugin");
    expect(typeof mod.default.server).toBe("function");
  });
});
