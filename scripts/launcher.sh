#!/usr/bin/env bash
# Release launcher. Keep this supervisor alive when Bun dies, including SIGKILL.
# Killing the supervisor (or the entire process group) with SIGKILL cannot be
# recovered here. Direct `bun run` / development launches bypass this guard.
set +e
set +m

# Resolve paths in a subshell: preserve the user's cwd, arguments, and absolute
# OpenTUI preload even when the user's project has its own node_modules/bunfig.
SOURCE="$0"
while [[ -L "$SOURCE" ]]; do
	SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)" || exit 1
	LINK="$(readlink "$SOURCE")" || exit 1
	if [[ "$LINK" = /* ]]; then
		SOURCE="$LINK"
	else
		SOURCE="$SOURCE_DIR/$LINK"
	fi
done
DIR="$(cd "$(dirname "$SOURCE")/.." && pwd)" || exit 1
PRELOAD=''
SEARCH_DIR="$DIR"
while [[ "$SEARCH_DIR" != / ]]; do
	CANDIDATE="$SEARCH_DIR/node_modules/@opentui/solid/scripts/preload.js"
	if [[ -f "$CANDIDATE" ]]; then
		PRELOAD="$CANDIDATE"
		break
	fi
	SEARCH_DIR="$(dirname "$SEARCH_DIR")"
done
# Keep repository-relative default for build-time isolation and report useful
# failure later if neither local nor hoisted dependency is actually installed.
if [[ -z "$PRELOAD" ]]; then
	PRELOAD="$DIR/node_modules/@opentui/solid/scripts/preload.js"
fi

saved_stty=''
if [[ -t 0 ]]; then
	saved_stty="$(stty -g 2>/dev/null)" || saved_stty=''
fi

renderer_exit_dir=''
cleanup() {
	local status=$?
	trap - EXIT
	trap '' HUP INT QUIT TERM
	local screen_restore='\033[?1049l'
	local margins_restore='\033[r'
	if [[ -n "$renderer_exit_dir" && -f "$renderer_exit_dir/finished" && ! -L "$renderer_exit_dir/finished" ]] &&
		[[ "$(cat "$renderer_exit_dir/finished" 2>/dev/null)" == 'renderer-finished-v1' ]]; then
		# Repeating DECRST 1049 can erase the post-teardown summary. Keep all
		# other mode resets and saved stty restoration, regardless of exit status.
		screen_restore=''
		# DECSTBM also homes the cursor. After the summary, zsh's prompt
		# erase-to-end (CSI J) would then wipe every summary row from home.
		# Native teardown already restored margins before printing the summary.
		margins_restore=''
	fi
	if [[ -t 0 && -t 1 ]]; then
		# End synchronized output; disable mouse encodings/tracking, focus,
		# bracketed paste, Kitty and modifyOtherKeys; leave the alternate screen
		# and restore visible cursor, default style, margins and autowrap.
		# These modes have no portable snapshot API. Restore a shell-safe baseline,
		# not the caller's arbitrary DEC/keyboard mode stack. Do not read/drain stdin.
		printf '\033[?2026l\033[?1000l\033[?1001l\033[?1002l\033[?1003l\033[?1004l\033[?1005l\033[?1006l\033[?1015l\033[?1016l\033[?2004l\033[<u\033[=0u\033[>4;0m' 2>/dev/null || :
		printf '%b' "$screen_restore" 2>/dev/null || :
		printf '\033[0m%b\033[?7h\033[0 q\033[?25h' "$margins_restore" 2>/dev/null || :
	fi
	if [[ -n "$saved_stty" ]]; then
		stty "$saved_stty" 2>/dev/null || :
	fi
	if [[ -n "$renderer_exit_dir" ]]; then
		rm -f -- "$renderer_exit_dir/finished" 2>/dev/null || :
		rmdir -- "$renderer_exit_dir" 2>/dev/null || :
	fi
	exit "$status"
}

child_pid=''
pending_signal=''
interrupted=0
forward_signal() {
	interrupted=1
	if [[ -n "$child_pid" ]]; then
		# The child shares the foreground process group. Never signal the group
		# from this trap: that would signal this supervisor recursively.
		kill -s "$1" "$child_pid" 2>/dev/null || :
	else
		pending_signal="$1"
	fi
}
trap cleanup EXIT
trap 'forward_signal HUP' HUP
trap 'forward_signal INT' INT
trap 'forward_signal QUIT' QUIT
trap 'forward_signal TERM' TERM
# Install traps before allocating the handshake directory so early signals
# retain child forwarding and directory cleanup. Never trust an inherited path.
# Exit status alone cannot prove teardown ran; this stores only a constant marker.
renderer_exit_dir="$(mktemp -d "${TMPDIR:-/tmp}/bobonyo-renderer-exit.XXXXXXXXXX" 2>/dev/null)" || renderer_exit_dir=''
unset BOBONYO_RENDERER_FINISHED_FILE
if [[ -n "$renderer_exit_dir" ]]; then
	export BOBONYO_RENDERER_FINISHED_FILE="$renderer_exit_dir/finished"
fi

# An asynchronous command lets Bash run signal traps immediately during wait.
# With job control OFF it stays in the foreground process group. Explicit stdin
# prevents Bash replacing it with /dev/null; reset async SIGINT/SIGQUIT ignores.
(
	trap - HUP INT QUIT TERM
	exec /usr/bin/env bun run -r "$PRELOAD" "$DIR/src/index.tsx" "$@"
) <&0 &
child_pid=$!
if [[ -n "$pending_signal" ]]; then
	forward_signal "$pending_signal"
fi

while :; do
	interrupted=0
	wait "$child_pid"
	status=$?
	# A trapped signal interrupts wait before the child exits. Wait again so
	# cleanup cannot race a still-running renderer, and keep the CHILD's status.
	if (( interrupted == 0 )); then
		break
	fi
done
exit "$status"
