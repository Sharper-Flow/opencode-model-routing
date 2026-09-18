#!/usr/bin/env bash
# schema-contract-check.sh — drift defense for the per-agent routing fields.
#
# The Go writer (internal/config/) and the TypeScript reader (plugin/src/)
# must both reference the canonical field names (`fallback_models`,
# `blocked_models`) as defined in schema/fallback-schema.json. If either side
# stops referencing a field, this script fails — surfacing the most likely
# drift mode (rename without cross-stack update).
#
# Run via: ./schema-contract-check.sh
# Wired into: make lint (post-monorepo wiring)
#
# Exit 0 = contract intact; exit 1 = drift detected.
set -euo pipefail

cd "$(dirname "$0")"

FIELDS=('fallback_models' 'blocked_models')
SCHEMA_FILE='schema/fallback-schema.json'

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

ok() {
	echo "OK:   $*"
}

# 1. Schema file must exist and be syntactically valid JSON.
[ -f "$SCHEMA_FILE" ] || fail "schema file missing: $SCHEMA_FILE"
if command -v jq >/dev/null 2>&1; then
	jq . "$SCHEMA_FILE" >/dev/null || fail "$SCHEMA_FILE is not valid JSON"
else
	# Fallback: use python's json.tool (always available in our dev env).
	python3 -c "import json,sys; json.load(open('$SCHEMA_FILE'))" ||
		fail "$SCHEMA_FILE is not valid JSON (python parse failed)"
fi
ok "$SCHEMA_FILE is valid JSON"

# 2/3/4. Per field: schema must define it; Go writer and TS reader must
# reference it. The TS check is conditional on plugin/ being scaffolded
# (Phase B ran before Phase D).
for FIELD in "${FIELDS[@]}"; do
	# 2. Schema file itself must reference the canonical field name.
	if ! grep -q "\"$FIELD\"" "$SCHEMA_FILE"; then
		fail "$SCHEMA_FILE does not define field name \"$FIELD\""
	fi
	ok "$SCHEMA_FILE defines field \"$FIELD\""

	# 3. Go writer side must reference the field name.
	go_hits=$(rg --no-filename "$FIELD" internal/config/ cmd/ 2>/dev/null | wc -l || true)
	if [ "$go_hits" -lt 1 ]; then
		fail "Go side (internal/config/, cmd/) has no references to \"$FIELD\""
	fi
	ok "Go side references \"$FIELD\" ($go_hits hits)"

	# 4. TS plugin side must reference the field name, IF the directory exists.
	if [ -d "plugin/src" ]; then
		ts_hits=$(rg --no-filename "$FIELD" plugin/src/ 2>/dev/null | wc -l || true)
		if [ "$ts_hits" -lt 1 ]; then
			fail "plugin/src/ has no references to \"$FIELD\" (drift: TS reader does not match writer)"
		fi
		ok "TS plugin side references \"$FIELD\" ($ts_hits hits)"
	else
		echo "SKIP: plugin/src/ not yet scaffolded — TS check for \"$FIELD\" deferred to Phase D"
	fi
done

echo "schema contract check: PASS"
