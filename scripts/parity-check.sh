#!/usr/bin/env bash
#
# Parity check: boot the rewrite in tmux against the keyword mock and assert
# the rendered transcript (mirrors nanocoder's scripts/tui-e2e.sh).
#
# Usage:
#   bash scripts/parity-check.sh <scenario>   # one scenario
#   bash scripts/parity-check.sh all          # every scenario, fresh app each
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT=4123

scenario() { # name -> PROMPT EXPECT
	case "$1" in
		hello) PROMPT="say hello"; EXPECT="Hello from the mock provider!" ;;
		md) PROMPT="md test"; EXPECT="Heading" ;;
		# The transcript scrolls to the tail, so assert the document END.
		mdlong) PROMPT="md long"; EXPECT="Final paragraph" ;;
		tool) PROMPT="read the file"; EXPECT="I ran the tool and it worked" ;;
		bash) PROMPT="run bash"; EXPECT="I ran the tool and it worked" ;;
		multi) PROMPT="parallel tools"; EXPECT="I ran the tool and it worked" ;;
		sequence) PROMPT="sequence"; EXPECT="two files reference it" ;;
		web) PROMPT="web search"; EXPECT="I ran the tool and it worked" ;;
		write) PROMPT="write file"; EXPECT="I ran the tool and it worked" ;;
		git) PROMPT="git status tool"; EXPECT="I ran the tool and it worked" ;;
		skill) PROMPT="skill tool"; EXPECT="I ran the tool and it worked" ;;
		error) PROMPT="trigger the 500"; EXPECT="Server error" ;;
		auth401) PROMPT="trigger the 401"; EXPECT="Authentication failed" ;;
		perm403) PROMPT="trigger the 403"; EXPECT="Access forbidden" ;;
		notfound404) PROMPT="model not found"; EXPECT="Model not found" ;;
		# 429 for the first 3 attempts (mock retryLimit), then the 4th
		# succeeds — proves the client-side rate-limit retry path.
		ratelimit) PROMPT="rate limit"; EXPECT="ok, backoff worked" ;;
		ratelimitfail) PROMPT="trigger the 429"; EXPECT="Rate limit exceeded" ;;
		stall) PROMPT="stall"; EXPECT="ok, stall recovered" ;;
		think) PROMPT="think"; EXPECT="widen the prop type" ;;
		long) PROMPT="long response"; EXPECT="twenty" ;;
		# Robustness scenarios (mock-scenarios.md rows 18-24): the app must
		# stay alive and surface the failure instead of crashing.
		empty) PROMPT="empty"; EXPECT="No keyword matched" ;;
		miderror) PROMPT="midstream"; EXPECT="mock mid-stream failure" ;;
		malformed) PROMPT="malformed tool"; EXPECT="Invalid tool arguments" ;;
		reasoningonly) PROMPT="reasoning only"; EXPECT="produced reasoning but no final response" ;;
		usage) PROMPT="usage"; EXPECT="Token accounting fixture" ;;
		cachehead) PROMPT="cache head"; EXPECT="cache head verified." ;;
		agent) PROMPT="spawn an agent"; EXPECT="Subagent result" ;;
		pr) PROMPT="create pr"; EXPECT="github.com/acme/app/pull/123" ;;
		bg) PROMPT="background bash"; EXPECT="foreground budget" ;;
		compact) PROMPT="two searches"; EXPECT="Ran WebSearch ×2" ;;
		compactmixed) PROMPT="search and fetch"; EXPECT="Ran WebSearch and WebFetch" ;;
		help) PROMPT="/help"; EXPECT="/tool:open-prs — open captured PRs" ;;
		bashbang) PROMPT="!echo opentui-bang"; EXPECT="Executed Bash" ;;
		tasks) PROMPT="make tasks"; EXPECT="scan the repository layout" ;;
		glob) PROMPT="glob files"; EXPECT="Find(src)" ;;
		lsdir) PROMPT="list dir"; EXPECT="LS(src)" ;;
		gitlog) PROMPT="git log"; EXPECT="Merge pull request" ;;
		# The /mock:diff scenario renders file-create/edit/delete previews
		# (numbered, syntax-highlighted). The NEW-file row scrolls off as the
		# script advances, so assert the DELETE row that is visible when the
		# scenario settles.
		makediff) PROMPT="make diff"; EXPECT="8 lines → 0 lines" ;;
		editfile) PROMPT="edit file"; EXPECT="new text" ;;
		xmltool) PROMPT="xml tool"; EXPECT="Read(README.md)" ;;
		repeat) PROMPT="repeat bash"; EXPECT="Repeated tool call detected" ;;
		mcptool) PROMPT="mcp tool"; EXPECT="echo: hello from mcp" ;;
		recover) PROMPT="malformed tool"; EXPECT="Auto-recovered malformed tool call" ;;
		alias) PROMPT="alias tool"; EXPECT="aliased" ;;
		steertool) PROMPT="run bash"; EXPECT="Blocked by steering rule" ;;
		*) echo "unknown scenario: $1" >&2; exit 2 ;;
	esac
}

wait_for() { # session needle tries delay
	local session="$1" needle="$2" tries="${3:-60}" delay="${4:-0.5}"
	for _ in $(seq 1 "$tries"); do
		tmux capture-pane -t "$session" -p | grep -qF "$needle" && return 0
		sleep "$delay"
	done
	return 1
}

wait_for_scrollback() { # session needle tries delay
	local session="$1" needle="$2" tries="${3:-60}" delay="${4:-0.5}"
	for _ in $(seq 1 "$tries"); do
		tmux capture-pane -t "$session" -p -S -120 | grep -qF "$needle" && return 0
		sleep "$delay"
	done
	return 1
}

run_one() {
	local name="$1" prompt="$2" expect="$3"
	local session="otui-parity-$$-$name"
	echo "==> $name"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-$name bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "$prompt"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "$expect" 60; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: $name"
		return 0
	fi
	echo "FAIL: $name ('$expect' not found)" >&2
	tmux capture-pane -t "$session" -p -S -40 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# bg: handover at 15s, completion at ~18s — two phases in one session.
run_bg() {
	local session="otui-parity-$$-bg"
	echo "==> bg"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-bg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "background bash"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "foreground budget" 60 && wait_for "$session" "bg: 1" 20 && wait_for "$session" "Background task completed" 40; then
		# C8: the completion row is expandable — collapsed footer, then Ctrl+O
		# reveals the full script with a collapse hint.
		if ! wait_for "$session" "more lines (ctrl + t to view transcript)" 10; then
			echo "FAIL: bg (expandable footer missing)" >&2
			tmux capture-pane -t "$session" -p -S -30 >&2
			tmux kill-session -t "$session" 2>/dev/null
			return 1
		fi
		tmux send-keys -t "$session" C-o
		if ! wait_for "$session" "(ctrl-o to collapse)" 10; then
			echo "FAIL: bg (Ctrl+O expand)" >&2
			tmux capture-pane -t "$session" -p -S -30 >&2
			tmux kill-session -t "$session" 2>/dev/null
			return 1
		fi
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: bg"
		return 0
	fi
	echo "FAIL: bg (handover/completion not found)" >&2
	tmux capture-pane -t "$session" -p -S -40 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# pr: capture a PR link, then /tool:open-prs lists it.
run_pr() {
	local session="otui-parity-$$-pr"
	echo "==> pr"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-pr bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "create pr"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "github.com/acme/app/pull/123" 30; then
		echo "FAIL: pr (URL not rendered)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "/tool:open-prs"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Opened PR:" 15 && tmux capture-pane -t "$session" -p | grep -qF "github.com/acme/app/pull/123"; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: pr"
		return 0
	fi
	echo "FAIL: pr (/tool:open-prs listing)" >&2
	tmux capture-pane -t "$session" -p -S -30 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# cachehead: rendered text + byte-stable system block in the mock request log.
run_cachehead() {
	local session="otui-parity-$$-cachehead"
	echo "==> cachehead"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-cachehead bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	local start_line
	start_line=$(wc -l < /tmp/otui-mock.jsonl)
	tmux send-keys -t "$session" "cache head"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "cache head verified." 30; then
		echo "FAIL: cachehead (text not rendered)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	# Every logged request must carry a system block, byte-identical across
	# the session (that block is the cache head).
	local stable
	stable=$(node -e '
		const fs = require("fs");
		const start = Number(process.argv[2]);
		const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).slice(start);
		let head = null;
		for (const line of lines) {
			const req = JSON.parse(line);
			const sys = (req.messages ?? []).find(m => m.role === "system");
			if (!sys) { console.log("missing-system"); process.exit(1); }
			if (head === null) head = sys.content;
			else if (sys.content !== head) { console.log("unstable"); process.exit(1); }
		}
		console.log("stable");
	' /tmp/otui-mock.jsonl "$start_line")
	if [ "$stable" = "stable" ]; then
		echo "PASS: cachehead"
		return 0
	fi
	echo "FAIL: cachehead (system block stability: $stable)" >&2
	return 1
}

# clearrun: /clear mid-stream cancels the turn and wipes the transcript.
run_clearrun() {
	local session="otui-parity-$$-clearrun"
	echo "==> clearrun"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-clearrun bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "md long"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Long Markdown" 30; then
		echo "FAIL: clearrun (stream never started)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "/clear"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	sleep 1.5
	if tmux capture-pane -t "$session" -p | grep -qF "Long Markdown"; then
		echo "FAIL: clearrun (transcript not wiped)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	echo "PASS: clearrun"
	return 0
}

# compact: same-family calls collapse to `✦ Ran WebSearch ×2`; Ctrl+O reveals
# the individual `✦ WebSearch(query)` entries, and Ctrl+O collapses again.
run_compact() {
	local session="otui-parity-$$-compact"
	echo "==> compact"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-compact bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "two searches"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Ran WebSearch ×2" 30; then
		echo "FAIL: compact (header not rendered)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" C-o
	if ! wait_for "$session" "nanocoder fullscreen alternate screen" 15; then
		echo "FAIL: compact (Ctrl+O expand)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" C-o
	sleep 1
	if tmux capture-pane -t "$session" -p | grep -qF "(ctrl-o to collapse)"; then
		echo "FAIL: compact (Ctrl+O collapse)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	echo "PASS: compact"
	return 0
}

# retry: /retry re-issues the last prompt — the mock must see it twice.
run_retry() {
	local session="otui-parity-$$-retry"
	echo "==> retry"
	local start_line
	start_line=$(wc -l < /tmp/otui-mock.jsonl)
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-retry bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "long response"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "twenty" 30; then
		echo "FAIL: retry (initial reply)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "/retry"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "twenty" 30; then
		echo "FAIL: retry (re-run reply)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	local matches
	matches=$(tail -n +"$((start_line + 1))" /tmp/otui-mock.jsonl | grep -c '"matched":"long response"' || true)
	if [ "$matches" -ge 2 ]; then
		echo "PASS: retry"
		return 0
	fi
	echo "FAIL: retry (mock saw $matches requests, expected ≥2)" >&2
	return 1
}

# sessions: create a conversation, /clear into a new session, list both, and
# /resume the first by index.
run_sessions() {
	local session="otui-parity-$$-sessions"
	echo "==> sessions"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-sessions bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Hello from the mock provider!" 30
	tmux send-keys -t "$session" "/clear"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	sleep 1.5
	tmux send-keys -t "$session" "/sessions"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Saved sessions (2)" 15; then
		echo "FAIL: sessions (list)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "/resume 1"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Resumed session" 15 && tmux capture-pane -t "$session" -p | grep -qF "Hello from the mock provider!"; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: sessions"
		return 0
	fi
	echo "FAIL: sessions (resume)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# compact: >6 context messages, then /compact reports the reduction.
run_compactcmd() {
	local session="otui-parity-$$-compactcmd"
	echo "==> compactcmd"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-compactcmd bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	for _ in 1 2 3 4; do
		tmux send-keys -t "$session" "say hello"
		sleep 0.3
		tmux send-keys -t "$session" Enter
		wait_for "$session" "Hello from the mock provider!" 20
	done
	tmux send-keys -t "$session" "/compact"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Context compacted" 15; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: compactcmd"
		return 0
	fi
	echo "FAIL: compactcmd" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# queue: a chat message sent while a turn streams is queued and submitted
# when the turn settles.
run_queue() {
	local session="otui-parity-$$-queue"
	echo "==> queue"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-queue bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "md long"
	sleep 0.3
	tmux send-keys -t "$session" Enter
	sleep 0.6
	tmux send-keys -t "$session" "say hello"
	sleep 0.3
	tmux send-keys -t "$session" Enter
	# The `(queued)` row appears briefly while the long md streams, then
	# scrolls off the visible pane — check the scrollback for it.
	if wait_for_scrollback "$session" "(queued) say hello" 10 && wait_for "$session" "Hello from the mock provider!" 30; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: queue"
		return 0
	fi
	echo "FAIL: queue" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# slowbash: the tool row streams its output tail LIVE while the bash runs.
run_slowbash() {
	local session="otui-parity-$$-slowbash"
	echo "==> slowbash"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-slowbash bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "slow bash"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	sleep 1.6
	if ! tmux capture-pane -t "$session" -p | grep -qF "stream line"; then
		echo "FAIL: slowbash (no live output mid-run)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	if wait_for "$session" "I ran the tool and it worked" 30; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: slowbash"
		return 0
	fi
	echo "FAIL: slowbash (settle)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# providers: config file + `--provider` selection, model validation, and the
# request log proves the selected provider's model was used.
run_providers() {
	local session="otui-parity-$$-providers"
	local cfg="/tmp/otui-parity-cfg-$$-providers"
	echo "==> providers"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"primary","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"]},{"id":"alt","baseUrl":"http://127.0.0.1:%s","models":["mock-fast"]}]}\n' "$MOCK_PORT" "$MOCK_PORT" > "$cfg/providers.json"
	local start_line
	start_line=$(wc -l < /tmp/otui-mock.jsonl)
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --provider alt" Enter
	wait_for "$session" '❯' 40
	sleep 1
	if ! tmux capture-pane -t "$session" -p | grep -qF "mock-fast"; then
		echo "FAIL: providers (alt model not active)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Hello from the mock provider!" 30; then
		echo "FAIL: providers (reply)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "/model mock-model-1"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "not in alt's list" 10; then
		echo "FAIL: providers (model validation)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	if tail -n +"$((start_line + 1))" /tmp/otui-mock.jsonl | grep -q '"model":"mock-fast"'; then
		echo "PASS: providers"
		return 0
	fi
	echo "FAIL: providers (log did not show mock-fast)" >&2
	return 1
}

# discovery: modelDiscoveryUrl fetches /v1/models and replaces the static list.
run_discovery() {
	local session="otui-parity-$$-discovery"
	local cfg="/tmp/otui-parity-cfg-$$-discovery"
	echo "==> discovery"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"disc","baseUrl":"http://127.0.0.1:%s","modelDiscoveryUrl":"http://127.0.0.1:%s","models":[]}]}\n' "$MOCK_PORT" "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --provider disc" Enter
	wait_for "$session" '❯' 40
	sleep 2
	tmux send-keys -t "$session" "/model"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "mock-reasoning" 15; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: discovery"
		return 0
	fi
	echo "FAIL: discovery (discovered model not listed)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# editfile: string_replace needs a seeded fixture so 'old text' exists.
run_editfile() {
	local session="otui-parity-$$-editfile"
	echo "==> editfile"
	mkdir -p "$ROOT/scratch"
	printf 'old text\n' > "$ROOT/scratch/mock-edit.txt"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-editfile bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "edit file"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "new text" 30; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: editfile"
		return 0
	fi
	echo "FAIL: editfile" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# mouse: a click on the compact header expands it; clicking again collapses.
run_mouse() {
	local session="otui-parity-$$-mouse"
	echo "==> mouse"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-mouse bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "two searches"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Ran WebSearch ×2 (ctrl-o to expand)" 30; then
		echo "FAIL: mouse (collapsed header)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	# SGR click: <button;col;row — press + release on the header row. The row
	# is computed from the live capture so banner/layout changes don't break it.
	local header_row
	header_row=$(tmux capture-pane -t "$session" -p | grep -n 'Ran WebSearch ×2' | head -1 | cut -d: -f1)
	tmux send-keys -t "$session" $'\x1b[<0;2;'"${header_row}M"
	sleep 0.2
	tmux send-keys -t "$session" $'\x1b[<0;2;'"${header_row}m"
	if ! wait_for "$session" "ctrl-o to collapse" 10; then
		echo "FAIL: mouse (expand click)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	# Let the expansion re-render and the sticky scroll settle before the
	# collapse click — the SGR click can be dropped mid-paint otherwise.
	sleep 1
	# Collapse via the `(ctrl-o to collapse)` FOOTER: the sticky scrollbox
	# keeps the footer visible (the header may scroll up out of the pane).
	local footer_row
	footer_row=$(tmux capture-pane -t "$session" -p | grep -n 'ctrl-o to collapse' | head -1 | cut -d: -f1)
	tmux send-keys -t "$session" $'\x1b[<0;2;'"${footer_row}M"
	sleep 0.2
	tmux send-keys -t "$session" $'\x1b[<0;2;'"${footer_row}m"
	if wait_for "$session" "(ctrl-o to expand)" 10; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: mouse"
		return 0
	fi
	echo "FAIL: mouse (collapse click)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# alt: boots into the alternate screen buffer via --alt-screen.
run_alt() {
	local session="otui-parity-$$-alt"
	echo "==> alt"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-alt bun run dev --alt-screen" Enter
	if wait_for "$session" '❯' 40; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: alt"
		return 0
	fi
	echo "FAIL: alt (no prompt)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# approve/decline: --mode normal gates mutation tools behind a y/n prompt.
run_approval() {
	local decision="$1" expect="$2"
	local session="otui-parity-$$-$decision"
	local cfg="/tmp/otui-parity-cfg-$$-$decision"
	echo "==> $decision"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --mode normal" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "write file"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Approve" 20; then
		echo "FAIL: $decision (no approval prompt)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "$decision"
	sleep 0.3
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "$expect" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: $decision"
		return 0
	fi
	echo "FAIL: $decision ('$expect' not found)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# nano: --profile nano excludes tools outside the 7-tool set.
run_nano() {
	local session="otui-parity-$$-nano"
	echo "==> nano"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-nano bun run dev --profile nano" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "git status tool"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "not available in nano profile" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: nano"
		return 0
	fi
	echo "FAIL: nano" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# cap: maxMessages=4 keeps the provider context at ≤4 messages (log check).
run_cap() {
	local session="otui-parity-$$-cap"
	local cfg="/tmp/otui-parity-cfg-$$-cap"
	echo "==> cap"
	mkdir -p "$cfg"
	printf '{"maxMessages":4}\n' > "$cfg/settings.json"
	local start_line
	start_line=$(wc -l < /tmp/otui-mock.jsonl)
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	for _ in 1 2 3; do
		tmux send-keys -t "$session" "say hello"
		sleep 0.3
		tmux send-keys -t "$session" Enter
		wait_for "$session" "Hello from the mock provider!" 20
	done
	tmux kill-session -t "$session" 2>/dev/null
	local cap_ok
	cap_ok=$(tail -n +"$((start_line + 1))" /tmp/otui-mock.jsonl | node -e '
		const fs = require("fs");
		const lines = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
		let ok = true;
		for (const line of lines) {
			const req = JSON.parse(line);
			const nonSystem = (req.messages ?? []).filter(m => m.role !== "system").length;
			if (nonSystem > 4) { ok = false; }
		}
		console.log(ok ? "ok" : "over");
	')
	if [ "$cap_ok" = "ok" ]; then
		echo "PASS: cap"
		return 0
	fi
	echo "FAIL: cap (context exceeded 4 messages)" >&2
	return 1
}

# runaway: a provider that never finishes is aborted by the B23 stream guard;
# the app surfaces the error and stays alive.
run_runaway() {
	local session="otui-parity-$$-runaway"
	local cfg="/tmp/otui-parity-cfg-$$-runaway"
	echo "==> runaway"
	mkdir -p "$cfg"
	printf '{"streamGuard":{"maxDurationMs":1500}}\n' > "$cfg/settings.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "runaway"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "duration budget" 20; then
		echo "FAIL: runaway (guard error not surfaced)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	sleep 1
	if ! tmux capture-pane -t "$session" -p | grep -qF '❯'; then
		echo "FAIL: runaway (app wedged after the guard)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	echo "PASS: runaway"
	return 0
}

# slim: the nano profile sends a SLIM system prompt (D7) — the mock request
# log must show the nano variant, not the full behavioral guidance.
run_slim() {
	local session="otui-parity-$$-slim"
	local cfg="/tmp/otui-parity-cfg-$$-slim"
	echo "==> slim"
	mkdir -p "$cfg"
	local start_line
	start_line=$(wc -l < /tmp/otui-mock.jsonl)
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --profile nano" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Hello from the mock provider!" 20; then
		echo "FAIL: slim (reply not rendered)" >&2
		tmux capture-pane -t "$session" -p -S -30 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	local slim_ok
	slim_ok=$(tail -n +"$((start_line + 1))" /tmp/otui-mock.jsonl | node -e '
		const fs = require("fs");
		const lines = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
		if (lines.length === 0) { console.log("no-request"); process.exit(0); }
		const sys = (JSON.parse(lines[0]).messages ?? []).find(m => m.role === "system");
		if (!sys) { console.log("no-system"); process.exit(0); }
		console.log(sys.content.includes("Verify your work") ? "full" : "slim");
	')
	if [ "$slim_ok" = "slim" ]; then
		echo "PASS: slim"
		return 0
	fi
	echo "FAIL: slim (nano system prompt not slim: $slim_ok)" >&2
	return 1
}

# skillsub: a skill whose `subscribe:` keywords match the prompt auto-triggers
# (F6) — its body is injected into the request and an info row announces it.
run_skillsub() {
	local session="otui-parity-$$-skillsub"
	local cfg="/tmp/otui-parity-cfg-$$-skillsub"
	echo "==> skillsub"
	mkdir -p "$cfg/skills"
	printf -- '---\nname: helper\ndescription: Test skill.\nsubscribe: [fireworks]\n---\n\nUse the helper instructions.\n' > "$cfg/skills/helper.md"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "fireworks please"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	# The injected skill body becomes the last user message, so the keyword
	# mock replies "No keyword matched" — the auto-trigger row is the signal.
	if wait_for "$session" "Auto-triggered skill helper (subscribe)." 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: skillsub"
		return 0
	fi
	echo "FAIL: skillsub (skill subscribe auto-trigger)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# naturalend: a completed turn appends `Worked for a <adjective> <elapsed>.`
run_naturalend() {
	local session="otui-parity-$$-naturalend"
	echo "==> naturalend"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-naturalend bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Worked for a " 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: naturalend"
		return 0
	fi
	echo "FAIL: naturalend" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# custom: a frontmatter command substitutes args and runs its body as a prompt.
run_customcmd() {
	local session="otui-parity-$$-customcmd"
	local cfg="/tmp/otui-parity-cfg-$$-customcmd"
	echo "==> customcmd"
	mkdir -p "$cfg/commands"
	printf '%s\n' '---' 'name: greet' 'description: Say hello' 'arguments:' '  - name: who' '    type: string' '    required: true' '---' 'Say hello to {{who}}' > "$cfg/commands/greet.md"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "/greet world"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Say hello to world" 20 && wait_for "$session" "Hello from the mock provider!" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: customcmd"
		return 0
	fi
	echo "FAIL: customcmd" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# customtool: a markdown-defined tool registers and executes.
run_customtool() {
	local session="otui-parity-$$-customtool"
	local cfg="/tmp/otui-parity-cfg-$$-customtool"
	echo "==> customtool"
	mkdir -p "$cfg/tools"
	printf '%s\n' '---' 'tool: greet_tool' 'description: Greet someone' 'readOnly: true' '---' 'Greet {{name}} with a friendly message.' > "$cfg/tools/greet_tool.md"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "custom tool"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Greet {{name}} with a friendly message." 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: customtool"
		return 0
	fi
	echo "FAIL: customtool" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# skillmd: the skill tool reads a SKILL.md from the config dir.
run_skillmd() {
	local session="otui-parity-$$-skillmd"
	local cfg="/tmp/otui-parity-cfg-$$-skillmd"
	echo "==> skillmd"
	mkdir -p "$cfg/skills"
	printf '%s\n' '---' 'name: hilinga-local-dev' 'description: Local dev workflow' '---' '# Local dev' 'Run `pnpm run dev` in kserp.' > "$cfg/skills/hilinga-local-dev.md"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "skill tool"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Run pnpm run dev in kserp." 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: skillmd"
		return 0
	fi
	echo "FAIL: skillmd" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# ctx: a small provider contextWindow makes the ctx% estimate non-zero.
run_ctx() {
	local session="otui-parity-$$-ctx"
	local cfg="/tmp/otui-parity-cfg-$$-ctx"
	echo "==> ctx"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"mock","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"],"contextWindow":100}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Hello from the mock provider!" 20
	if tmux capture-pane -t "$session" -p | grep -qE 'ctx ~[1-9][0-9]*%'; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: ctx"
		return 0
	fi
	echo "FAIL: ctx (non-zero ctx% not shown)" >&2
	tmux capture-pane -t "$session" -p -S -10 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# ctxdev: NO declared context window — the E6 models.dev fallback resolves it
# (NANOCODER_MODELS_DEV_URL data: URL replaces the live catalog) and the
# ctx% indicator goes non-zero from that resolved window.
run_ctxdev() {
	local session="otui-parity-$$-ctxdev"
	local cfg="/tmp/otui-parity-cfg-$$-ctxdev"
	echo "==> ctxdev"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"mock","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"]}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_MODELS_DEV_URL='data:application/json,{\"mock-model-1\":{\"context_window\":100}}' NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Hello from the mock provider!" 20
	if tmux capture-pane -t "$session" -p | grep -qE 'ctx ~[1-9][0-9]*%'; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: ctxdev"
		return 0
	fi
	echo "FAIL: ctxdev (models.dev-resolved ctx% not shown)" >&2
	tmux capture-pane -t "$session" -p -S -10 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# interrupt: Esc mid-stream commits the partial and keeps the app alive.
run_interrupt() {
	local session="otui-parity-$$-interrupt"
	echo "==> interrupt"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-interrupt bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "md long"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Long Markdown" 20; then
		echo "FAIL: interrupt (stream never started)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" Escape
	if ! wait_for "$session" "Interrupted by user." 10; then
		echo "FAIL: interrupt (no notice)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	# The empty input shows the shortcut placeholder AFTER a BLINKING caret
	# (`❯ ▌/ commands, …` — the caret toggles between ▌ and a space every
	# ~400ms), so the needle is the caret-independent placeholder text.
	if ! wait_for "$session" '/ commands, ! bash, ↑/↓ history' 10; then
		echo "FAIL: interrupt (app exited)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	echo "PASS: interrupt"
	return 0
}

# autocompact: ctx% crossing the threshold triggers the mechanical compaction
# notice without any /compact command.
run_autocompact() {
	local session="otui-parity-$$-autocompact"
	local cfg="/tmp/otui-parity-cfg-$$-autocompact"
	echo "==> autocompact"
	mkdir -p "$cfg"
	printf '{"autoCompact":{"enabled":true,"threshold":50}}\n' > "$cfg/settings.json"
	printf '{"providers":[{"id":"mock","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"],"contextWindow":20}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Context too large" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: autocompact"
		return 0
	fi
	echo "FAIL: autocompact" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# wizard: /setup-providers collects id/baseUrl/key/models and saves a provider.
run_wizard() {
	local session="otui-parity-$$-wizard"
	local cfg="/tmp/otui-parity-cfg-$$-wizard"
	echo "==> wizard"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "/setup-providers"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Provider id:" 10
	tmux send-keys -t "$session" "wizprov"
	sleep 0.2
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Base URL:" 10
	tmux send-keys -t "$session" "http://127.0.0.1:$MOCK_PORT"
	sleep 0.2
	tmux send-keys -t "$session" Enter
	wait_for "$session" "API key" 10
	tmux send-keys -t "$session" "env:WIZ_KEY"
	sleep 0.2
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Models" 10
	tmux send-keys -t "$session" "mock-model-1, mock-fast"
	sleep 0.2
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Provider 'wizprov' saved" 10; then
		echo "FAIL: wizard (save)" >&2
		tmux capture-pane -t "$session" -p -S -20 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "/providers"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "wizprov" 10; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: wizard"
		return 0
	fi
	echo "FAIL: wizard (listing)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# mode: /mode plan excludes mutation tools (plan mode visible + row notice).
run_mode() {
	local session="otui-parity-$$-mode"
	echo "==> mode"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-mode bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "/mode plan"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "plan mode" 10; then
		echo "FAIL: mode (switch)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "write file"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "not available in plan mode" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: mode"
		return 0
	fi
	echo "FAIL: mode (plan exclusion)" >&2
	tmux capture-pane -t "$session" -p -S -20 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# prefs: /provider + /model persist and restore after a restart.
run_prefs() {
	local session="otui-parity-$$-prefs"
	local session2="otui-parity-$$-prefs2"
	local cfg="/tmp/otui-parity-cfg-$$-prefs"
	echo "==> prefs"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"one","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"]},{"id":"two","baseUrl":"http://127.0.0.1:%s","models":["mock-fast"]}]}\n' "$MOCK_PORT" "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "/provider two"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Switched to two" 10
	tmux send-keys -t "$session" "/model mock-fast"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Switched to mock-fast" 10
	tmux kill-session -t "$session" 2>/dev/null
	tmux new-session -d -s "$session2" -c "$ROOT"
	tmux send-keys -t "$session2" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session2" '❯' 40
	if tmux capture-pane -t "$session2" -p | grep -qF "mock-fast"; then
		tmux kill-session -t "$session2" 2>/dev/null
		echo "PASS: prefs"
		return 0
	fi
	echo "FAIL: prefs (model not restored)" >&2
	tmux capture-pane -t "$session2" -p -S -10 >&2
	tmux kill-session -t "$session2" 2>/dev/null
	return 1
}

# anthropic: sdkProvider 'anthropic' talks /v1/messages with cache breakpoints.
run_anthropic() {
	local session="otui-parity-$$-anthropic"
	local cfg="/tmp/otui-parity-cfg-$$-anthropic"
	echo "==> anthropic"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"claude","baseUrl":"http://127.0.0.1:%s","sdkProvider":"anthropic","apiKey":"env:ANTHROPIC_API_KEY","models":["mock-claude"]}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --provider claude" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Hello from the mock provider!" 20; then
		echo "FAIL: anthropic (reply)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	local ok
	ok=$(tail -3 /tmp/otui-mock.jsonl | node -e '
		const fs = require("fs");
		const lines = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
		const hit = lines.map(JSON.parse).find(j => j.protocol === "anthropic" && j.hasCacheControl && Array.isArray(j.system));
		console.log(hit ? "ok" : "missing");
	')
	if [ "$ok" = "ok" ]; then
		echo "PASS: anthropic"
		return 0
	fi
	echo "FAIL: anthropic (cache breakpoints not logged)" >&2
	return 1
}

# openrouter: provider options land in the request body (E4).
run_openrouter() {
	local session="otui-parity-$$-openrouter"
	local cfg="/tmp/otui-parity-cfg-$$-openrouter"
	echo "==> openrouter"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"openrouter","baseUrl":"http://127.0.0.1:%s","providerOptions":{"openrouter":{"provider":{"order":["DeepSeek"]}}},"models":["mock-model-1"]}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --provider openrouter" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Hello from the mock provider!" 20
	tmux kill-session -t "$session" 2>/dev/null
	if tail -2 /tmp/otui-mock.jsonl | grep -q 'DeepSeek'; then
		echo "PASS: openrouter"
		return 0
	fi
	echo "FAIL: openrouter (body extras missing)" >&2
	return 1
}

# cachekey: promptCacheKey sends the provider-namespaced prompt_cache_key.
run_cachekey() {
	local session="otui-parity-$$-cachekey"
	local cfg="/tmp/otui-parity-cfg-$$-cachekey"
	echo "==> cachekey"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"deepseek","baseUrl":"http://127.0.0.1:%s","promptCacheKey":true,"models":["mock-model-1"]}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --provider deepseek" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Hello from the mock provider!" 20
	tmux kill-session -t "$session" 2>/dev/null
	if tail -2 /tmp/otui-mock.jsonl | grep -q 'prompt_cache_key'; then
		echo "PASS: cachekey"
		return 0
	fi
	echo "FAIL: cachekey" >&2
	return 1
}

# steerblock: a matching steering rule blocks the turn without a request.
run_steerblock() {
	local session="otui-parity-$$-steerblock"
	local cfg="/tmp/otui-parity-cfg-$$-steerblock"
	echo "==> steerblock"
	mkdir -p "$cfg"
	printf '%s\n' '{"enabled":true,"rules":[{"id":"block-forbidden","match":{"keyword":"forbidden"},"action":"block","message":"Blocked by policy."}]}' > "$cfg/steering.json"
	local start_line
	start_line=$(wc -l < /tmp/otui-mock.jsonl)
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "forbidden task"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "rule=block-forbidden" 15; then
		echo "FAIL: steerblock (no InnerDaemon row)" >&2
		tmux capture-pane -t "$session" -p -S -15 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	if ! wait_for "$session" "Blocked by policy." 10; then
		echo "FAIL: steerblock (no block message)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	if [ "$(wc -l < /tmp/otui-mock.jsonl)" -eq "$start_line" ]; then
		echo "PASS: steerblock"
		return 0
	fi
	echo "FAIL: steerblock (a request was sent)" >&2
	return 1
}

# steerinject: an inject rule's text reaches the request body.
run_steerinject() {
	local session="otui-parity-$$-steerinject"
	local cfg="/tmp/otui-parity-cfg-$$-steerinject"
	echo "==> steerinject"
	mkdir -p "$cfg"
	printf '%s\n' '{"enabled":true,"rules":[{"id":"add-tests","match":{"keyword":"add context"},"action":"inject","inject":"Remember to mention unit tests"}]}' > "$cfg/steering.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "add context"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "rule=add-tests" 15; then
		echo "FAIL: steerinject (no InnerDaemon row)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	if tail -2 /tmp/otui-mock.jsonl | grep -q 'Remember to mention unit tests'; then
		echo "PASS: steerinject"
		return 0
	fi
	echo "FAIL: steerinject (injection missing from request)" >&2
	return 1
}

# watchdog: a within-turn budget abort surfaces the InnerDaemon timeout row.
run_watchdog() {
	local session="otui-parity-$$-watchdog"
	local cfg="/tmp/otui-parity-cfg-$$-watchdog"
	echo "==> watchdog"
	mkdir -p "$cfg"
	printf '{"watchdogMs":1500}\n' > "$cfg/settings.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "md long"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "rule=watchdog" 15 && wait_for "$session" "Interrupted by watchdog." 10; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: watchdog"
		return 0
	fi
	echo "FAIL: watchdog" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# diagnostics: a tool turn injects an LSP diagnostics summary row (B21).
run_diagnostics() {
	local session="otui-parity-$$-diagnostics"
	echo "==> diagnostics"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-diagnostics bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "read the file"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "no issues found" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: diagnostics"
		return 0
	fi
	echo "FAIL: diagnostics" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# diagissues: with an LSP fixture, the status line shows the issue count
# (C12) after the auto-diagnostics pass runs.
run_diagissues() {
	local session="otui-parity-$$-diagissues"
	echo "==> diagissues"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_DIAG_FIXTURE='2 issues found in src/app.tsx' NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-diagissues bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "read the file"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	# The reference status line has no LSP counter — the /lsp command reports it.
	if ! wait_for "$session" "2 issues found" 20; then
		echo "FAIL: diagissues (fixture not applied)" >&2
		tmux capture-pane -t "$session" -p -S -15 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "/lsp" Enter
	if wait_for "$session" "LSP diagnostics: 2 issues" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: diagissues"
		return 0
	fi
	echo "FAIL: diagissues (/lsp count)" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# privacy: configured patterns are scrubbed from the outgoing request.
run_privacy() {
	local session="otui-parity-$$-privacy"
	local cfg="/tmp/otui-parity-cfg-$$-privacy"
	echo "==> privacy"
	mkdir -p "$cfg"
	printf '{"privacy":{"patterns":[{"pattern":"sk-[A-Za-z0-9]{16}","placeholder":"<SECRET>"}]}}\n' > "$cfg/settings.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "hello with key sk-ABCDEFGHIJKLMNOP"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Hello from the mock provider!" 20
	tmux kill-session -t "$session" 2>/dev/null
	if tail -2 /tmp/otui-mock.jsonl | grep -q '<SECRET>' && ! tail -2 /tmp/otui-mock.jsonl | grep -q 'sk-ABCDEFGHIJKLMNOP'; then
		echo "PASS: privacy"
		return 0
	fi
	echo "FAIL: privacy (secret not scrubbed)" >&2
	return 1
}

# mcp: a stdio MCP server's tools register and execute via tools/call.
run_mcp() {
	local session="otui-parity-$$-mcp"
	local cfg="/tmp/otui-parity-cfg-$$-mcp"
	echo "==> mcp"
	mkdir -p "$cfg"
	printf '{"servers":[{"id":"test","command":"node","args":["%s/tools/mcp-test-server.mjs"]}]}\n' "$ROOT" > "$cfg/mcp.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	if ! wait_for "$session" "MCP server 'test' connected" 15; then
		echo "FAIL: mcp (server not connected)" >&2
		tmux capture-pane -t "$session" -p -S -15 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux send-keys -t "$session" "mcp tool"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "echo: hello from mcp" 20; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: mcp"
		return 0
	fi
	echo "FAIL: mcp (tool call)" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# leaktags: `<think>` blocks streamed in content are stripped (B6).
run_leaktags() {
	local session="otui-parity-$$-leaktags"
	echo "==> leaktags"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-leaktags bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "leak tags"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Before answering" 20; then
		echo "FAIL: leaktags (no reply)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	if tmux capture-pane -t "$session" -p | grep -q 'internal reasoning'; then
		echo "FAIL: leaktags (think block not stripped)" >&2
		tmux capture-pane -t "$session" -p -S -10 >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	echo "PASS: leaktags"
	return 0
}

# sessiondel: /session delete removes the current session and starts fresh.
run_sessiondel() {
	local session="otui-parity-$$-sessiondel"
	echo "==> sessiondel"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=/tmp/otui-parity-cfg-$$-sessiondel bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	wait_for "$session" "Hello from the mock provider!" 20
	tmux send-keys -t "$session" "/session delete last"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Deleted session" 10 && ! tmux capture-pane -t "$session" -p | grep -q "Hello from the mock provider!"; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: sessiondel"
		return 0
	fi
	echo "FAIL: sessiondel" >&2
	tmux capture-pane -t "$session" -p -S -10 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# alwaysallow: D4 — a provider's alwaysAllow list skips the approval prompt.
run_alwaysallow() {
	local session="otui-parity-$$-alwaysallow"
	local cfg="/tmp/otui-parity-cfg-$$-alwaysallow"
	echo "==> alwaysallow"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"trusted","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"],"alwaysAllow":["write_file"]}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev --provider trusted --mode normal" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "write file"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "⎿ Write: 5 lines" 20 && ! tmux capture-pane -t "$session" -p | grep -q "Approve"; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: alwaysallow"
		return 0
	fi
	echo "FAIL: alwaysallow (approval still required)" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# projectprov: E1 — the project providers.json merges with the global file.
run_projectprov() {
	local session="otui-parity-$$-projectprov"
	local cfg="/tmp/otui-parity-cfg-$$-projectprov"
	local work="/tmp/otui-parity-work-$$-projectprov"
	echo "==> projectprov"
	mkdir -p "$cfg" "$work/.nanocoder"
	printf '{"providers":[{"id":"global-one","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"]}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	printf '{"providers":[{"id":"project-two","baseUrl":"http://127.0.0.1:%s","models":["mock-fast"]}]}\n' "$MOCK_PORT" > "$work/.nanocoder/providers.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg NANOCODER_PROJECT_DIR=$work bun run dev --provider project-two" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "/providers"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "project-two (active)" 10 && tmux capture-pane -t "$session" -p | grep -q "global-one"; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: projectprov"
		return 0
	fi
	echo "FAIL: projectprov (merge)" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# steertool: a steering rule matching a tool blocks it before dispatch (B15).
run_steertool() {
	local session="otui-parity-$$-steertool"
	local cfg="/tmp/otui-parity-cfg-$$-steertool"
	echo "==> steertool"
	mkdir -p "$cfg"
	printf '%s\n' '{"enabled":true,"rules":[{"id":"no-bash","match":{"tool":"execute_bash"},"action":"block","message":"Bash disabled by policy."}]}' > "$cfg/steering.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "run bash"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Blocked by steering rule no-bash" 20 && wait_for "$session" "rule=no-bash" 10; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: steertool"
		return 0
	fi
	echo "FAIL: steertool" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# steercollapse: consecutive identical noop traces collapse into one ×N row.
run_steercollapse() {
	local session="otui-parity-$$-steercollapse"
	local cfg="/tmp/otui-parity-cfg-$$-steercollapse"
	echo "==> steercollapse"
	mkdir -p "$cfg"
	printf '%s\n' '{"enabled":true,"rules":[{"id":"trace-all","match":{"keyword":"trace"},"action":"noop"}]}' > "$cfg/steering.json"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	for _ in 1 2 3; do
		tmux send-keys -t "$session" "trace me"
		sleep 0.3
		tmux send-keys -t "$session" Enter
		wait_for "$session" "No keyword matched" 20
	done
	if wait_for "$session" 'noop ×3' 10; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: steercollapse"
		return 0
	fi
	echo "FAIL: steercollapse (no ×3)" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# subscribe: a custom command's subscribe keyword auto-injects its body.
run_subscribe() {
	local session="otui-parity-$$-subscribe"
	local cfg="/tmp/otui-parity-cfg-$$-subscribe"
	echo "==> subscribe"
	mkdir -p "$cfg/commands"
	printf '%s\n' '---' 'name: autotests' 'subscribe:' '  - help me' '---' 'Write unit tests for the change.' > "$cfg/commands/autotests.md"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -t "$session" "MOCK_URL=http://127.0.0.1:$MOCK_PORT NANOCODER_CONFIG_DIR=$cfg bun run dev" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "help me with the refactor"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if ! wait_for "$session" "Auto-triggered custom command /autotests" 20; then
		echo "FAIL: subscribe (no trigger)" >&2
		tmux kill-session -t "$session" 2>/dev/null
		return 1
	fi
	tmux kill-session -t "$session" 2>/dev/null
	if tail -2 /tmp/otui-mock.jsonl | grep -q 'Write unit tests for the change'; then
		echo "PASS: subscribe"
		return 0
	fi
	echo "FAIL: subscribe (body not injected)" >&2
	return 1
}

# fallback: the active provider fails (connection) and the next one answers.
run_fallback() {
	local session="otui-parity-$$-fallback"
	local cfg="/tmp/otui-parity-cfg-$$-fallback"
	echo "==> fallback"
	mkdir -p "$cfg"
	printf '{"providers":[{"id":"bad","baseUrl":"http://127.0.0.1:9","models":["broken-model"]},{"id":"good","baseUrl":"http://127.0.0.1:%s","models":["mock-model-1"]}]}\n' "$MOCK_PORT" > "$cfg/providers.json"
	printf 'cd %s && MOCK_URL=http://127.0.0.1:%s NANOCODER_CONFIG_DIR=%s bun run dev --provider bad\n' "$ROOT" "$MOCK_PORT" "$cfg" > "/tmp/otui-fallback-boot-$$.sh"
	tmux new-session -d -s "$session" -c "$ROOT"
	tmux send-keys -l -t "$session" "bash /tmp/otui-fallback-boot-$$.sh"
	sleep 0.4
	tmux send-keys -t "$session" Enter
	wait_for "$session" '❯' 40
	sleep 1
	tmux send-keys -t "$session" "say hello"
	sleep 0.5
	tmux send-keys -t "$session" Enter
	if wait_for "$session" "Hello from the mock provider!" 30; then
		tmux kill-session -t "$session" 2>/dev/null
		echo "PASS: fallback"
		return 0
	fi
	echo "FAIL: fallback" >&2
	tmux capture-pane -t "$session" -p -S -15 >&2
	tmux kill-session -t "$session" 2>/dev/null
	return 1
}

# Ensure the mock is up.
curl -s --max-time 1 "http://127.0.0.1:$MOCK_PORT/health" >/dev/null 2>&1 ||
	(setsid node "$ROOT/../nanocoder/tools/mock-provider/server.mjs" \
		--port "$MOCK_PORT" --log /tmp/otui-mock.jsonl >/tmp/otui-mock.out 2>&1 < /dev/null &
	 sleep 1)

if [ "${1:-all}" = "all" ]; then
	FAILED=0
	for name in hello md mdlong tool bash multi sequence web write git skill error auth401 perm403 notfound404 ratelimit ratelimitfail stall think long empty miderror malformed reasoningonly usage; do
		scenario "$name"
		run_one "$name" "$PROMPT" "$EXPECT" || FAILED=1
	done
	run_bg || FAILED=1
	run_pr || FAILED=1
	run_cachehead || FAILED=1
	run_clearrun || FAILED=1
	run_compact || FAILED=1
	run_retry || FAILED=1
	run_sessions || FAILED=1
	run_compactcmd || FAILED=1
	run_queue || FAILED=1
	run_slowbash || FAILED=1
	run_providers || FAILED=1
	run_discovery || FAILED=1
	run_editfile || FAILED=1
	run_mouse || FAILED=1
	run_alt || FAILED=1
	run_approval y "⎿ Write: 5 lines" || FAILED=1
	run_approval n "Declined by user." || FAILED=1
	run_nano || FAILED=1
	run_cap || FAILED=1
	run_runaway || FAILED=1
	run_slim || FAILED=1
	run_skillsub || FAILED=1
	run_naturalend || FAILED=1
	run_customcmd || FAILED=1
	run_customtool || FAILED=1
	run_skillmd || FAILED=1
	run_ctx || FAILED=1
	run_ctxdev || FAILED=1
	run_interrupt || FAILED=1
	run_autocompact || FAILED=1
	run_wizard || FAILED=1
	run_mode || FAILED=1
	run_prefs || FAILED=1
	run_anthropic || FAILED=1
	run_openrouter || FAILED=1
	run_cachekey || FAILED=1
	run_steerblock || FAILED=1
	run_steerinject || FAILED=1
	run_watchdog || FAILED=1
	run_diagnostics || FAILED=1
	run_diagissues || FAILED=1
	run_privacy || FAILED=1
	run_mcp || FAILED=1
	run_leaktags || FAILED=1
	run_sessiondel || FAILED=1
	run_alwaysallow || FAILED=1
	run_projectprov || FAILED=1
	run_steertool || FAILED=1
	run_steercollapse || FAILED=1
	run_subscribe || FAILED=1
	run_fallback || FAILED=1
	scenario agent
	run_one agent "$PROMPT" "$EXPECT" || FAILED=1
	scenario compactmixed
	run_one compactmixed "$PROMPT" "$EXPECT" || FAILED=1
	scenario help
	run_one help "$PROMPT" "$EXPECT" || FAILED=1
	scenario bashbang
	run_one bashbang "$PROMPT" "$EXPECT" || FAILED=1
	scenario tasks
	run_one tasks "$PROMPT" "$EXPECT" || FAILED=1
	scenario xmltool
	run_one xmltool "$PROMPT" "$EXPECT" || FAILED=1
	scenario repeat
	run_one repeat "$PROMPT" "$EXPECT" || FAILED=1
	scenario recover
	run_one recover "$PROMPT" "$EXPECT" || FAILED=1
	scenario alias
	run_one alias "$PROMPT" "$EXPECT" || FAILED=1
	for name in glob lsdir gitlog makediff; do
		scenario "$name"
		run_one "$name" "$PROMPT" "$EXPECT" || FAILED=1
	done
	[ "$FAILED" -eq 0 ] && echo "ALL PASS" || echo "SOME FAILED"
	exit "$FAILED"
fi

case "${1:-hello}" in
	bg) run_bg ;;
	pr) run_pr ;;
	cachehead) run_cachehead ;;
	clearrun) run_clearrun ;;
	compact) run_compact ;;
	retry) run_retry ;;
	sessions) run_sessions ;;
	compactcmd) run_compactcmd ;;
	queue) run_queue ;;
	slowbash) run_slowbash ;;
	providers) run_providers ;;
	discovery) run_discovery ;;
	editfile) run_editfile ;;
	mouse) run_mouse ;;
	alt) run_alt ;;
	approve) run_approval y "⎿ Write: 5 lines" ;;
	decline) run_approval n "Declined by user." ;;
	nano) run_nano ;;
	cap) run_cap ;;
	runaway) run_runaway ;;
	slim) run_slim ;;
	skillsub) run_skillsub ;;
	naturalend) run_naturalend ;;
	customcmd) run_customcmd ;;
	customtool) run_customtool ;;
	skillmd) run_skillmd ;;
	ctx) run_ctx ;;
	ctxdev) run_ctxdev ;;
	interrupt) run_interrupt ;;
	autocompact) run_autocompact ;;
	wizard) run_wizard ;;
	mode) run_mode ;;
	prefs) run_prefs ;;
	anthropic) run_anthropic ;;
	openrouter) run_openrouter ;;
	cachekey) run_cachekey ;;
	steerblock) run_steerblock ;;
	steerinject) run_steerinject ;;
	watchdog) run_watchdog ;;
	diagnostics) run_diagnostics ;;
	diagissues) run_diagissues ;;
	privacy) run_privacy ;;
	mcp) run_mcp ;;
	leaktags) run_leaktags ;;
	sessiondel) run_sessiondel ;;
	alwaysallow) run_alwaysallow ;;
	projectprov) run_projectprov ;;
	steertool) run_steertool ;;
	steercollapse) run_steercollapse ;;
	subscribe) run_subscribe ;;
	fallback) run_fallback ;;
	alias)
		scenario alias
		run_one alias "$PROMPT" "$EXPECT"
		;;
	recover)
		scenario recover
		run_one recover "$PROMPT" "$EXPECT"
		;;
	mcptool)
		scenario mcptool
		run_one mcptool "$PROMPT" "$EXPECT"
		;;
	repeat)
		scenario repeat
		run_one repeat "$PROMPT" "$EXPECT"
		;;
	xmltool)
		scenario xmltool
		run_one xmltool "$PROMPT" "$EXPECT"
		;;
	glob|lsdir|gitlog|makediff|tasks)
		scenario "${1}"
		run_one "${1}" "$PROMPT" "$EXPECT"
		;;
	agent)
		scenario agent
		run_one agent "$PROMPT" "$EXPECT"
		;;
	*)
		scenario "${1:-hello}"
		run_one "${1:-hello}" "$PROMPT" "$EXPECT"
		;;
esac
