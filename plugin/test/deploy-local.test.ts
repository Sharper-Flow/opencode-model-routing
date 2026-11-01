import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(withShim = true) {
  const root = mkdtempSync(join(tmpdir(), "omr-local-deploy-"));
  fixtures.push(root);
  const source = join(root, "repo/plugin");
  const home = join(root, "home");
  const deployed = join(root, "runtime/plugin");
  const bin = join(root, "bin");
  for (const dir of [
    source,
    join(source, "dist"),
    join(source, "src"),
    join(root, "repo/scripts"),
    join(home, ".config/opencode"),
    bin,
  ])
    mkdirSync(dir, { recursive: true });
  copyFileSync(
    new URL("../../scripts/deploy-local.sh", import.meta.url),
    join(root, "repo/scripts/deploy-local.sh"),
  );
  const entry = "./dist/index.js";
  const types = "./dist/index.d.ts";
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "omr-fixture",
      type: "module",
      main: entry,
      types,
      exports: {
        ".": { import: entry, types },
        "./server": { import: entry, types },
      },
    }),
  );
  writeFileSync(
    join(source, "dist/index.js"),
    'export default { id: "omr-fixture", setup() {}, server() {} };\n',
  );
  writeFileSync(join(source, "dist/index.d.ts"), "export default {};\n");
  writeFileSync(join(source, "dist/cli.js"), 'console.log("fixture");\n');
  writeFileSync(join(source, "NOTICE"), "fixture notice\n");
  writeFileSync(join(source, "src/private.ts"), "not deployed\n");
  if (withShim)
    writeFileSync(
      join(source, "index.js"),
      'export { default } from "./dist/index.js";\n',
    );
  writeFileSync(
    join(home, ".config/opencode/opencode.json"),
    JSON.stringify({ plugin: [deployed] }),
  );
  // Run real bundle verification, but keep dependency installation offline.
  writeFileSync(
    join(bin, "bun"),
    '#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\nexec "$OMR_TEST_BUN" "$@"\n',
  );
  chmodSync(join(bin, "bun"), 0o755);
  return { root, source, home, deployed, bin };
}

function deploy(f: ReturnType<typeof fixture>) {
  return Bun.spawnSync(
    ["bash", join(f.root, "repo/scripts/deploy-local.sh"), "--fix"],
    {
      cwd: f.root,
      env: {
        ...process.env,
        HOME: f.home,
        OMR_LOCAL_DEPLOY_ROOT: join(f.root, "runtime"),
        PATH: `${f.bin}:${process.env.PATH}`,
        OMR_TEST_BUN: process.execPath,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
}

test("local deploy includes the V2 directory entry and bundled runtime, not raw source", () => {
  const f = fixture();
  const result = deploy(f);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(f.deployed, "index.js"))).toBe(true);
  for (const file of [
    "package.json",
    "index.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli.js",
    "NOTICE",
  ]) {
    expect(readFileSync(join(f.deployed, file))).toEqual(
      readFileSync(join(f.source, file)),
    );
  }
  expect(existsSync(join(f.deployed, "src"))).toBe(false);
  const load = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      'const entry = Bun.resolveSync("./index", process.argv[1]); const mod = await import(entry); if (mod.default.id !== "omr-fixture" || typeof mod.default.setup !== "function") process.exit(1);',
      f.deployed,
    ],
    { cwd: f.root, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
  );
  expect(new TextDecoder().decode(load.stderr)).toBe("");
  expect(load.exitCode).toBe(0);
});

test("missing V2 entry refuses before replacing an existing deployment", () => {
  const f = fixture(false);
  mkdirSync(f.deployed, { recursive: true });
  writeFileSync(join(f.deployed, "keep"), "existing deployment\n");
  const result = deploy(f);
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("index.js");
  expect(readFileSync(join(f.deployed, "keep"), "utf8")).toBe(
    "existing deployment\n",
  );
});
