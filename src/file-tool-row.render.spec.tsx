import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {FileToolRow} from './components/file-tool-row';
import {liveRowSegments} from './live-tool-row';
import {colors} from './theme';
import {formatToolEntry} from './tool-display';
/**
 * RENDER-LEVEL regression guard for the Edit diff view.
 *
 * The reported bugs: diff rows rendered flush at column 0 (no container
 * indent, so 1/2/3-digit numbers shifted columns and the block touched the
 * transcript edge) AND the +/- sigil glued to the code (`43 +const b`).
 * These tests mount the REAL FileToolRow through the REAL OpenTUI test
 * renderer and assert the EXACT painted cells of every diff row: the
 * 2-space container lead, the right-aligned 4-wide number gutter, the fixed
 * code column, and the sigil's trailing space.
 */

/** Column where `needle` first appears in a painted row's text, or -1. */
function colOf(text: string, needle: string): number {
	return text.indexOf(needle);
}
/** Painted text of a line (spans joined, the actual cell content). */
function textOf(frame: CapturedFrame, y: number): string {
	return frame.lines[y]?.spans.map(s => s.text).join('') ?? '';
}
/**
 * Build the segments for a string_replace edit diff exactly like the
 * settled/live row path does (formatToolEntry → strip fences →
 * liveRowSegments).
 */
function diffSegments(atLine: number, oldStr: string, newStr: string) {
	const raw = formatToolEntry(
		{
			name: 'string_replace',
			detail: 'src/foo.ts',
			output: `Replaced 1 occurrence in src/foo.ts (at line ${atLine})\n${newStr}`,
			args: {path: 'src/foo.ts', old_string: oldStr, new_string: newStr},
		},
		true,
		'done',
		true,
		true,
		84,
	);
	const inner = raw
		.split('\n')
		.filter(line => !/^\s*```/.test(line))
		.join('\n');
	return liveRowSegments(inner, 'filediff', 'done', colors(), 84);
}
async function renderDiff(atLine: number, oldStr: string, newStr: string) {
	const seg = diffSegments(atLine, oldStr, newStr);
	const setup = await testRender(
		() => (
			<FileToolRow
				header={seg.header}
				body={seg.body}
				status="done"
				glyph="✦"
				hovered={false}
			/>
		),
		{width: 100, height: 20},
	);
	await setup.flush();
	await new Promise(resolve => setTimeout(resolve, 50));
	return setup.captureSpans();
}
describe('Edit diff rendering (indent + absolute line numbers)', () => {
	test('rows indent under the header and the code lands at a FIXED column', async () => {
		const frame = await renderDiff(
			42,
			'const a = 1;',
			'const a = 1;\nconst b = 2;\nconst c = 3;',
		);
		// 0: (blank breakline) 1: header 2: summary 3+: diff rows.
		const context = textOf(frame, 3);
		const add1 = textOf(frame, 4);
		const add2 = textOf(frame, 5);
		// NOT flush: the number gutter starts after the 2-space container
		// lead, so the block nests under `✦ Edit` instead of column 0.
		expect(context.startsWith('  ')).toBe(true);
		expect(context.indexOf('42')).toBeGreaterThan(0);
		// Absolute file lines: 42 (context) then 43 / 44 (adds) — never the
		// snippet-relative 1 / 2 / 3.
		expect(context).toContain('42   const a = 1;');
		expect(add1).toContain('43 + const b = 2;');
		expect(add2).toContain('44 + const c = 3;');
		// The CODE column is identical across context and add rows (the
		// sigil sits in its own column with a trailing space).
		const codeCol = colOf(context, 'const a');
		// EXACT layout: 2-space lead + 4-wide gutter + sigil column + sigil
		// space = code always starts at column 9, for every row.
		expect(codeCol).toBe(9);
		expect(colOf(add1, 'const b')).toBe(9);
		expect(colOf(add2, 'const c')).toBe(9);
		// Sigil spaced: `+ const`, never `+const`.
		expect(add1).toContain('+ const');
		expect(add2).not.toMatch(/\+const/);
	});

	test('3-digit line numbers stay aligned (right-aligned 4-wide gutter)', async () => {
		const frame = await renderDiff(142, 'old line', 'old line\nnew line');
		const context = textOf(frame, 3);
		const add = textOf(frame, 4);
		expect(context).toContain('142   old line');
		expect(add).toContain('143 + new line');
		// The 4-wide gutter absorbs the extra digit: the code still lands at
		// column 9, identical to the 2-digit case.
		expect(colOf(context, 'old line')).toBe(9);
		expect(colOf(add, 'new line')).toBe(9);
	});

	test('a mid-file replace shows the correct remove/add/context lines', async () => {
		const frame = await renderDiff(
			7,
			'x = 1;\ny = 2;',
			'x = 1;\nx = 10;\ny = 2;',
		);
		expect(textOf(frame, 3)).toContain('7   x = 1;');
		expect(textOf(frame, 4)).toContain('8 + x = 10;');
		expect(textOf(frame, 5)).toContain('8   y = 2;');
		// Same code column across all three rows.
		expect(textOf(frame, 3).indexOf('x = 1;')).toBe(9);
		expect(textOf(frame, 4).indexOf('x = 10;')).toBe(9);
		expect(textOf(frame, 5).indexOf('y = 2;')).toBe(9);
	});

	test('remove rows carry the - sigil with its trailing space too', async () => {
		const frame = await renderDiff(3, 'a\nb\nc', 'a\nc');
		// Row 3 = context a, 4 = remove b (line 4), 5 = context c (line 5).
		const remove = textOf(frame, 4);
		expect(remove).toContain('4 - b');
		expect(remove).not.toMatch(/-b\b/);
	});

	test("ADDED lines keep the code's own indentation (tabs), never flush", async () => {
		// The reported bug: editing tab-indented code, the ADD rows lost
		// their leading tabs (the sigil regex swallowed them), so they
		// rendered flush at the gutter while context rows kept theirs.
		const oldStr = [
			"\t\tconst display = read('./tool-display.ts');",
			'\t\texpect(display).toMatch(/replacementBaseLine\\(tool\\.output\\)/);',
			'\t});',
		].join('\n');
		const newStr = [
			"\t\tconst display = read('./tool-display.ts');",
			'\t\texpect(display).toMatch(/replacementBaseLine\\(tool\\.output\\)/);',
			'\t\t// INDENTATION: the diff rows must NOT render flush at column 0 —',
			"\t\texpect(display).toMatch(/const lead = '  ';/);",
			'\t});',
		].join('\n');
		const frame = await renderDiff(1, oldStr, newStr);
		// 0 blank, 1 header, 2 summary, 3-4 context, 5-6 ADDS, 7 context.
		const add1 = textOf(frame, 5);
		const add2 = textOf(frame, 6);
		// The added lines render with the SAME leading indentation as the
		// context rows (the test renderer expands tabs, so compare COLUMNS):
		// the code after `+ ` starts exactly where the context code starts.
		expect(colOf(add1, '// INDENTATION')).toBe(
			colOf(textOf(frame, 3), 'const display'),
		);
		expect(colOf(add2, 'expect(display)')).toBe(
			colOf(textOf(frame, 3), 'const display'),
		);
		// And that column is PAST the 4-wide number gutter (not flush).
		expect(colOf(add1, '// INDENTATION')).toBeGreaterThan(9);
	});

	test('a blank line added mid-edit renders ONE row, never a phantom extra', async () => {
		// The reported bug: `new_string` with an interior blank line made
		// the summary say `1 line → 2 lines` while the diff rendered 3 rows
		// (the blank line) — the phantom extra. The summary must count the
		// blank and the painted rows must match it exactly.
		const frame = await renderDiff(
			3,
			'const a = 1;',
			'const a = 1;\n\nconst b = 2;',
		);
		// 0 blank, 1 header, 2 summary, 3 ctx (line 3), 4 blank add (line 4),
		// 5 add (line 5). No row 6 — never a phantom extra.
		expect(textOf(frame, 2)).toContain(' ⎿ 1 line → 3 lines');
		expect(textOf(frame, 3)).toContain('3   const a = 1;');
		expect(textOf(frame, 4)).toMatch(/^ {5}4 \+ /);
		expect(textOf(frame, 5)).toContain('5 + const b = 2;');
		// The blank-add row paints the number + sigil (not empty).
		expect(textOf(frame, 4).trim()).not.toBe('');
	});
});
