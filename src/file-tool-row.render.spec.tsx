import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {createTextAttributes, type CapturedFrame} from '@opentui/core';
import {FileToolRow} from './components/file-tool-row';
import {LiveToolRows} from './components/live-tool-rows';
import type {MarkdownBriefRenderer} from './components/markdown-brief';
import {liveRowSegments} from './live-tool-row';
import {colors} from './theme';
import {markdownSyntaxStyleFor} from './syntax';
import {formatToolEntry} from './tool-display';
import {historyFillWidth, toolRowFillWidth} from './history-width';
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
				md={testMd}
			/>
		),
		{width: 100, height: 20},
	);
	await setup.flush();
	await new Promise(resolve => setTimeout(resolve, 50));
	return setup.captureSpans();
}
/** The markdown renderer bits history.tsx hands to the tool rows. */
const testMd: MarkdownBriefRenderer = {
	syntaxStyle: () => markdownSyntaxStyleFor(colors()),
	renderNode: () => undefined,
	treeSitter: undefined,
};
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
			() => <LiveToolRows rows={[{...seg, lang: 'filediff'}]} md={testMd} />,
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
					md={testMd}
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

	test('long diff rows never overflow: the terminal wrap phantom is gone', async () => {
		// The intermittent "additional lines" bug, render-level: a diff row
		// LONGER than the renderable width used to overflow, and the real
		// terminal (herdr) wrapped the orphan tail onto its OWN row — a
		// phantom "extra line" that vanished on resize and never appeared in
		// the clipped test renderer. Long rows must wrap INSIDE the
		// container: the continuation paints at the code column (9) with the
		// row background, and NO row may exceed the renderable width.
		const oldStr = [
			'The legacy `CLAUDE.md` documents the **nanocoder fork workflow** (rc/fork',
			'branches, `fork-flow.sh`, upstream PRs). It is nanocoder-only: bobonyo does',
			'**not** follow it. bobonyo is a plain single-repo project on `main`, with no',
			'upstream remote and no branch fleet.',
		].join('\n');
		const newStr = [
			'This file replaces the old parent-level `CLAUDE.md` (which documented the',
			'nanocoder fork workflow — rc/fork branches, `fork-flow.sh`, upstream PRs).',
			'That file is gone and bobonyo does not follow it: bobonyo is a plain',
			'single-repo project on `main`, with no upstream remote and no branch fleet.',
		].join('\n');
		const seg = diffSegments(8, oldStr, newStr);
		const setup = await testRender(
			() => (
				<FileToolRow
					header={seg.header}
					body={seg.body}
					status="done"
					glyph="✦"
					hovered={false}
					md={testMd}
				/>
			),
			{width: 84, height: 30},
		);
		await setup.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const frame = setup.captureSpans();
		const rows = frame.lines.map(line => line.spans.map(s => s.text).join(''));
		// No painted row exceeds the renderable width (an overflow would
		// wrap in the real terminal and paint a phantom row).
		for (const row of rows) {
			expect(row.length).toBeLessThanOrEqual(84);
		}
		// The wrapped fragment paints INSIDE the container at the code
		// column, never as a bare orphan at column 0.
		const orphan = rows.find(row => row.trim() === 'no');
		expect(orphan).toBeUndefined();
		const continuation = rows.find(
			row => row.startsWith(' '.repeat(9)) && row.trim() === 'o',
		);
		expect(continuation).toBeDefined();
		// The continuation row carries the row background (same as the diff
		// rows), so it reads as part of the wrapped line.
		const contY = rows.indexOf(continuation!);
		expect(
			frame.lines[contY]?.spans.some(s => (s.bg as never) !== undefined),
		).toBe(true);
	});
	test('the pre-tool brief renders through MARKDOWN (bold/code formatted, live parity)', async () => {
		// The reported bug: the model's pre-tool narration was a plain
		// <text>, so markdown in the brief (`**bold**`, `` `code` ``) leaked
		// its raw markers. The brief must render through the SAME markdown
		// pipeline the replies use — while the row is LIVE and once settled.
		// 0 blank, 1 brief (markdown), 2 header, 3 summary, 4+ diff rows.
		const seg = diffSegments(8, 'old', 'new');
		const setup = await testRender(
			() => (
				<FileToolRow
					header={seg.header}
					body={seg.body}
					status="done"
					glyph="✦"
					hovered={false}
					md={testMd}
					brief="Check **AGENTS.md** and run `bun test`"
				/>
			),
			{width: 100, height: 20},
		);
		await setup.flush();
		// The markdown brief node lays out asynchronously (like the reply
		// nodes) — give it the same settle window the reply render tests use.
		await new Promise(resolve => setTimeout(resolve, 300));
		const frame = setup.captureSpans();
		const brief = textOf(frame, 1);
		// Markdown consumed the emphasis + inline-code markers: the raw
		// `**` / backticks never paint.
		expect(brief).toContain('Check');
		expect(brief).toContain('AGENTS.md');
		expect(brief).toContain('bun test');
		expect(brief).not.toContain('**');
		expect(brief).not.toContain('`');
		// The bold span carries the BOLD attribute (the same bit replies
		// use) — the emphasis is real formatting, not plain text.
		const boldSpan = frame.lines[1]?.spans.find(s =>
			s.text.includes('AGENTS.md'),
		);
		expect(boldSpan?.attributes).toBe(createTextAttributes({bold: true}));
		// The glyph column still reads `✦ ` (the brief row keeps its entry
		// glyph), and the brief text starts after it.

		expect(brief.startsWith('✦ ')).toBe(true);
	});
	test('briefed diff_edit renders unified patch as a real DiffView', async () => {
		const terminalWidth = 84;
		const patch = [
			'--- a/src/foo.ts',
			'+++ b/src/foo.ts',
			'@@ -9,3 +9,4 @@',
			' const keep = true;',
			'-const oldValue = 1;',
			'+const newValue = 2;',
			'+const added = true;',
		].join('\n');
		const raw = formatToolEntry(
			{
				name: 'diff_edit',
				detail: 'src/foo.ts',
				output: `EXIT_CODE: 0\npatching file src/foo.ts\n${patch}`,
				args: {diff: patch},
			},
			false,
			'done',
			true,
			true,
			historyFillWidth(terminalWidth),
		);
		const inner = raw
			.split('\n')
			.filter(line => !/^\s*```/.test(line))
			.join('\n');
		const seg = liveRowSegments(
			inner,
			'filediff',
			'done',
			colors(),
			toolRowFillWidth(terminalWidth, 'Apply parser safety guard'),
		);
		const setup = await testRender(
			() => (
				<FileToolRow
					header={seg.header}
					body={seg.body}
					status="done"
					glyph="✦"
					hovered={false}
					md={testMd}
					brief="Apply parser safety guard"
				/>
			),
			{width: terminalWidth, height: 20},
		);
		await setup.flush();
		await new Promise(resolve => setTimeout(resolve, 100));
		const rows = setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''));
		expect(rows[1]).toContain('Apply parser safety guard');
		expect(rows[2]).toContain('Edit src/foo.ts');
		expect(rows[3]).toContain('1 removed · 2 added');
		expect(rows[4]).toContain('9   const keep = true;');
		expect(rows[5]).toContain('10 - const oldValue = 1;');
		expect(rows[6]).toContain('10 + const newValue = 2;');
		expect(rows[7]).toContain('11 + const added = true;');
		expect(rows.join('\n')).not.toContain('EXIT_CODE');
		expect(rows.join('\n')).not.toContain('--- a/src/foo.ts');
	});
	test('BRIEFED diff rows fit the renderable (3-wide indent shrinks the fill)', async () => {
		// The briefed entry prepends a 3-wide indent box to EVERY row; the
		// tokenizer budget must shrink by the same 3 or the padded row
		// renders one cell wider than the renderable and the TERMINAL wraps a
		// phantom blank row after every diff row (the "extra breakline" in
		// the diff view — the clipped test renderer never shows it, so the
		// check asserts the painted width against the real renderable).
		const terminalWidth = 84;
		const renderable = historyFillWidth(terminalWidth);
		const raw = formatToolEntry(
			{
				name: 'string_replace',
				detail:
					'/mnt/data/KSProjects/NanoCollective/bobonyo/src/components/completion-popup.tsx',
				output:
					'Replaced 1 occurrence in /mnt/data/KSProjects/NanoCollective/bobonyo/src/components/completion-popup.tsx (at line 32)\nconst cardHeight = 8;\nconst cardY = () => Math.max(2, Math.floor((dims().height - cardHeight) / 2));',
				args: {
					path: '/mnt/data/KSProjects/NanoCollective/bobonyo/src/components/completion-popup.tsx',
					old_string: 'const cardHeight = 8;',
					new_string:
						'const cardHeight = () => Math.min(dims().height - 2, 8);',
				},
			},
			true,
			'done',
			true,
			true,
			renderable,
		);
		const inner = raw
			.split('\n')
			.filter(line => !/^\s*```/.test(line))
			.join('\n');
		const seg = liveRowSegments(
			inner,
			'filediff',
			'done',
			colors(),
			toolRowFillWidth(terminalWidth, 'I will check the file first'),
		);
		const setup = await testRender(
			() => (
				<FileToolRow
					header={seg.header}
					body={seg.body}
					status="done"
					glyph="✦"
					hovered={false}
					md={testMd}
					brief="I will check the file first"
				/>
			),
			{width: terminalWidth, height: 20},
		);
		await setup.flush();
		await new Promise(resolve => setTimeout(resolve, 50));
		const frame = setup.captureSpans();
		// CHUNK-LEVEL INVARIANT: every tokenized row (indent + number +
		// sigil + code + fill padding) plus the 3-wide FileToolRow indent
		// box must fit the renderable. The captured frame TRIMS trailing
		// padding, so the overflow is invisible to the painted rows — the
		// terminal, however, wraps it onto a phantom blank row after every
		// diff row. This is the assertion that catches the brief-indent
		// drift (indent box 3 vs a fill shrink of 2).
		for (const line of seg.body) {
			const width = line.reduce((sum, c) => sum + c.text.length, 0);
			expect(3 + width).toBeLessThanOrEqual(renderable);
		}
		for (const line of frame.lines) {
			// Sanity: no painted content row overflows the terminal width.
			const text = line.spans
				.map(s => s.text)
				.join('')
				.trimEnd();
			expect(text.length).toBeLessThanOrEqual(terminalWidth);
		}
	});
});
test('apply_patch renders add, update, and delete rows as one DiffView', async () => {
	const raw = formatToolEntry(
		{
			name: 'apply_patch',
			detail: '',
			output: 'Applied patch successfully.',
			args: {
				patchText: '*** Begin Patch\n*** End Patch',
				_applyPatchDisplay: [
					{
						type: 'add',
						path: 'new.txt',
						rows: [{kind: 'add', line: 1, text: 'new'}],
					},
					{
						type: 'update',
						path: 'old.txt',
						rows: [
							{kind: 'remove', line: 2, text: 'old'},
							{kind: 'add', line: 2, text: 'changed'},
						],
					},
					{
						type: 'delete',
						path: 'gone.txt',
						rows: [{kind: 'remove', line: 1, text: 'gone'}],
					},
				],
			},
			briefed: true,
		},
		false,
		'done',
		true,
		true,
		84,
	);
	const inner = raw
		.split('\n')
		.filter(line => !/^\s*```/.test(line))
		.join('\n');
	const seg = liveRowSegments(inner, 'filediff', 'done', colors(), 84);
	const setup = await testRender(
		() => (
			<FileToolRow
				header={seg.header}
				body={seg.body}
				status="done"
				glyph="✦"
				hovered={false}
				md={testMd}
				brief="Update project files"
			/>
		),
		{width: 84, height: 16},
	);
	try {
		await setup.flush();
		const rows = setup
			.captureSpans()
			.lines.map(line =>
				line.spans
					.map(span => span.text)
					.join('')
					.trimEnd(),
			)
			.filter(Boolean);
		expect(rows).not.toContain('✦ Edited 3 files (+2 -2)');
		expect(rows.join('\n')).not.toContain('ApplyPatch');
		// Test Markdown stub paints only brief glyph. Native action starts at
		// brief text column; no duplicate aggregate header or second glyph.
		expect(rows[0]).toBe('✦');
		expect(rows).toContain('  └ Create new.txt (+1 -0)');
		expect(rows).toContain('    1   new');
		expect(rows).toContain('  └ Edit old.txt (+1 -1)');
		expect(rows).toContain('    2 - old');
		expect(rows).toContain('    2 + changed');
		expect(rows).toContain('  └ Delete gone.txt (+0 -1)');
		expect(rows).toContain('    1 - gone');
	} finally {
		setup.renderer.destroy();
	}
});

test('file row after another briefed tool keeps batch indentation', async () => {
	const raw = formatToolEntry(
		{
			name: 'apply_patch',
			detail: '',
			output: 'Applied patch successfully.',
			args: {
				patchText: '*** Begin Patch\n*** End Patch',
				_applyPatchDisplay: [
					{
						type: 'update',
						path: 'src/row-highlight.spec.ts',
						rows: [
							{kind: 'remove', line: 720, text: 'old'},
							{kind: 'add', line: 720, text: 'new'},
						],
					},
				],
			},
			briefed: false,
		},
		false,
		'done',
		true,
		true,
		84,
	);
	const inner = raw
		.split('\n')
		.filter(line => !/^\s*```/.test(line))
		.join('\n');
	const seg = liveRowSegments(inner, 'filediff', 'done', colors(), 81);
	const setup = await testRender(
		() => (
			<FileToolRow
				header={seg.header}
				body={seg.body}
				status="done"
				glyph="✦"
				hovered={false}
				md={testMd}
				batchBriefed={true}
			/>
		),
		{width: 84, height: 10},
	);
	try {
		await setup.flush();
		const rows = setup
			.captureSpans()
			.lines.map(line =>
				line.spans
					.map(span => span.text)
					.join('')
					.trimEnd(),
			)
			.filter(Boolean);
		expect(rows[0]).toBe('   Edit src/row-highlight.spec.ts (+1 -1)');
		expect(rows[1]).toMatch(/^ {7}720 - old$/);
		expect(rows[2]).toMatch(/^ {7}720 \+ new$/);
	} finally {
		setup.renderer.destroy();
	}
});
