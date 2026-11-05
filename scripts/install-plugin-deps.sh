#!/usr/bin/env bash
set -euo pipefail

if [ "${1-}" = "--help" ]; then
	printf '%s\n' 'Usage: bash scripts/install-plugin-deps.sh DIRECTORY [bun install flags...]' \
		'OMR_DEPLOY_INSTALL_TIMEOUT_SECONDS sets the install deadline in seconds (1-3600, default 60).' \
		'Installs require GNU or uutils timeout, use a frozen lockfile, no retries, and a 5-second kill grace.'
	exit 0
fi
if [ "$#" -lt 1 ]; then
	echo "Usage: bash scripts/install-plugin-deps.sh DIRECTORY [bun install flags...]" >&2
	exit 2
fi
directory=$1
shift
install_timeout="${OMR_DEPLOY_INSTALL_TIMEOUT_SECONDS-60}"
if [[ ! "$install_timeout" =~ ^[1-9][0-9]{0,3}$ ]] || [ "$install_timeout" -gt 3600 ]; then
	echo "    ✗ OMR_DEPLOY_INSTALL_TIMEOUT_SECONDS must be an integer from 1 to 3600" >&2
	exit 1
fi
cd "$directory"

child=""
interrupted=0
interrupt_install() {
	local status=$1
	if [ -z "$child" ]; then
		interrupted=$status
		return
	fi
	trap '' INT TERM
	kill -TERM "$child" 2>/dev/null || :
	wait "$child" 2>/dev/null || :
	echo "    ✗ dependency install interrupted (budget: ${install_timeout} seconds, status: $status)" >&2
	exit "$status"
}
trap 'interrupt_install 130' INT
trap 'interrupt_install 143' TERM
timeout --kill-after=5s "${install_timeout}s" bun install "$@" --frozen-lockfile &
child=$!
if [ "$interrupted" -ne 0 ]; then
	interrupt_install "$interrupted"
fi
if wait "$child"; then
	exit 0
else
	status=$?
	echo "    ✗ dependency install failed (budget: ${install_timeout} seconds, status: $status)" >&2
	exit "$status"
fi
