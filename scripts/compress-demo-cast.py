#!/usr/bin/env python3
"""
Compress the idle out of an asciinema cast so the demo GIF stays tight.

Problem: a recording can sit on a static screen for minutes (pre-launch
shell, the welcome banner while MCP/LSP lazily load, the finished reply
left on screen before /exit). Those stretches still repaint the same
characters every frame (SGR re-emits, cursor-visibility toggles), so
renderers like agg can NOT collapse them via idle-time limits -- every
frame is a "real" frame to agg and the GIF ends up minutes long.

This script replays the cast into a minimal virtual screen, detects runs
of frames whose CHARACTER content is unchanged (spinner glyphs, timer
digits and streamed text all change characters, so real animation is
never touched), drops the redundant repaints of each static run, and
keeps at most STATIC_KEEP_S of it so the user still sees the pause
exists. Long absolute gaps (a 50s pause before launching the app) are
capped to MAX_GAP_S.

Usage: compress-demo-cast.py <input.cast> <output.cast>
"""

import json
import re
import sys

# Longest wall-clock we keep for a stretch of identical frames.
STATIC_KEEP_S = 0.8
# Any single gap longer than this is capped (pre-launch idle, mid-typing
# pauses). Typing cadence (~0.12s) and animation frames are far below it.
MAX_GAP_S = 1.2


class Screen:
    """Minimal terminal model: cursor + character grid. Colors are
    irrelevant for static-run detection (a repaint with different SGR but
    identical characters IS the idle we want to collapse)."""

    def __init__(self, cols: int, rows: int):
        self.cols = cols
        self.rows = rows
        self.grid = [[' '] * cols for _ in range(rows)]
        self.r = 0
        self.c = 0

    def put(self, text: str) -> None:
        for ch in text:
            if ch == '\n':
                self.r = min(self.rows - 1, self.r + 1)
                self.c = 0
            elif ch == '\r':
                self.c = 0
            else:
                self.grid[self.r][self.c] = ch
                self.c += 1
                if self.c >= self.cols:
                    self.c = 0
                    self.r = min(self.rows - 1, self.r + 1)

    def snapshot(self) -> str:
        return '\n'.join(''.join(row).rstrip() for row in self.grid)


def apply_output(screen: Screen, output: str) -> None:
    i = 0
    n = len(output)
    while i < n:
        ch = output[i]
        if ch == '\x1b':
            if i + 1 < n and output[i + 1] == '[':
                m = re.match(r'\x1b\[([0-9;?]*)([A-Za-z@`])', output[i:])
                if m:
                    params = m.group(1)
                    code = m.group(2)
                    if code in ('H', 'f'):
                        parts = params.split(';')
                        r = int(parts[0]) - 1 if parts[0] else 0
                        c = int(parts[1]) - 1 if len(parts) > 1 and parts[1] else 0
                        screen.r = min(max(r, 0), screen.rows - 1)
                        screen.c = min(max(c, 0), screen.cols - 1)
                    elif code == 'A':
                        screen.r = max(0, screen.r - (int(params) if params else 1))
                    elif code == 'B':
                        screen.r = min(screen.rows - 1, screen.r + (int(params) if params else 1))
                    elif code == 'C':
                        screen.c = min(screen.cols - 1, screen.c + (int(params) if params else 1))
                    elif code == 'D':
                        screen.c = max(0, screen.c - (int(params) if params else 1))
                    elif code == 'J':
                        screen.grid = [[' '] * screen.cols for _ in range(screen.rows)]
                        screen.r = 0
                        screen.c = 0
                    elif code == 'K':
                        for x in range(screen.c, screen.cols):
                            screen.grid[screen.r][x] = ' '
                    i += m.end()
                    continue
            # Device control string (DECRQSS and friends).
            if i + 1 < n and output[i + 1] == 'P':
                m = re.search(r'\x1bP[\s\S]*?\x1b\\', output[i:])
                if m:
                    i += m.end()
                    continue
            # OSC (terminal title etc.), consume to ST or BEL.
            if i + 1 < n and output[i + 1] == ']':
                m = re.search(r'\x1b\]([^\x07]*)(\x07|\x1b\\)', output[i:])
                if m:
                    i += m.end()
                    continue
            i += 1
            continue
        if ch in '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f':
            i += 1
            continue
        screen.put(ch)
        i += 1


def main() -> int:
    if len(sys.argv) != 3:
        print('usage: compress-demo-cast.py <input.cast> <output.cast>', file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]

    with open(src, encoding='utf-8') as f:
        header = json.loads(f.readline())
        raw_events = [json.loads(line) for line in f]

    cols = int(header.get('term', {}).get('cols', 100))
    rows = int(header.get('term', {}).get('rows', 30))
    screen = Screen(cols, rows)

    # Replay once to record the character content at every output event.
    # A frame's identity is the screen snapshot; a static run is a maximal
    # span of consecutive output events whose snapshots are identical.
    times = []        # absolute time of each output event
    contents = []     # snapshot string of each output event
    absolute = 0.0
    for delta, kind, data in raw_events:
        absolute += delta
        if kind != 'o':
            continue
        apply_output(screen, data)
        times.append(absolute)
        contents.append(screen.snapshot())

    # Map each output event to its compressed absolute time.
    mapped: list[float] = [0.0] * len(times)
    run_start_idx = 0
    idx = 0
    while idx < len(times):
        # Extend the static run while snapshots stay identical.
        end = idx
        while (
            end + 1 < len(times)
            and contents[end + 1] == contents[idx]
        ):
            end += 1
        run_duration = times[end] - times[idx]
        if run_duration > STATIC_KEEP_S and end > idx:
            # Keep the run's first frame; collapse the rest onto it. The
            # next content change arrives ~STATIC_KEEP_S later.
            for j in range(idx, end + 1):
                mapped[j] = times[idx]
            mapped[end] = times[idx] + STATIC_KEEP_S
        else:
            for j in range(idx, end + 1):
                mapped[j] = times[j]
        idx = end + 1

    # Rebuild the event list with each event's DESIRED compressed time:
    # output events use `mapped` (static-run frames collapse onto their
    # run start; only the run's last frame survives at +STATIC_KEEP_S),
    # input events keep their original absolute time. Redundant repaints
    # inside a collapsed run map to the same time as the run's first frame
    # and are dropped (they would replay the identical screen).
    absolute = 0.0
    out_index = 0
    kept: list[tuple[float, str, str]] = []
    previous_desired: float | None = None
    for delta, kind, data in raw_events:
        absolute += delta
        desired = mapped[out_index] if kind == 'o' else absolute
        if kind == 'o':
            out_index += 1
            if desired == previous_desired:
                continue  # identical repaint inside a collapsed static run
        kept.append((desired, kind, data))
        previous_desired = desired

    # Apply the gap cap as a monotone warp: any gap above MAX_GAP_S is
    # absorbed once, so every event AFTER it shifts earlier by the same
    # slack and the local cadence (typing, animation) is preserved.
    new_events: list[tuple[float, str, str]] = []
    warp = 0.0
    previous = 0.0
    for desired, kind, data in kept:
        if previous is not None and desired >= previous:
            gap = desired - previous
            if gap > MAX_GAP_S:
                warp += gap - MAX_GAP_S
        compressed_time = max(0.0, desired - warp)
        new_events.append((compressed_time, kind, data))
        previous = desired

    # Convert back to deltas. asciinema v2 timestamps are relative; keep
    # the header's idle_time_limit so downstream renderers stay consistent.
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(json.dumps(header) + '\n')
        previous = 0.0
        for absolute_time, kind, data in new_events:
            delta = max(0.0, absolute_time - previous)
            f.write(json.dumps([round(delta, 6), kind, data]) + '\n')
            previous = absolute_time

    original = sum(e[0] for e in raw_events)
    compressed = 0.0
    previous_time = 0.0
    for absolute_time, _kind, _data in new_events:
        compressed += max(0.0, absolute_time - previous_time)
        previous_time = absolute_time
    print(
        f'compressed {src}: {original:.1f}s -> {compressed:.1f}s '
        f'({len(new_events)} events)',
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
