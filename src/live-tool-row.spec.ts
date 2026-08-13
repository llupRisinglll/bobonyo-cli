import {describe, expect, test} from 'bun:test';
import {liveRowSegments, splitChunksByLine} from './live-tool-row';
import {tokenizeBashRow} from './row-highlight';
import {colors} from './theme';
import {fence, formatOutputTail, rowLanguage} from './tool-display';
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
const SETTLED_FENCE_MATCH = /^```+([^:\n]+):([^:\n]+)(?::[^:\n]*)?\n+([\s\S]*?)\n+```+$/;

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
		const output =
			'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7';
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
});
