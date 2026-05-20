#!/usr/bin/env bash
# Asserts make install does NOT touch git hooks. Hook install must be a
# separate `make install-hooks` target invoked explicitly by the user.
#
# This is a contract enforced by the agreement for buildModelFallbackMonorepo:
#   "make install does NOT touch .git/hooks/. Separate make install-hooks
#    target exists with documentation explaining what the hook does."
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

ok() {
	echo "OK:   $*"
}

# 1. `make install` dry-run must not mention .git/hooks or install-hooks.
install_dryrun="$(make -n install 2>&1)"
if echo "$install_dryrun" | grep -q '.git/hooks'; then
	echo "$install_dryrun" >&2
	fail "make install dry-run mentions .git/hooks — install must not touch hooks"
fi
if echo "$install_dryrun" | grep -qE '(^|[[:space:]])install-hooks([[:space:]]|$)'; then
	echo "$install_dryrun" >&2
	fail "make install dry-run invokes install-hooks target — install must not depend on hooks"
fi
ok "make install does not touch .git/hooks"

# 2. The .githooks/pre-push template must run build+test, not install.
hook_path=".githooks/pre-push"
[ -f "$hook_path" ] || fail "$hook_path not found"
if grep -qE '^[[:space:]]*make[[:space:]]+install[[:space:]]*$' "$hook_path"; then
	fail "$hook_path runs 'make install' — should run 'make build && make test'"
fi
if ! grep -qE 'make[[:space:]]+build[[:space:]]*&&[[:space:]]*make[[:space:]]+test' "$hook_path"; then
	fail "$hook_path does not run 'make build && make test'"
fi
ok ".githooks/pre-push runs make build && make test"

# 3. `make install-hooks` target still exists for explicit opt-in.
hooks_dryrun="$(make -n install-hooks 2>&1)"
if ! echo "$hooks_dryrun" | grep -q '.git/hooks'; then
	fail "make install-hooks dry-run does not mention .git/hooks"
fi
ok "make install-hooks exists and installs to .git/hooks"

echo "All Makefile contract checks passed."
