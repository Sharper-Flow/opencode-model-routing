#!/usr/bin/env bash
# Runs the named plugin test files from a clean checkout: installs the locked
# dependencies, then runs bun test on the arguments (paths relative to plugin/).
# Used as a Concord native check harness, where the checkout has no
# node_modules and HOME is private scratch.
set -euo pipefail
cd "$(dirname "$0")/../../plugin"
bun install --frozen-lockfile >/dev/null
exec bun test "$@"
