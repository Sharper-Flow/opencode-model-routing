#!/usr/bin/env bash
# Runs the named plugin test files (paths relative to plugin/) from a private
# copy of plugin/: installs the locked dependencies in the copy, then runs
# bun test there. The checkout itself is never written, so a Concord native
# check host sees the same candidate inputs after the run as before it.
set -euo pipefail
src="$(cd "$(dirname "$0")/../../plugin" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/plugin-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
tar -C "$src" --exclude=./node_modules --exclude=./dist -cf - . | tar -C "$work" -xf -
cd "$work"
bun install --frozen-lockfile >/dev/null
bun test "$@"
