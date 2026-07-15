#!/usr/bin/env bash
# End-to-end smoke test for the writer→reader contract on
# plugin tuple options: plugin[].1.agents.<name>.fallback_models.
#
# 1. Build the e2e-helper Go binary (which calls ApplyPreferences with a
#    known chain against $OPENCODE_CONFIG_DIR/opencode.json).
# 2. Seed a tempdir with a minimal opencode.json.
# 3. Run the helper.
# 4. Assert the written JSON contains the chain at the canonical path.
# 5. Assert a backup file was created.
# 6. Run a plugin-side bun test that loads the same fixture shape and
#    confirms loadFallbackChains finds the chain.
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

ok() {
	echo "OK:   $*"
}

# 1. Build the helper.
go build -o /tmp/omr-e2e-helper ./cmd/e2e-helper/
ok "built e2e-helper"

# 2. Seed tempdir.
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cat >"$TMPDIR/opencode.json" <<'JSON'
{
  "agent": {
    "adv-researcher": {
      "mode": "subagent"
    }
  }
}
JSON

# 3. Run the helper.
OPENCODE_CONFIG_DIR="$TMPDIR" /tmp/omr-e2e-helper >"$TMPDIR/helper.out" 2>"$TMPDIR/helper.err"
helper_out=$(cat "$TMPDIR/helper.out")
[ "$helper_out" = "OK" ] || fail "helper printed: $helper_out (stderr: $(cat "$TMPDIR/helper.err"))"
ok "helper applied preferences"

# 4. Assert the written JSON contains the chain in routing plugin tuple options.
got=$(python3 -c "
import json, sys
with open('$TMPDIR/opencode.json') as f:
    cfg = json.load(f)
chain = next((
    entry[1].get('agents', {}).get('adv-researcher', {}).get('fallback_models')
    for entry in cfg.get('plugin', [])
    if isinstance(entry, list) and len(entry) > 1 and isinstance(entry[1], dict)
), None)
if chain != ['openai/gpt-5', 'google/gemini-2.5-pro']:
    print('mismatch: ' + repr(chain))
    sys.exit(1)
model = cfg.get('agent', {}).get('adv-researcher', {}).get('model')
if model != 'anthropic/claude-sonnet-4-5':
    print('model mismatch: ' + repr(model))
    sys.exit(1)
print('chain+model OK')
")
[ "$got" = "chain+model OK" ] || fail "JSON shape wrong: $got"
ok "plugin tuple fallback_models written at canonical path"

# 5. Assert a backup file was created.
backups=$(ls "$TMPDIR"/opencode.json.omr-backup.* 2>/dev/null | wc -l)
[ "$backups" -ge 1 ] || fail "no backup file created"
ok "backup file created ($backups)"

# 6. Plugin-side: confirm the loader picks up the same shape. We avoid
#    re-running the full plugin test suite — just exercise the loader on
#    a fixture matching the helper-written JSON. The bun-test runner needs
#    ".test." in the filename, so we drop a temp file in plugin/test/ and
#    clean it up with trap before exit.
E2E_TEST_FILE="$REPO_ROOT/plugin/test/.e2e-smoke-tmp.test.ts"
trap 'rm -rf "$TMPDIR" "$E2E_TEST_FILE"' EXIT
cat >"$E2E_TEST_FILE" <<'TS'
import { test, expect } from "bun:test";
import { loadFallbackChains } from "../src/config/loader.ts";

test("e2e: loader reads chain from plugin tuple options", () => {
  const pluginOptions = {
    agents: {
      "adv-researcher": {
        fallback_models: ["openai/gpt-5", "google/gemini-2.5-pro"],
      },
    },
  };
  const { chains, warnings } = loadFallbackChains({}, undefined, pluginOptions);
  expect(chains.get("adv-researcher")).toEqual(["openai/gpt-5", "google/gemini-2.5-pro"]);
  expect(warnings).toEqual([]);
});
TS

cd plugin
bun test test/.e2e-smoke-tmp.test.ts >"$TMPDIR/bun.out" 2>"$TMPDIR/bun.err" || {
	cat "$TMPDIR/bun.out" "$TMPDIR/bun.err" >&2
	fail "plugin loader e2e test failed"
}
ok "plugin loader picks up chain from tuple options"

cd "$REPO_ROOT"
echo "e2e smoke: PASS"
