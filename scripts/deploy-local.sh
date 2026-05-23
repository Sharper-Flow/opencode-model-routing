#!/usr/bin/env bash
# deploy-local.sh
#
# Deploys the runtime OpenCode model-routing plugin to a stable local-share
# location and validates that OpenCode is configured to load that deployed copy.
#
# Runtime model:
#   dev checkout:        ~/dev/opencode-model-routing/plugin
#   active plugin copy:  ~/.local/share/opencode-model-routing/plugin
#   opencode.jsonc:      plugin[] contains the active plugin copy
#
# Usage:
#   ./scripts/deploy-local.sh           # Deploy plugin + report config drift
#   ./scripts/deploy-local.sh --check   # Check config only, no file changes
#   ./scripts/deploy-local.sh --fix     # Deploy plugin + patch plain JSON config
#   ./scripts/deploy-local.sh --dry-run # Preview without writing

set -euo pipefail

MODE="sync"
DRY_RUN=false
for arg in "$@"; do
	case "$arg" in
	--check) MODE="check" ;;
	--fix) MODE="fix" ;;
	--dry-run) DRY_RUN=true ;;
	--help | -h)
		cat <<'USAGE'
Usage: ./scripts/deploy-local.sh [--check | --fix] [--dry-run]

  no flags   Deploy plugin to ~/.local/share/opencode-model-routing/plugin and report config drift
  --check    Check config only; do not deploy or patch
  --fix      Deploy plugin and patch plain JSON opencode config when possible
  --dry-run  Preview deploy/patch actions without writing
USAGE
		exit 0
		;;
	*)
		echo "Unknown flag: $arg (use --help for usage)" >&2
		exit 1
		;;
	esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GLOBAL_CONFIG="$HOME/.config/opencode"
if [ -f "$GLOBAL_CONFIG/opencode.jsonc" ]; then
	GLOBAL_JSON="$GLOBAL_CONFIG/opencode.jsonc"
	GLOBAL_JSON_IS_JSONC=true
elif [ -f "$GLOBAL_CONFIG/opencode.json" ]; then
	GLOBAL_JSON="$GLOBAL_CONFIG/opencode.json"
	GLOBAL_JSON_IS_JSONC=false
else
	GLOBAL_JSON="$GLOBAL_CONFIG/opencode.json"
	GLOBAL_JSON_IS_JSONC=false
fi

LOCAL_DEPLOY_ROOT="${OMR_LOCAL_DEPLOY_ROOT:-$HOME/.local/share/opencode-model-routing}"
SOURCE_PLUGIN_PATH="$REPO_ROOT/plugin"
RUNTIME_PLUGIN_PATH="$LOCAL_DEPLOY_ROOT/plugin"
PLUGIN_CONFIG_PATH="$RUNTIME_PLUGIN_PATH"
RUNTIME_ENTRY="dist/index.js"
RUNTIME_TYPES="dist/index.d.ts"

echo "==> opencode-model-routing deploy-local ($MODE)"
echo "    plugin: $SOURCE_PLUGIN_PATH -> $RUNTIME_PLUGIN_PATH"

jsonc_to_json() {
	local input
	if [ $# -gt 0 ] && [ -f "$1" ]; then
		input="$(cat "$1")"
	else
		input="$(cat)"
	fi
	if [ "$GLOBAL_JSON_IS_JSONC" = true ]; then
		# Best-effort JSONC stripping for validation only. --fix refuses JSONC so
		# comments are never silently destroyed.
		echo "$input" | sed -E \
			-e 's#/[*]([^*]|[*][^/])*[*]/##g' \
			-e 's#^([[:space:]]*)//.*$#\1#' \
			-e 's#[[:space:]]*//[^\"]*$##'
	else
		printf '%s' "$input"
	fi
}

json_array_contains() {
	local file="$1" jq_path="$2" value="$3"
	jsonc_to_json "$file" | jq --arg value "$value" \
		-e "($jq_path | if type == \"array\" then . else [.] end) | any(. == \$value)" \
		&>/dev/null
}

check_config() {
	local issues=0
	if ! command -v jq >/dev/null 2>&1; then
		echo "    ✗ jq not found — install jq to validate opencode config" >&2
		return 1
	fi
	if [ ! -f "$GLOBAL_JSON" ]; then
		echo "    ✗ config missing: $GLOBAL_JSON"
		return 1
	fi
	if ! jsonc_to_json "$GLOBAL_JSON" | jq empty >/dev/null 2>&1; then
		echo "    ✗ config is not valid JSON/JSONC: $GLOBAL_JSON"
		return 1
	fi
	if json_array_contains "$GLOBAL_JSON" ".plugin // []" "$PLUGIN_CONFIG_PATH"; then
		echo "    ✓ plugin registered: $PLUGIN_CONFIG_PATH"
	else
		echo "    ✗ plugin path missing from .plugin[]"
		echo "       Expected: \"$PLUGIN_CONFIG_PATH\""
		issues=1
	fi
	if jsonc_to_json "$GLOBAL_JSON" | jq -e --arg dev "$SOURCE_PLUGIN_PATH" \
		'((.plugin // []) | if type == "array" then . else [.] end) | any(. == $dev)' \
		>/dev/null 2>&1; then
		echo "    ⚠ dev checkout plugin path still registered: $SOURCE_PLUGIN_PATH"
		issues=1
	fi
	return "$issues"
}

patch_config_if_possible() {
	if check_config; then
		return 0
	fi
	if [ "$GLOBAL_JSON_IS_JSONC" = true ]; then
		echo "    ⚠ config is JSONC — not auto-patching to avoid comment loss"
		echo "      Add manually: \"$PLUGIN_CONFIG_PATH\""
		return 0
	fi

	local backup tmp_json
	backup="$GLOBAL_JSON.omp-backup.$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	tmp_json="$(mktemp)"
	jsonc_to_json "$GLOBAL_JSON" >"$tmp_json"
	jq --arg plugin "$PLUGIN_CONFIG_PATH" --arg dev "$SOURCE_PLUGIN_PATH" '
		.plugin = (((.plugin // []) | if type == "array" then . else [.] end)
			| map(select(. != $dev)) + [$plugin] | unique)
	' "$tmp_json" >"$tmp_json.new"
	mv "$tmp_json.new" "$tmp_json"

	if [ "$DRY_RUN" = true ]; then
		echo "    dry-run: would back up $GLOBAL_JSON to $backup"
		echo "    dry-run: would patch .plugin[] with $PLUGIN_CONFIG_PATH"
		rm -f "$tmp_json"
	else
		cp "$GLOBAL_JSON" "$backup"
		mv "$tmp_json" "$GLOBAL_JSON"
		echo "    Backup: $backup"
		echo "    ✓ patched plugin path: $PLUGIN_CONFIG_PATH"
	fi
}

deploy_plugin() {
	if [ ! -d "$SOURCE_PLUGIN_PATH" ]; then
		echo "    ✗ source plugin missing: $SOURCE_PLUGIN_PATH" >&2
		return 1
	fi
	verify_runtime_bundle
	if [ "$DRY_RUN" = true ]; then
		echo "    dry-run verify: $SOURCE_PLUGIN_PATH/$RUNTIME_ENTRY"
		echo "    dry-run sync bundled runtime: $SOURCE_PLUGIN_PATH/{package.json,dist,NOTICE} -> $RUNTIME_PLUGIN_PATH/"
		return 0
	fi
	local tmp_path
	tmp_path="$RUNTIME_PLUGIN_PATH.tmp.$$"
	rm -rf "$tmp_path"
	mkdir -p "$tmp_path/dist" "$(dirname "$RUNTIME_PLUGIN_PATH")"
	cp "$SOURCE_PLUGIN_PATH/package.json" "$tmp_path/package.json"
	if [ -f "$SOURCE_PLUGIN_PATH/NOTICE" ]; then
		cp "$SOURCE_PLUGIN_PATH/NOTICE" "$tmp_path/NOTICE"
	fi
	rsync -a --delete "$SOURCE_PLUGIN_PATH/dist/" "$tmp_path/dist/"
	rm -rf "$RUNTIME_PLUGIN_PATH"
	mv "$tmp_path" "$RUNTIME_PLUGIN_PATH"
	echo "    ✓ deployed plugin: $RUNTIME_PLUGIN_PATH"
}

verify_runtime_bundle() {
	if [ ! -f "$SOURCE_PLUGIN_PATH/$RUNTIME_ENTRY" ]; then
		echo "    ✗ runtime bundle missing: $SOURCE_PLUGIN_PATH/$RUNTIME_ENTRY" >&2
		echo "      Run: cd $SOURCE_PLUGIN_PATH && bun run build" >&2
		return 1
	fi
	if [ ! -f "$SOURCE_PLUGIN_PATH/$RUNTIME_TYPES" ]; then
		echo "    ✗ runtime types missing: $SOURCE_PLUGIN_PATH/$RUNTIME_TYPES" >&2
		echo "      Run: cd $SOURCE_PLUGIN_PATH && bun run build" >&2
		return 1
	fi
	(
		cd "$SOURCE_PLUGIN_PATH"
		bun -e '
const fs = require("fs");
const path = require("path");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const expected = "./dist/index.js";
const expectedTypes = "./dist/index.d.ts";
function fail(message) {
  console.error(`    ✗ ${message}`);
  process.exit(1);
}
if (pkg.main !== expected) fail(`package.json main must be ${expected}`);
if (pkg.types !== expectedTypes) fail(`package.json types must be ${expectedTypes}`);
for (const key of [".", "./server"]) {
  if (pkg.exports?.[key]?.import !== expected) fail(`exports[${key}].import must be ${expected}`);
  if (pkg.exports?.[key]?.types !== expectedTypes) fail(`exports[${key}].types must be ${expectedTypes}`);
}
for (const rel of [pkg.main, pkg.types]) {
  if (!rel.startsWith("./")) fail(`${rel} must be package-relative with ./ prefix`);
  const resolved = path.resolve(process.cwd(), rel);
  if (!resolved.startsWith(process.cwd() + path.sep)) fail(`${rel} resolves outside plugin directory`);
  if (!fs.existsSync(resolved)) fail(`${rel} does not exist`);
}
'
	)
	echo "    ✓ runtime bundle verified: $RUNTIME_ENTRY"
}

if [ "$MODE" = "check" ]; then
	check_config
	exit $?
fi

deploy_plugin
if [ "$MODE" = "fix" ]; then
	patch_config_if_possible || true
else
	check_config || true
fi

echo "==> Done. Restart OpenCode to load the deployed plugin copy."
