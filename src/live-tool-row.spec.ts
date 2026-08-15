import {describe, expect, test} from 'bun:test';
import {liveRowSegments, splitChunksByLine} from './live-tool-row';
import {tokenizeBashRow} from './row-highlight';
import {colors} from './theme';
import {
	fence,
	formatOutputTail,
	formatToolEntry,
	replacementBaseLine,
	rowLanguage,
} from './tool-display';
import type {TextChunk} from '@opentui/core';

function rgb(c: TextChunk): string | null {
	if (!c.fg) return null;
	return `rgb(${Math.round(c.fg.r * 255)},${Math.round(c.fg.g * 255)},${Math.round(c.fg.b * 255)})`;
}

function themeRgb(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgb(${r},${g},${b})`;
}

/**
 * REGRESSION: the settled-memo fence classifier must accept the full-row-bg
 * WIDTH marker (`filediff:done:w84`) that pushBlock appends to filediff
 * openers. Before the fix, `^```+([^:\n]+):([^:\n]+)\n+` could not match
 * `done:w84` (the second colon), the Edit row fell back to the markdown
 * pipeline and its NESTED ` ```filediff ` fences leaked as visible lines
 * between the Read row and the Edit diff.
 */
const SETTLED_FENCE_MATCH =
	/^```+([^:\n]+):([^:\n]+)(?::[^:\n]*)?\n+([\s\S]*?)\n+```+$/;

describe('splitChunksByLine', () => {
	test('splits a chunk stream on newline separators', () => {
		const chunks = tokenizeBashRow(
			'Bash(echo hi)\n  └   line 1\n      line 2',
			'running',
			colors(),
		);
		const lines = splitChunksByLine(chunks);
		expect(lines.length).toBe(3);
		expect(lines[0]!.map(c => c.text).join('')).toBe('Bash(echo hi)');
		expect(lines[1]!.map(c => c.text).join('')).toBe('  └   line 1');
		expect(lines[2]!.map(c => c.text).join('')).toBe('      line 2');
	});
});

describe('liveRowSegments', () => {
	test('strips the glyph from the header and keeps the bash syntax chunks', () => {
		const {header, body} = liveRowSegments(
			'✦ Bash(for i in $(seq 1 16); do echo "line $i"; done)\n  └   line 1',
			'bashrow',
			'running',
			colors(),
			80,
		);
		// Glyph is NOT part of the chunks (it renders separately/blinks).
		expect(header.map(c => c.text).join('')).not.toContain('✦');
		expect(header.map(c => c.text).join('')).toContain('Bash');
		// Keyword/string/number syntax colors survive the live split.
		const joined = header.map(c => c.text).join('');
		expect(joined).toContain('do');
		expect(joined).toContain('"line $i"');
		expect(body.length).toBe(1);
		expect(body[0]!.map(c => c.text).join('')).toBe('  └   line 1');
	});

	test('live body lines are byte-identical to the settled output tail', () => {
		// The settled row and the live row both go through formatOutputTail,
		// so the `  └   ` container + cap + `+N lines` footer must match
		// exactly while streaming and when done (spacing parity).
		const output = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7';
		const settledTail = formatOutputTail(output, false).split('\n');
		const {body} = liveRowSegments(
			`Bash(echo hi)\n${settledTail.join('\n')}`,
			'bashrow',
			'running',
			colors(),
			80,
		);
		expect(body.map(line => line.map(c => c.text).join(''))).toEqual(
			settledTail,
		);
	});

	test('long output lines wrap INSIDE the bordered box (never column 0)', () => {
		const longLine = 'x'.repeat(200);
		const tail = formatOutputTail(longLine, false).split('\n');
		// formatOutputTail returns PLAIN wrapped lines; the bordered renderer
		// adds the `│ ` edges. The important guarantee: no line exceeds the
		// container wrap width (nothing escapes the box horizontally).
		expect(tail.length).toBeGreaterThan(1);
		for (const line of tail) {
			// The first line carries `  └   `, continuations `      ` — the
			// CONTENT after those prefixes never exceeds the wrap width
			// (width - box edge = 81 for the 84 default).
			if (!line.startsWith('…')) {
				const content = line.replace(/^\s{2,6}└?\s*/, '');
				expect(content.length).toBeLessThanOrEqual(81);
			}
		}
	});

	test('a giant single line (minified file) cannot flood the preview rows', () => {
		// `grep` on a one-line minified JS file outputs ONE line that is
		// megabytes long. The old tail cap counted LINES, so the single line
		// bypassed it and wrapped into thousands of rendered rows. It must
		// now be truncated per line AND capped at a bounded row count.
		const giant = 'x'.repeat(200_000);
		const collapsed = formatOutputTail(giant, false).split('\n');
		// The collapsed target is "3 lines of output": exactly 3 rendered
		// rows + the row-cap footer.
		expect(collapsed.length).toBe(4);
		// The visible tail window ends with the per-line `…` marker and the
		// row-cap footer reports the dropped rows.
		expect(collapsed.at(-2)).toMatch(/x+…$/);
		expect(collapsed.at(-1)).toMatch(/^… \+\d+ more line/);

		const expanded = formatOutputTail(giant, true).split('\n');
		expect(expanded.length).toBeLessThanOrEqual(201); // 200 rows + footer
		expect(expanded.join('\n')).toMatch(/…$/);
	});

	test('per-line preview keeps the HEAD with a trailing … marker', () => {
		const giant = 'head'.repeat(1000); // 4000 chars, no spaces
		const tail = formatOutputTail(giant, false);
		const body = tail.split('\n');
		// The last visible row carries the trailing `…` — the line continues
		// past the preview — and the row-cap footer reports the dropped rows.
		expect(body.at(-2)).toMatch(/…$/);
		expect(tail).toMatch(/… \+\d+ more line/);
	});

	test('normal multi-line output keeps the exact existing footer semantics', () => {
		const output = 'a\nb\nc\nd\ne';
		const tail = formatOutputTail(output, false).split('\n');
		// Last 3 lines are shown, earlier ones roll into the footer.
		expect(tail[0]).toBe('  └   c');
		expect(tail[1]).toBe('      d');
		expect(tail[2]).toBe('      e');
		expect(tail[3]).toBe('… +2 more lines');
	});

	describe('settled-memo fence classifier (width marker)', () => {
		// A string_replace row settles through the SAME shape singleToolRow
		// produces: an OUTER ` `````filediff:done ` fence (4 backticks, the
		// width marker appended by pushBlock) wrapping the nested
		// ` ```filediff:done ` preview that formatToolEntry emits.
		const preview = fence(
			'filediff',
			'done',
			'✦ Edit /tmp/demo.js\n ⎿ 1 line → 2 lines\n   1 - const a = 1;\n   1 + const b = 2;',
		);
		const wrapped = fence('filediff', 'done', preview);
		const withWidthMarker = wrapped.replace(
			/^(```+)(filediff)(:[^:\n]+)/,
			(_m, f, kind, status) => `${f}${kind}${status}:w84`,
		);

		test('classifies the row as a filediff tool block despite :w84', () => {
			const match = SETTLED_FENCE_MATCH.exec(withWidthMarker);
			expect(match).not.toBeNull();
			expect(match?.[1]).toBe('filediff');
			expect(match?.[2]).toBe('done');
		});

		test('tokenized segments contain NO leaked fence markers', () => {
			const match = SETTLED_FENCE_MATCH.exec(withWidthMarker);
			const inner = (match?.[3] ?? '').replace(/^\n/, '');
			const segments = liveRowSegments(
				inner,
				match?.[1] ?? '',
				(done => done as 'done')(match?.[2]),
				colors(),
				84,
			);
			const allText = [
				...segments.header.map(c => c.text),
				...segments.body.flat().map(c => c.text),
			].join('');
			expect(allText).not.toMatch(/```/);
			expect(segments.header.map(c => c.text).join('')).toContain(
				'✦ Edit /tmp/demo.js',
			);
		});

		test('plain (no marker) rows still classify', () => {
			const match = SETTLED_FENCE_MATCH.exec(wrapped);
			expect(match?.[1]).toBe('filediff');
			expect(match?.[2]).toBe('done');
		});
	});

	describe('file-row language detection (leading blank line)', () => {
		test('a fenced filerow with the opener blank line still syntax-highlights .ts', () => {
			// formatFilePreview emits ` ```filerow:done\n\n✦ Write …` — the
			// filtered inner content starts with a BLANK line. rowPath must
			// skip it, or the language resolves to '' and the Write preview
			// renders plain (regression: no syntax colors on new files).
			const raw = [
				'```filerow:done',
				'',
				'✦ Write demo.ts',
				' ⎿ Write: 1 line',
				'```',
				'```typescript',
				'   1 const greeting = "hello world";',
				'```',
			].join('\n');
			const {body} = liveRowSegments(raw, 'filerow', 'done', colors(), 84);
			const codeLine = body.find(line =>
				line.some(c => c.text.includes('const')),
			);
			expect(codeLine).toBeDefined();
			const keyword = codeLine!.find(c => c.text === 'const');
			expect(keyword).toBeDefined();
			// `const` is a keyword → primary, NOT the plain default text fg.
			expect(rgb(keyword!)).toBe(themeRgb(colors().primary));
		});
	});

	describe('edit diff preview cap', () => {
		const bigOld = Array.from({length: 80}, (_, i) => `old line ${i + 1}`).join(
			'\n',
		);
		const bigNew = `${bigOld}\nnew line added`;
		const tool = (expanded: boolean) =>
			formatToolEntry(
				{
					name: 'string_replace',
					detail: 'src/foo.ts',
					output: `Replaced 1 occurrence in src/foo.ts\n${bigNew}`,
					args: {
						path: 'src/foo.ts',
						old_string: bigOld,
						new_string: bigNew,
					},
				},
				expanded,
				'done',
				true,
				true,
				84,
			);

		test('collapsed caps at 50 lines with a +N more lines footer', () => {
			const raw = tool(false);
			expect(raw).toMatch(/… \+31 more lines/);
			const {body} = liveRowSegments(raw, 'filediff', 'done', colors(), 84);
			// summary + 50 diff lines + footer
			expect(body.length).toBe(52);
		});

		test('expanded shows the WHOLE diff (no cap, no footer)', () => {
			const raw = tool(true);
			expect(raw).not.toMatch(/more lines/);
			const {body} = liveRowSegments(raw, 'filediff', 'done', colors(), 84);
			expect(body.length).toBe(82);
		});

		test('diff lines render CONTIGUOUSLY (no blank rows between)', () => {
			const {body} = liveRowSegments(
				tool(true),
				'filediff',
				'done',
				colors(),
				84,
			);
			// Every diff line is a real row — a regression here means the
			// edit preview gained an extra breakline per line.
			expect(body.length).toBe(82);
			for (const line of body) {
				expect(
					line
						.map(c => c.text)
						.join('')
						.trim(),
				).not.toBe('');
			}
		});
	});

	describe('edit diff line numbers are FILE-absolute, never snippet-relative', () => {
		// The reported bug: adding a line showed `1 - 2 - 3 - 4` no matter
		// where in the file the edit happened. The diff was numbered against
		// the old_string/new_string SNIPPET (starting at 1); the tool now
		// reports the first occurrence's absolute line and the preview
		// shifts every diff row by that base.
		const tool = (output: string) =>
			formatToolEntry(
				{
					name: 'string_replace',
					detail: 'src/foo.ts',
					output,
					args: {
						path: 'src/foo.ts',
						old_string: 'const a = 1;',
						new_string: 'const a = 1;\nconst b = 2;',
					},
				},
				true,
				'done',
				true,
				true,
				84,
			);

		test('the (at line N) marker shifts every diff row to the REAL line', () => {
			const raw = tool(
				'Replaced 1 occurrence in src/foo.ts (at line 42)\nconst a = 1;\nconst b = 2;',
			);
			// Context row: unchanged `const a` sits at file line 42; the
			// added line lands at 43 — NEVER the snippet-relative 1 / 2.
			// Every row also carries the fixed 2-space container lead (the
			// diff block must not render flush at column 0) and the sigil
			// keeps its trailing space (`+ const`, never `+const`).
			expect(raw).toContain('    42   const a = 1;');
			expect(raw).toContain('    43 + const b = 2;');
			expect(raw).not.toMatch(/\n\s*1\s/);
			expect(raw).not.toContain('     1   const a = 1;');
			expect(raw).not.toContain('+const');
			expect(raw).not.toContain('-const');
		});
		test('an edit at the TOP of the file stays line 1 (no bogus offset)', () => {
			const raw = tool(
				'Replaced 1 occurrence in src/foo.ts (at line 1)\nconst a = 1;\nconst b = 2;',
			);
			expect(raw).toContain('     1   const a = 1;');
			expect(raw).toContain('     2 + const b = 2;');
		});
		test('legacy results without the marker keep snippet-relative numbers', () => {
			const raw = tool(
				'Replaced 1 occurrence in src/foo.ts\nconst a = 1;\nconst b = 2;',
			);
			expect(raw).toContain('     1   const a = 1;');
			expect(raw).toContain('     2 + const b = 2;');
		});
		test('the diff body is INDENTED (2-space container lead on every row)', () => {
			// Every diff row starts with the same fixed lead so the block
			// nests under the `✦ Edit` header — a regression to the old
			// flush-left number field (1/2/3-digit numbers at shifting
			// columns) fails this.
			const raw = tool(
				'Replaced 1 occurrence in src/foo.ts (at line 1)\nconst a = 1;\nconst b = 2;',
			);
			const rows = raw.split('\n').filter(line => /^\s*\d+\s+[-+ ]/.test(line));
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				// Fixed 2-space lead before the number gutter.
				expect(row.slice(0, 2)).toBe('  ');
				expect(row).toMatch(/^  \s{2,3}\d+\s/);
			}
		});
		test('replacementBaseLine parses the marker and falls back to 1', () => {
			expect(
				replacementBaseLine(
					'Replaced 1 occurrence in src/foo.ts (at line 42)\nx',
				),
			).toBe(42);
			expect(
				replacementBaseLine(
					'Replaced 3 occurrences in src/foo.ts (at line 7)\nx',
				),
			).toBe(7);
			expect(
				replacementBaseLine('Replaced 1 occurrence in src/foo.ts\nx'),
			).toBe(1);
			expect(replacementBaseLine('')).toBe(1);
		});
	});
});
