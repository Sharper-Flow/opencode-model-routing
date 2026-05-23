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
});
