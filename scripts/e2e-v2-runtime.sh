#!/usr/bin/env bash
# End-to-end verification of the OMR plugin against a REAL, isolated
# OpenCode 2 binary (v2.x). Discharges the runtime half of:
#   - check:v2-installed-plugin-load-and-hooks
#   - check:v2-fallback-once-and-no-duplicate-replay
#   - check:v1-v2-config-preservation-and-cli (writer half via e2e-helper)
#
# The run is fully isolated from the live installation:
#   - XDG_* directories point into a throwaway fixture
#   - --standalone runs a private server (never the shared background service)
#   - the plugin under test is the PACKED + INSTALLED package, not the
#     workspace copy
#   - OMR state paths (cooldown, availability snapshot, log) point into the
#     fixture
# Nothing outside $FIXTURE is read or written by the OpenCode 2 side.
#
# Environment:
#   OMR_V2_BIN  path to an opencode v2 binary; when unset the script installs
#               @opencode/cli into the fixture (requires network)
#
# Usage: ./scripts/e2e-v2-runtime.sh
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

FIXTURE=$(mktemp -d /tmp/omr-v2-e2e-XXXXXX)
SERVER_PID=""
cleanup() {
	[ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
	if [ "${OMR_E2E_KEEP:-0}" = "1" ]; then
		echo "NOTE: fixture kept at $FIXTURE"
		return
	fi
	rm -rf "$FIXTURE"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. OpenCode 2 binary (never the live ~/.opencode installation).
# ---------------------------------------------------------------------------
V2_BIN="${OMR_V2_BIN:-}"
if [ -z "$V2_BIN" ]; then
	echo "installing isolated OpenCode 2 (@opencode/cli) into fixture"
	npm install --prefix "$FIXTURE/v2" --no-save --loglevel=error @opencode/cli \
		>"$FIXTURE/v2-install.log" 2>&1 ||
		fail "npm install @opencode/cli failed: $(tail -5 "$FIXTURE/v2-install.log")"
	V2_BIN="$FIXTURE/v2/node_modules/.bin/opencode"
fi
v2_version=$("$V2_BIN" --version 2>/dev/null | head -1) ||
	fail "opencode v2 binary not runnable at $V2_BIN"
case "$v2_version" in
opencode\ v2.*) ok "OpenCode 2 runtime: $v2_version" ;;
*) fail "expected an opencode v2 binary, got: $v2_version" ;;
esac

# ---------------------------------------------------------------------------
# 2. Build, pack, and install the plugin package (the shipped bytes).
# ---------------------------------------------------------------------------
(cd plugin && npm pack --json --pack-destination "$FIXTURE" \
	>"$FIXTURE/pack.log" 2>&1) ||
	fail "npm pack failed: $(tail -5 "$FIXTURE/pack.log")"
TARBALL=$(find "$FIXTURE" -maxdepth 1 -name '*.tgz' | head -1)
[ -n "$TARBALL" ] || fail "no tarball produced in fixture"
npm install --prefix "$FIXTURE/install" --no-save --loglevel=error "$TARBALL" \
	>"$FIXTURE/install.log" 2>&1 ||
	fail "npm install of plugin tarball failed: $(tail -5 "$FIXTURE/install.log")"
PKG_PATH="$FIXTURE/install/node_modules/@sharper-flow/opencode-model-routing-plugin"
[ -f "$PKG_PATH/dist/index.js" ] || fail "installed package missing dist/index.js"
ok "installed plugin package at $PKG_PATH"

# ---------------------------------------------------------------------------
# 3. Stub OpenAI-compatible provider: /fail/* always 500, /ok/* completes.
#    Every request body is appended to $FIXTURE/requests.jsonl for asserts.
# ---------------------------------------------------------------------------
PORT=$((RANDOM % 20000 + 20000))
cat >"$FIXTURE/stub-server.ts" <<EOF
import { appendFileSync } from "node:fs";
const port = Number("$PORT");
const logPath = "$FIXTURE/requests.jsonl";
// The parent must actually launch the reviewer subagent, and a static stub
// cannot express a tool call. /parent is stateful: the first request whose
// LAST USER MESSAGE names the subagent task gets an OpenAI-compatible
// subagent tool call, the next one gets the final text. The check reads the
// last user message rather than the whole body: a later continuation request
// legitimately carries the assistant's "PONG" reply in its history and must
// not consume the tool-call turn.
let subagentPhase = 0;
const lastUserMessage = (parsed: any): string => {
	const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i] && msgs[i].role === "user") return String(msgs[i].content ?? "");
	}
	return "";
};
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const body = await req.text();
    let model = "";
    let stream = false;
    let parsed: any = null;
    try {
      parsed = JSON.parse(body);
      model = String(parsed.model ?? "");
      stream = parsed.stream === true;
    } catch {}
    appendFileSync(
      logPath,
      JSON.stringify({ ts: Date.now(), path: url.pathname, model, body }) + "\n",
    );
    if (url.pathname.startsWith("/fail")) {
      return new Response(
        JSON.stringify({ error: { message: "upstream exploded", type: "server_error" } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    const id = "chatcmpl-stub";
    const created = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const chunk = (obj: unknown) =>
      enc.encode("data: " + JSON.stringify(obj) + "\n\n");
    const sse = (chunks: unknown[]) => {
      const s = new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(chunk(ch));
          c.enqueue(enc.encode("data: [DONE]\\n\\n"));
          c.close();
        },
      });
      return new Response(s, { headers: { "content-type": "text/event-stream" } });
    };
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    const textChunks = (content: string, finish: string) => [
      { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" } }] },
      { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content } }] },
      { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ];
    // /parent: first subagent-task request → tool call; later ones → text.
    // The tool-call turn is offered only to the agent-loop request — the one
    // carrying the tools array. The session-title request repeats the same
    // user text with no tools and must not consume the turn.
    if (url.pathname.startsWith("/parent")) {
      const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
      if (
        hasTools &&
        lastUserMessage(parsed).includes("reviewer agent") &&
        subagentPhase === 0
      ) {
        subagentPhase = 1;
        const args = JSON.stringify({
          agent: "reviewer",
          description: "relay pong",
          prompt: "reply with exactly PONG",
        });
        const toolCall = { index: 0, id: "call_omr_e2e", type: "function", function: { name: "subagent", arguments: args } };
        if (stream) {
          return sse([
            { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] } }] },
            { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]);
        }
        return json({
          id, object: "chat.completion", created, model,
          choices: [{ index: 0, message: { role: "assistant", tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
        });
      }
      if (stream) return sse(textChunks("PONG", "stop"));
      return json({
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    // /ok: the fallback rung always completes with PONG.
    if (stream) return sse(textChunks("PONG", "stop"));
    return json({
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});
console.log("stub listening on " + port);
EOF
bun "$FIXTURE/stub-server.ts" >"$FIXTURE/stub.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
	curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
	sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null ||
	fail "stub provider did not start: $(cat "$FIXTURE/stub.log")"
ok "stub provider listening on :$PORT"

# ---------------------------------------------------------------------------
# 4. Fixture config: native V2 shape, plugins array WITHOUT an OMR entry,
#    agents under the V2 "agents" key, three stub providers.
#
#    Model anchoring follows the official V2 agents contract
#    (https://opencode.ai/v2/docs/agents/): a session stores its selected
#    model separately — selecting (or launching) a PRIMARY agent does not
#    change that model — while a SUBAGENT uses its configured model. The
#    parent therefore runs on the top-level default model parentp/p3
#    (healthy), and the failing chain head is anchored ONLY by the native
#    agent model override `agents.reviewer.model` (written by the Go writer
#    below) on the SUBAGENT path. A /fail request in the run delta is thus
#    direct evidence that the override is live-honored: if it were inert,
#    the child would inherit parentp and no /fail traffic could occur.
# ---------------------------------------------------------------------------
CFG_DIR="$FIXTURE/config/opencode"
mkdir -p "$CFG_DIR"
cat >"$CFG_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "parentp/p3",
  "plugins": ["unrelated-other-plugin"],
  "agents": {
    "reviewer": { "mode": "all", "description": "e2e reviewer" }
  },
  "provider": {
    "failp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "failp",
      "options": { "baseURL": "http://127.0.0.1:$PORT/fail", "apiKey": "stub" },
      "models": { "m1": { "name": "m1" } }
    },
    "okp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "okp",
      "options": { "baseURL": "http://127.0.0.1:$PORT/ok", "apiKey": "stub" },
      "models": { "m2": { "name": "m2" } }
    },
    "parentp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "parentp",
      "options": { "baseURL": "http://127.0.0.1:$PORT/parent", "apiKey": "stub" },
      "models": { "p3": { "name": "p3" } }
    }
  }
}
EOF

# A second plugin that records the raw V2 event stream, so the fixture also
# pins the real event payload shapes OMR's V2 event narrowing must accept.
PROBE_DIR="$FIXTURE/probe-plugin"
mkdir -p "$PROBE_DIR"
(cd "$PROBE_DIR" && npm install @opencode/plugin --no-save --loglevel=error \
	>"$FIXTURE/probe-install.log" 2>&1) ||
	fail "probe plugin dependency install failed: $(tail -3 "$FIXTURE/probe-install.log")"
cat >"$PROBE_DIR/index.ts" <<'EOF'
import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";

export default Plugin.define({
	id: "omr.e2e.probe",
	async setup(ctx) {
		const sink = process.env.OMR_PROBE_EVENTS;
		if (!sink) return;
		const controller = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({
					signal: controller.signal,
				})) {
					appendFileSync(sink, JSON.stringify(event) + "\n");
				}
			} catch (err) {
				appendFileSync(sink, JSON.stringify({ probeError: String(err) }) + "\n");
			}
		})();
		return () => controller.abort();
	},
});
EOF

# ---------------------------------------------------------------------------
# 5. First install through the Go writer: ApplyPreferences must append the
#    OMR entry to the existing native plugins array and write the chain
#    there, never a parallel V1 tuple.
# ---------------------------------------------------------------------------
go build -o "$FIXTURE/e2e-helper" ./cmd/e2e-helper/ ||
	fail "e2e-helper build failed"
OPENCODE_CONFIG_DIR="$CFG_DIR" \
	OMR_E2E_AGENT=reviewer \
	OMR_E2E_MODEL=failp/m1 \
	OMR_E2E_CHAIN=failp/m1,okp/m2 \
	"$FIXTURE/e2e-helper" >"$FIXTURE/helper.out" 2>"$FIXTURE/helper.err" ||
	fail "e2e-helper failed: $(cat "$FIXTURE/helper.err")"
[ "$(cat "$FIXTURE/helper.out")" = "OK" ] || fail "helper printed: $(cat "$FIXTURE/helper.out")"

omr_idx=$(jq '[.plugins | to_entries[] | select(.value.package? == "@sharper-flow/opencode-model-routing-plugin") | .key] | .[0]' "$CFG_DIR/opencode.json")
[ "$omr_idx" != "null" ] || fail "writer did not register OMR inside the native plugins array"
[ "$(jq -r ".plugins[$omr_idx].options.agents.reviewer.fallback_models[1]" "$CFG_DIR/opencode.json")" = "okp/m2" ] ||
	fail "fallback chain not written under the native V2 entry"
# The native agent model override under test: the writer must record
# agents.reviewer.model in the V2 agents section (string form).
[ "$(jq -r '.agents.reviewer.model' "$CFG_DIR/opencode.json")" = "failp/m1" ] ||
	fail "writer did not record the native agents.reviewer.model override"
[ "$(jq -r '.plugins[0]' "$CFG_DIR/opencode.json")" = "unrelated-other-plugin" ] ||
	fail "unrelated plugins entry lost during first install"
jq -e 'has("plugin") | not' "$CFG_DIR/opencode.json" >/dev/null ||
	fail "writer created a V1 plugin tuple on a V2-native config"
ok "first install appended the OMR entry to the native plugins array (index $omr_idx) and wrote agents.reviewer.model"

# Point the entry at the installed package: the writer records the npm spec
# (correct for a released package), but the fixture has no registry release,
# and OpenCode 2 npm-installs non-path specs (404 here). The installed
# directory under test IS the package the npm spec names. The probe plugin
# joins the array so the fixture also pins the live V2 event payload shapes.
CFG_TMP=$(mktemp)
jq --arg path "$PKG_PATH" --arg probe "$PROBE_DIR" \
	'.plugins[$omr_idx].package = $path | .plugins += [{package: $probe}]' \
	--argjson omr_idx "$omr_idx" \
	"$CFG_DIR/opencode.json" >"$CFG_TMP" &&
	mv "$CFG_TMP" "$CFG_DIR/opencode.json" ||
	fail "failed to point the OMR entry at the installed package"

# ---------------------------------------------------------------------------
# 6. Run OpenCode 2 (isolated XDG dirs, private server, fixture OMR state).
# ---------------------------------------------------------------------------
export XDG_CONFIG_HOME="$FIXTURE/config"
export XDG_DATA_HOME="$FIXTURE/data"
export XDG_CACHE_HOME="$FIXTURE/cache"
export XDG_STATE_HOME="$FIXTURE/state"
export OMR_LOG_FILE="$FIXTURE/omr.log"
export OPENCODE_MODEL_ROUTING_COOLDOWN="$FIXTURE/cooldown.json"
export OPENCODE_CLAUDE_MAX_AVAILABILITY="$FIXTURE/no-such-snapshot.json"
export OMR_PROBE_EVENTS="$FIXTURE/events.jsonl"

# Two verification runs, one fixture, per the official V2 agents contract
# (https://opencode.ai/v2/docs/agents/) and OMR's subagent short-circuit:
#
#   Run A (subagent): the parent (default primary agent) runs on the
#   top-level default model parentp/p3 — healthy, on its own /parent path.
#   The failing chain head is anchored ONLY by the native agent model
#   override agents.reviewer.model (failp/m1): a SUBAGENT uses its
#   configured model. No --model, no --agent. A /fail request in run A's
#   delta is direct proof the override is live-honored. OMR's subagent
#   short-circuit then aborts the child for the parent handback (subagents
#   never replay in place), so run A must show NO /ok traffic.
#
#   Run B (primary): --model failp/m1 --agent reviewer anchors the head via
#   the CLI flag — the documented PRIMARY semantic (the session keeps its
#   selected model; the agent field does not change it). This is the run
#   where the in-place advance happens: exactly one /fail → advance → one
#   /ok replay, no duplicate.
#
# A prewarm run activates the provider SDK packages
# (@ai-sdk/openai-compatible downloads lazily on first request); without it
# the first request can fail at the SDK-activation layer before any HTTP
# traffic, which races the fixture. Its traffic also warms the request log
# baseline — assertions below consume only per-run deltas.
timeout 120 "$V2_BIN" run --standalone --model parentp/p3 "warm" \
	>/dev/null 2>"$FIXTURE/warm.err" || true
BASELINE_A=$(wc -l <"$FIXTURE/requests.jsonl" 2>/dev/null || echo 0)

# --- Run A: subagent path — native agent model override + short-circuit ----
timeout 300 "$V2_BIN" run --standalone --print-logs \
	"Use the subagent tool to launch the reviewer agent with this task: reply with exactly PONG. When it finishes, reply with its answer." \
	>"$FIXTURE/run-a.out" 2>"$FIXTURE/run-a.err" ||
	fail "run A exited non-zero (see $FIXTURE/run-a.err tail): $(tail -20 "$FIXTURE/run-a.err")"
grep -q "PONG" "$FIXTURE/run-a.out" ||
	fail "run A did not complete after the subagent handback; output: $(cat "$FIXTURE/run-a.out")"
ok "run A (subagent): parent completed after the child handback"

delta_a=$(tail -n +"$((BASELINE_A + 1))" "$FIXTURE/requests.jsonl")
m1_a=$(printf '%s' "$delta_a" | jq -sr '[.[] | select(.path | startswith("/fail"))] | length')
m2_a=$(printf '%s' "$delta_a" | jq -sr '[.[] | select(.path | startswith("/ok"))] | length')
[ "${m1_a:-0}" -ge 1 ] ||
	fail "run A: no request reached the failing provider — the native agents.reviewer.model override did not anchor the subagent"
[ "${m2_a:-0}" -eq 0 ] ||
	fail "run A: the subagent replayed in place ($m2_a /ok request(s)) — the subagent short-circuit must abort the child instead"
grep -q '"event":"fallback.subagent_skip"' "$FIXTURE/omr.log" ||
	fail "run A: OMR logged no fallback.subagent_skip — the child was not handed back"
ok "run A: native agent model override honored ($m1_a request(s) on the configured failp/m1), short-circuit handed the child back with no in-place replay"

# --- Run B: primary path — CLI-anchored head, in-place advance once --------
# Run A's classified failure cooled failp/m1 (persisted in the fixture
# cooldown file; each --standalone run is a fresh server, so only the file
# carries state across runs). Reset it so run B's context hook does not
# preemptively redirect the session off the failing head — run B must
# exercise the retry-hook advance, not a preemptive skip.
rm -f "$FIXTURE/cooldown.json"
BASELINE_B=$(wc -l <"$FIXTURE/requests.jsonl" 2>/dev/null || echo 0)
timeout 300 "$V2_BIN" run --standalone --print-logs --model failp/m1 --agent reviewer \
	"reply with exactly PONG" \
	>"$FIXTURE/run-b.out" 2>"$FIXTURE/run-b.err" ||
	fail "run B exited non-zero (see $FIXTURE/run-b.err tail): $(tail -20 "$FIXTURE/run-b.err")"
grep -q "PONG" "$FIXTURE/run-b.out" ||
	fail "run B did not complete on the fallback model; output: $(cat "$FIXTURE/run-b.out")"
ok "run B (primary): session completed on the fallback model"

delta_b=$(tail -n +"$((BASELINE_B + 1))" "$FIXTURE/requests.jsonl")
m1_b=$(printf '%s' "$delta_b" | jq -sr '[.[] | select(.path | startswith("/fail"))] | length')
m2_b=$(printf '%s' "$delta_b" | jq -sr '[.[] | select(.path | startswith("/ok"))] | length')
[ "${m1_b:-0}" -ge 1 ] || fail "run B: no request reached the failing provider"
[ "${m2_b:-0}" -eq 1 ] ||
	fail "run B: expected exactly 1 request on the fallback model (advance once, no duplicate replay), got ${m2_b:-0}"
ok "run B: fallback advanced exactly once: $m1_b failing request(s) on m1, exactly 1 request on m2"

# ---------------------------------------------------------------------------
# 7. Runtime asserts: plugin load, one fallback advance, no duplicate replay.
# ---------------------------------------------------------------------------
grep -q '"event":"config.loaded"' "$FIXTURE/omr.log" ||
	fail "OMR plugin did not log config.loaded under the real V2 binary; log: $(tail -10 "$FIXTURE/omr.log")"
ok "installed plugin loaded under the real V2 binary (config.loaded present)"

# The advance itself, from OMR's own record: exactly one in-place advance
# across both runs (run A's short-circuit logs fallback.subagent_skip, not
# fallback.success), and it must be the failp/m1 → okp/m2 chain step at
# depth 1. A duplicate replay would surface as a second advance or a second
# approval — the dedup window and the one-approval-per-advance retry hook
# veto both.
jq -se '[
	.[] | select(.event=="fallback.success")
] as $a |
($a | length) == 1
and ([ $a[] | select(.from!="failp/m1" or .to!="okp/m2" or .depth!=1) ] | length) == 0' \
	"$FIXTURE/omr.log" | grep -q true ||
	fail "fallback.success must record exactly one failp/m1 → okp/m2 depth-1 advance"
! grep -q '"event":"fallback.replay_failed"' "$FIXTURE/omr.log" ||
	fail "OMR logged fallback.replay_failed"
ok "OMR recorded exactly one classified failp/m1 → okp/m2 advance (depth 1, no duplicate replay)"

# Config preservation after the live runs.
[ "$(jq -r '.plugins[0]' "$CFG_DIR/opencode.json")" = "unrelated-other-plugin" ] ||
	fail "live run rewrote the unrelated plugins entry"
jq -e 'has("plugin") | not' "$CFG_DIR/opencode.json" >/dev/null ||
	fail "live run produced a V1 plugin tuple"
[ "$(jq -r '.agents.reviewer.description' "$CFG_DIR/opencode.json")" = "e2e reviewer" ] ||
	fail "live run rewrote the agents section"
ok "config preserved after the live run (unrelated entry, agents section, no V1 tuple)"

# Pin the live V2 event payload shapes OMR's narrowing must accept.
if [ -s "$FIXTURE/events.jsonl" ]; then
	shape=$(jq -rs '[.[] | select(.type? == "message.part.updated")][0] // empty' \
		"$FIXTURE/events.jsonl")
	if [ -n "$shape" ]; then
		ok "probe pinned the live message.part.updated shape: $(echo "$shape" | cut -c1-200)"
	else
		echo "NOTE: expected — the live V2 stream has no message.part.updated; types seen: $(jq -sr '[.[].type?] | unique | join(",")' "$FIXTURE/events.jsonl" 2>/dev/null || echo unreadable)"
	fi
else
	echo "NOTE: probe plugin recorded no events"
fi
if grep -q '"event":"ttft.cleared_on_token"' "$FIXTURE/omr.log"; then
	ok "OMR cleared TTFT on live V2 token events (event narrowing works)"
else
	echo "NOTE: OMR logged no ttft.cleared_on_token under the live V2 binary — inspect the pinned shape above"
fi

echo
echo "PASS: OpenCode 2 runtime e2e (installed plugin load, fallback once, no duplicate replay, config preservation)"
