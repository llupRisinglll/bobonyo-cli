#!/usr/bin/env bash
# Render the demo GIF from a raw asciinema cast (e.g. one recorded inside a
# herdr pane).
#
# Two things must be handled or the GIF looks wrong:
#   1. The cast header carries the SOURCE terminal's recorded theme (bg
#      #232627 from libghostty). agg fills every default-background cell
#      with that color, washing out the app's dark UI and making dim text
#      (like the `· ctx ~0%` corner) look broken. Strip `theme`/`version`
#      so agg uses its own default background.
#   2. The default emoji font (Noto Color Emoji) renders ⚙/★ as COLOR emoji.
#      Force a monochrome symbol font (Adwaita Mono covers every UI glyph)
#      so the GIF stays glyph-based.
#   3. The app's bottom-right corner label uses NON-BREAKING SPACES
#      (opaque in OpenTUI so they cover the border dashes). agg renders
#      U+00A0 as a VISIBLE mark, so the corner looks broken in the GIF —
#      rewrite them to plain spaces (opaque in agg's emulator) at render
#      time. The app itself is untouched.
#
# The cast is also trimmed right after the app's exit and the goodbye
# banner re-printed on a cleared screen, so the closing frames are clean
# (agg otherwise keeps the last alternate-screen frame visible).
set -euo pipefail

CAST="${1:?usage: render-demo-gif.sh <input.cast> <output.gif>}"
OUT="${2:?usage: render-demo-gif.sh <input.cast> <output.gif>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$CAST" "$TMP/clean.cast" <<'PY'
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
events = []
with open(src) as f:
    header = json.loads(f.readline())
    for line in f:
        events.append(json.loads(line))

# Trim at the alternate-screen exit, then re-print the goodbye banner on a
# cleared screen (the recording's shell teardown after that adds nothing).
exit_at = next(
    (i for i, e in enumerate(events) if e[1] == "o" and "\x1b[?1049l" in e[2]),
    len(events) - 1,
)
banner = next(
    (
        e[2]
        for e in events[exit_at : exit_at + 12]
        if e[1] == "o" and "bobonyo (v0.1.0)" in e[2]
    ),
    None,
)
kept = events[: exit_at + 1]
# agg renders U+00A0 (non-breaking space) as a visible glyph; the corner
# label's separators must become plain spaces for the GIF (the app's own
# output stays correct in real terminals).
for e in kept:
    if e[1] == "o":
        e[2] = e[2].replace("\u00a0", " ")
clean = [[0.05, "o", "\x1b[2J\x1b[H"]]
if banner is not None:
    clean.append([0.1, "o", banner])
clean.append([0.1, "o", "\x1b[?25h"])

# Strip the recorded terminal theme/version so agg uses its own background.
header["term"].pop("theme", None)
header["term"].pop("version", None)

with open(dst, "w") as f:
    f.write(json.dumps(header) + "\n")
    for e in kept:
        f.write(json.dumps(e) + "\n")
    for e in clean:
        f.write(json.dumps(e) + "\n")
PY

exec agg --speed 2 --fps-cap 24 \
	--emoji-font-family "Adwaita Mono" \
	"$TMP/clean.cast" "$OUT"
