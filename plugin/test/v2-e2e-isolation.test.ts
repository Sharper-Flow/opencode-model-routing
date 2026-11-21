import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the runtime fixture disables npm lifecycle scripts for the CLI install", () => {
  const dir = mkdtempSync(join(tmpdir(), "omr-e2e-isolation-"));
  try {
    const npm = join(dir, "npm");
    writeFileSync(
      npm,
      `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = "--ignore-scripts" ]; then
    printf 'lifecycle scripts disabled\n'
    exit 42
  fi
done
printf 'lifecycle scripts enabled\n'
exit 42
`,
    );
    chmodSync(npm, 0o755);
    // The script only probes for bwrap before the install; the stub keeps
    // this test independent of the host having bwrap.
    const bwrap = join(dir, "bwrap");
    writeFileSync(bwrap, "#!/bin/bash\nexit 99\n");
    chmodSync(bwrap, 0o755);
    const result = Bun.spawnSync(["bash", "scripts/e2e-v2-runtime.sh"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        OMR_V2_BIN: "",
        OMR_E2E_KEEP: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("lifecycle scripts disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
