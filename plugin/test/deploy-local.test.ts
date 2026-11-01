import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  const dependency = join(root, "dependency");
  for (const dir of [
    source,
    join(source, "dist"),
    join(source, "src"),
    join(root, "repo/scripts"),
    join(home, ".config/opencode"),
    bin,
    dependency,
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
      dependencies: { "omr-runtime-fixture": `file:${dependency}` },
      exports: {
        ".": { import: entry, types },
        "./server": { import: entry, types },
      },
    }),
  );
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "omr-runtime-fixture",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  writeFileSync(
    join(dependency, "index.js"),
    'export default "omr-fixture";\n',
  );
  writeFileSync(
    join(source, "dist/index.js"),
    'import id from "omr-runtime-fixture"; export default { id, setup() {}, server() {} };\n',
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
  // interrupt and kill signal the deploy script process, as a run budget
  // would, then let the installer finish so a late publication is visible.
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/sh
if [ "$1" = install ]; then
  echo "$*" >> "$OMR_TEST_INSTALL_LOG"
  case "$OMR_TEST_INSTALL_MODE" in
    real) exec "$OMR_TEST_BUN" "$@" ;;
    fail) echo "fixture package-manager failure" >&2; exit 42 ;;
    interrupt|kill)
      script=$PPID
      while parent=$(ps -o ppid= -p "$script" | tr -d ' ') && [ "$parent" != "$OMR_TEST_RUNNER_PID" ]; do
        [ "$parent" -gt 1 ] || exit 99
        script=$parent
      done
      if [ "$OMR_TEST_INSTALL_MODE" = interrupt ]; then kill -TERM "$script"; else kill -KILL "$script"; fi
      ;;
    incomplete) exit 0 ;;
  esac
  mkdir -p node_modules/omr-runtime-fixture
  echo '{"type":"module","main":"index.js"}' > node_modules/omr-runtime-fixture/package.json
  echo 'export default "omr-fixture";' > node_modules/omr-runtime-fixture/index.js
  exit 0
fi
exec "$OMR_TEST_BUN" "$@"
`,
  );
  chmodSync(join(bin, "bun"), 0o755);
  return { root, source, home, deployed, bin };
}

function deploy(f: ReturnType<typeof fixture>, installMode = "success") {
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
        OMR_TEST_INSTALL_MODE: installMode,
        OMR_TEST_INSTALL_LOG: join(f.root, "install.log"),
        OMR_TEST_RUNNER_PID: String(process.pid),
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

for (const mode of ["fail", "interrupt", "kill", "incomplete"]) {
  test(`dependency install ${mode} preserves the prior loadable runtime`, () => {
    const f = fixture();
    expect(deploy(f).exitCode).toBe(0);
    const previousEntry = readFileSync(join(f.deployed, "dist/index.js"));
    writeFileSync(
      join(f.source, "dist/index.js"),
      'import "omr-runtime-fixture"; export default { id: "replacement" };\n',
    );
    writeFileSync(join(f.root, "install.log"), "");
    const result = deploy(f, mode);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).not.toBe(0);
    expect(stdout).not.toContain("✓ deployed plugin");
    expect(stdout).not.toContain("✓ dependencies installed");
    expect(stdout).not.toContain("==> Done");
    expect(readFileSync(join(f.root, "install.log"), "utf8")).toBe(
      "install --production\n",
    );
    if (mode === "interrupt") expect(result.exitCode).toBe(143);
    if (mode === "kill") expect(result.signalCode).toBe("SIGKILL");
    if (mode === "fail") {
      expect(result.exitCode).toBe(42);
      expect(new TextDecoder().decode(result.stderr)).toContain(
        "fixture package-manager failure",
      );
    }
    expect(readFileSync(join(f.deployed, "dist/index.js"))).toEqual(
      previousEntry,
    );
    const load = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'const mod = await import(process.argv[1] + "/index.js"); if (mod.default.id !== "omr-fixture") process.exit(1);',
        f.deployed,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    );
    expect(new TextDecoder().decode(load.stderr)).toBe("");
    expect(load.exitCode).toBe(0);
    if (mode !== "kill") {
      expect(readdirSync(join(f.root, "runtime"))).toEqual(["plugin"]);
    }
  });
}

test("successful redeploy publishes the complete replacement", () => {
  const f = fixture();
  expect(deploy(f).exitCode).toBe(0);
  writeFileSync(
    join(f.source, "dist/index.js"),
    'import id from "omr-runtime-fixture"; export default { id, replacement: true };\n',
  );
  const result = deploy(f);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(f.deployed, "dist/index.js"))).toEqual(
    readFileSync(join(f.source, "dist/index.js")),
  );
  expect(
    existsSync(join(f.deployed, "node_modules/omr-runtime-fixture/index.js")),
  ).toBe(true);
  expect(readdirSync(join(f.root, "runtime"))).toEqual(["plugin"]);
});

test("failed publication restores the displaced runtime", () => {
  const f = fixture();
  expect(deploy(f).exitCode).toBe(0);
  const previousEntry = readFileSync(join(f.deployed, "dist/index.js"));
  writeFileSync(
    join(f.source, "dist/index.js"),
    'export default { id: "replacement" };\n',
  );
  const mv = Bun.which("mv");
  expect(mv).not.toBeNull();
  writeFileSync(
    join(f.bin, "mv"),
    `#!/bin/sh
case "$2" in
  */.plugin.*/plugin) echo "fixture publication failure" >&2; exit 73 ;;
esac
exec "${mv}" "$@"
`,
  );
  chmodSync(join(f.bin, "mv"), 0o755);
  const result = deploy(f);
  expect(result.exitCode).toBe(73);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    "fixture publication failure",
  );
  expect(readFileSync(join(f.deployed, "dist/index.js"))).toEqual(
    previousEntry,
  );
  expect(readdirSync(join(f.root, "runtime"))).toEqual(["plugin"]);
});

test("real production install publishes an importable runtime with an offline local dependency", () => {
  const f = fixture();
  const result = deploy(f, "real");
  expect(result.exitCode).toBe(0);
  expect(
    existsSync(join(f.deployed, "node_modules/omr-runtime-fixture/index.js")),
  ).toBe(true);
  expect(new TextDecoder().decode(result.stdout)).toContain(
    "✓ deployed plugin",
  );
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
