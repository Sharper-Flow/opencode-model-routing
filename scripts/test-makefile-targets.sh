#!/usr/bin/env bash
# Asserts make install does NOT touch git hooks. Hook install must be a
# separate `make install-hooks` target invoked explicitly by the user.
#
# This is a contract enforced by the build/install agreement:
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

# 1b. Default build/install path must be OMR-native.
build_dryrun="$(make -n build 2>&1)"
if ! echo "$build_dryrun" | grep -q 'go build -o omr ./cmd/omr/'; then
	echo "$build_dryrun" >&2
	fail "make build must build the OMR-native cmd/omr binary"
fi
if ! echo "$install_dryrun" | grep -q 'cp omr '; then
	echo "$install_dryrun" >&2
	fail "make install must install the omr binary by default"
fi
ok "make build/install target omr by default"

# 2. The .githooks/pre-push template must run build+test and deploy-local,
#    not install.
hook_path=".githooks/pre-push"
[ -f "$hook_path" ] || fail "$hook_path not found"
if grep -qE '^[[:space:]]*make[[:space:]]+install[[:space:]]*$' "$hook_path"; then
	fail "$hook_path runs 'make install' — should run 'make build && make test'"
fi
if ! grep -qE 'make[[:space:]]+build[[:space:]]*&&[[:space:]]*make[[:space:]]+test' "$hook_path"; then
	fail "$hook_path does not run 'make build && make test'"
fi
if ! grep -q 'scripts/deploy-local.sh' "$hook_path"; then
	fail "$hook_path does not run scripts/deploy-local.sh"
fi
ok ".githooks/pre-push runs make build && make test, then deploy-local"

# 3. `make install-hooks` target still exists for explicit opt-in.
hooks_dryrun="$(make -n install-hooks 2>&1)"
if ! echo "$hooks_dryrun" | grep -q '.git/hooks'; then
	fail "make install-hooks dry-run does not mention .git/hooks"
fi
ok "make install-hooks exists and installs to .git/hooks"

# 4. Local plugin deployment script must install to stable ~/.local/share path
#    and register that deployed path, not the dev checkout plugin path.
deploy_script="scripts/deploy-local.sh"
[ -x "$deploy_script" ] || fail "$deploy_script not found or not executable"
if ! grep -q 'LOCAL_DEPLOY_ROOT="${OMR_LOCAL_DEPLOY_ROOT:-$HOME/.local/share/opencode-model-routing}"' "$deploy_script"; then
	fail "$deploy_script does not define the stable local deployment root"
fi
if ! grep -q 'PLUGIN_CONFIG_PATH="$RUNTIME_PLUGIN_PATH"' "$deploy_script"; then
	fail "$deploy_script does not register the runtime plugin path"
fi
if grep -q 'PLUGIN_CONFIG_PATH="$REPO_ROOT/plugin"' "$deploy_script"; then
	fail "$deploy_script registers the dev checkout plugin path"
fi
ok "deploy-local uses stable local-share plugin path"

echo "All Makefile contract checks passed."
