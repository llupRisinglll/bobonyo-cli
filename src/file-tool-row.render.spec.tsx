import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {FileToolRow} from './components/file-tool-row';
import {LiveToolRows} from './components/live-tool-rows';
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
		// 0: (blank breakline) 1: header 2: summary 3+: diff rows. old_string
		// is a strict PREFIX of new_string, so the unchanged `const a = 1;`
		// renders as CONTEXT at the real line 42 and the 2 additions follow
		// (git/codex parity — the replaced lines are never hidden).
		const context = textOf(frame, 3);
		const add1 = textOf(frame, 4);
		const add2 = textOf(frame, 5);
		// NOT flush: the number gutter starts after the 2-space container
		// lead, so the block nests under `✦ Edit` instead of column 0.
		expect(context.startsWith('  ')).toBe(true);
		expect(context.indexOf('42')).toBeGreaterThan(0);
		// Absolute file lines: 42 ctx then 43 / 44 (adds) — never the
		// snippet-relative 1 / 2 / 3.
		expect(context).toContain('42   const a = 1;');
		expect(add1).toContain('43 + const b = 2;');
		expect(add2).toContain('44 + const c = 3;');
		// The summary reflects the true change: 1 context + 2 added.
		expect(textOf(frame, 2)).toContain(' ⎿ 1 line → 3 lines');
		// EXACT layout: 2-space lead + 4-wide gutter + sigil column + sigil
		// space = code always starts at column 9, for every row.
		expect(colOf(context, 'const a')).toBe(9);
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
		expect(colOf(add, 'new line')).toBe(9);
	});

	test('a mid-file replace shows the correct remove/add lines', async () => {
		const frame = await renderDiff(
			7,
			'x = 1;\ny = 2;',
			'x = 1;\nx = 10;\ny = 2;',
		);
		// `x = 1;` and `y = 2;` are unchanged anchors; the middle strips to
		// an empty old side, so the DEGENERATE guard falls back to the full
		// old→new: 2 context rows + 1 add (git/codex parity, the replaced
		// region is never shown as pure insertion).
		expect(textOf(frame, 2)).toContain(' ⎿ 2 lines → 3 lines');
		expect(textOf(frame, 3)).toContain('7   x = 1;');
		expect(textOf(frame, 4)).toContain('8 + x = 10;');
		expect(textOf(frame, 5)).toContain('8   y = 2;');
	});

	test('remove rows carry the - sigil with its trailing space too', async () => {
		const frame = await renderDiff(3, 'a\nb\nc', 'a\nc');
		// `a` prefix + `c` suffix: the middle strips the old `b` away, so
		// the DEGENERATE guard shows the full old→new: ctx a, remove b,
		// ctx c (the removed line is never hidden as `1 → 2`).
		expect(textOf(frame, 3)).toContain('3   a');
		expect(textOf(frame, 4)).toContain('4 - b');
		expect(textOf(frame, 5)).toContain('5   c');
		expect(textOf(frame, 4)).not.toMatch(/-b\b/);
	});

	test("ADDED lines keep the code's indentation (tabs expanded, never flush)", async () => {
		// Two bugs: (1) the sigil regex swallowed leading indentation →
		// flush adds; (2) literal `\t` chunks break the NATIVE layout (a
		// blank row after every tab-indented diff line, seen in herdr but
		// invisible to the test renderer). Tabs must expand to spaces so
		// the indentation is preserved AND no raw tab reaches the paint.
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
		// 0 blank, 1 header, 2 summary, 3-4 ctx, 5-6 ADDS, 7 ctx (old is a
		// strict prefix of new, degenerate guard keeps the full old→new).
		const add1 = textOf(frame, 5);
		const add2 = textOf(frame, 6);
		// Both added lines render with the SAME leading indentation —
		// past the gutter, never flush.
		expect(colOf(add1, '// INDENTATION')).toBeGreaterThan(9);
		expect(colOf(add2, 'expect(display)')).toBe(colOf(add1, '// INDENTATION'));
		// No raw tab may reach the painted row (native layout breaks on it).
		expect(add1).not.toContain('\t');
		expect(add2).not.toContain('\t');
	});

	test('a blank line added mid-edit renders ONE row, never a phantom extra', async () => {
		// The reported bug: `new_string` with an interior blank line made
		// the summary say `1 line → 2 lines` while the diff rendered 3 rows
		// (the blank line) — the phantom extra. The summary must count the
		// blank and the painted rows must match it exactly. The unchanged
		// `const a = 1;` anchor is stripped.
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

	test('redundant anchor context never renders (the 7→8 phantom)', async () => {
		// The reported bug: old_string/new_string both carried 4 IDENTICAL
		// anchoring lines around the change, so the diff rendered them as
		// context and the summary said `7 → 8` for a real 3 → 4 edit — the
		// "extra 1 more line". The painted rows must show ONLY the true
		// change: 3 removes + 4 adds, numbered 401-404.
		const ctx = [
			"\t\texpect(raw).toContain(' ⎿ 1 line → 3 lines');",
			"\t\tconst {body} = liveRowSegments(raw, 'filediff', 'done', colors(), 84);",
			'\t\t// summary + 3 diff rows (ctx, blank add, add) — never 4.',
			'\t\texpect(body.length).toBe(4);',
		].join('\n');
		const oldBlock = [
			'\t\t// The blank add renders as a numbered `+` row, not an empty row.',
			"\t\texpect(body[2]?.map(c => c.text).join('')).toMatch(/3 \\+ /);",
			"\t\texpect(body[3]?.map(c => c.text).join('')).toContain('4 + const b');",
		].join('\n');
		const newBlock = [
			'\t\t// The blank add renders as a numbered `+` row (line 4), not an',
			'\t\t// empty row; the real add lands at line 5.',
			"\t\texpect(body[2]?.map(c => c.text).join('')).toMatch(/4 \\+ /);",
			"\t\texpect(body[3]?.map(c => c.text).join('')).toContain('5 + const b');",
		].join('\n');
		const frame = await renderDiff(
			397,
			`${ctx}\n${oldBlock}`,
			`${ctx}\n${newBlock}`,
		);
		// 0 blank, 1 header, 2 summary, 3-9 = 3 removes + 4 adds (7 rows).
		expect(textOf(frame, 2)).toContain(' ⎿ 3 lines → 4 lines');
		// 3-digit numbers: 2-space lead + 1 pad = 3 spaces before `401`.
		expect(textOf(frame, 3)).toMatch(/^ {3}401 - /);
		expect(textOf(frame, 9)).toMatch(/^ {3}404 \+ /);
		// No anchor context rows (397-400) and no phantom row 10.
		expect(textOf(frame, 10).trim()).toBe('');
	});

	test('LIVE and SETTLED file rows paint the SAME rows (one breakline, no double)', async () => {
		// The reported bug: LiveToolRows rendered its own leading breakline
		// AND FileToolRow/BashToolRow render theirs — the running row showed
		// TWO blank lines that collapsed to ONE when it settled (a visible
		// "extra breakline" that disappeared mid-turn). The live render must
		// be byte-identical to the settled one: same painted rows.
		const seg = diffSegments(
			397,
			'const a = 1;',
			'const a = 1;\n\nconst b = 2;',
		);
		const painted = (frame: CapturedFrame): string[] =>
			frame.lines
				.map(line =>
					line.spans
						.map(s => s.text)
						.join('')
						.trimEnd(),
				)
				.filter(text => text.trim() !== '');

		const live = await testRender(
			() => <LiveToolRows rows={[{...seg, lang: 'filediff'}]} />,
			{width: 100, height: 20},
		);
		await live.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const liveRows = painted(live.captureSpans());

		const settled = await testRender(
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
		await settled.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const settledRows = painted(settled.captureSpans());

		expect(liveRows).toEqual(settledRows);
		// Exactly ONE leading breakline: header at row 1, not row 2.
		expect(liveRows[0]).toContain('✦ Edit src/foo.ts');
	});
});
