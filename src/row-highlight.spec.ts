import {describe, expect, test} from 'bun:test';
import type {TextChunk} from '@opentui/core';
import {
	readableOn,
	tokenizeAgentRow,
	tokenizeBanner,
	tokenizeFileDiff,
	tokenizeFileRow,
	tokenizeStatusRow,
	tokenizeTaskRow,
	tokenizeTaskStatusRow,
	tokenizeToolRow,
	tokenizeUserMessage,
	tokenizeWarningRow,
} from './row-highlight';
import {RGBA, createTextAttributes} from '@opentui/core';
import {colors, type Colors} from './theme';
import {historyFillWidth} from './history-width';
import {formatToolEntry} from './tool-display';

function themeRgb(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgb(${r},${g},${b})`;
}

function rgb(c: TextChunk): string | null {
	if (!c.fg) return null;
	return `rgb(${Math.round(c.fg.r * 255)},${Math.round(c.fg.g * 255)},${Math.round(c.fg.b * 255)})`;
}

function bg(c: TextChunk): string | null {
	if (!c.bg) return null;
	return `rgb(${Math.round(c.bg.r * 255)},${Math.round(c.bg.g * 255)},${Math.round(c.bg.b * 255)})`;
}

function join(chunks: TextChunk[]): string {
	return chunks.map(c => c.text).join('');
}
describe('tokenizeTaskStatusRow', () => {
	test('keeps diamond spacing and muted non-bold text', () => {
		const chunks = tokenizeTaskStatusRow(
			'✦  Working on: Replace undo with rewind',
			colors(),
		);
		expect(join(chunks)).toBe('✦  Working on: Replace undo with rewind');
		expect(chunks.every(entry => rgb(entry) === themeRgb(colors().text))).toBe(
			true,
		);
	});
});

/** Chunk runs per output line (chunks split on the embedded newlines). */
function perLine(chunks: TextChunk[]): TextChunk[][] {
	const lines: TextChunk[][] = [[]];
	for (const c of chunks) {
		const parts = c.text.split('\n');
		for (let i = 0; i < parts.length; i++) {
			(lines[lines.length - 1] ?? []).push({...c, text: parts[i] ?? ''});
			if (i < parts.length - 1) lines.push([]);
		}
	}
	return lines;
}

describe('tokenizeBanner', () => {
	test('all keys render in the same secondary color', () => {
		const text = [
			'╭──────────────────────────────────────────────────────────────────╮',
			'│ ★      bobonyo (v0.1.0)                                          │',
			'│ ╭◕‿◕╮  model:       mock-model-1  /model to change               │',
			'│ ╰───╯  directory:   /mnt/data/KSProjects/NanoCollective/bobonyo │',
			'│        permissions: YOLO mode                                   │',
			'╰──────────────────────────────────────────────────────────────────╯',
		].join('\n');
		const chunks = tokenizeBanner(text, colors());
		const lines = perLine(chunks);
		const secondary = themeRgb(colors().secondary);
		const keys = ['model:', 'directory:', 'permissions:'];
		for (let i = 0; i < keys.length; i++) {
			const line = lines[2 + i] ?? [];
			const label = line.find(c => c.text.includes(keys[i] ?? ''));
			expect(label, `key ${keys[i]} chunk exists`).toBeDefined();
			expect(rgb(label!)).toBe(secondary);
		}
		// Values keep their purpose colors: model value is text, YOLO is error.
		const modelLine = lines[2] ?? [];
		const modelValue = modelLine.find(c => c.text.trim() === 'mock-model-1');
		expect(modelValue).toBeDefined();
		expect(rgb(modelValue!)).toBe(themeRgb(colors().text));
		const permLine = lines[4] ?? [];
		const permValue = permLine.find(c => c.text.trim() === 'YOLO mode');
		expect(permValue).toBeDefined();
		expect(rgb(permValue!)).toBe(themeRgb(colors().error));
	});

	test('mascot, borders and title stay primary', () => {
		const text = [
			'╭───────────────────╮',
			'│ ★      bobonyo (v0.1.0) │',
			'╰───────────────────╯',
		].join('\n');
		const chunks = tokenizeBanner(text, colors());
		const primary = themeRgb(colors().primary);
		// The border chunk and the title chunk carry a fg (primary).
		const border = chunks.find(c => c.text.startsWith('╭'));
		expect(border).toBeDefined();
		expect(rgb(border!)).toBeTruthy();
		const title = chunks.find(c => c.text.includes('bobonyo'));
		expect(rgb(title!)).toBe(primary);
	});
});

describe('tokenizeFileDiff', () => {
	const THEME: Colors = colors();
	const DIFF_TEXT = [
		'✦ Edit src/foo.ts',
		' ⎿ 12 lines → 10 lines',
		'   2 - return `Hello, ${name.toUpperCase()}!`;',
		'   2 + return `Hi, ${name.toUpperCase()}!`;',
		'   6 - const alpha = compute(firstArgument, secondArgument);',
		'   6 + const result = await loadEverythingFromScratch();',
	].join('\n');

	test('changed rows get a full-width row background', () => {
		const chunks = tokenizeFileDiff(DIFF_TEXT, 'src/foo.ts', 'done', THEME, 80);
		const lines = perLine(chunks);
		for (const line of lines.slice(2, 6)) {
			// The indent chunk carries the row bg (skip empty separator chunks).
			const indent = line.find(c => c.text.length > 0 && c.text.trim() === '');
			expect(indent).toBeDefined();
			expect(bg(indent!)).toBeTruthy();
		}
	});

	test('rows never exceed the renderable width (the old `-2` fill wrapped)', () => {
		const width = historyFillWidth(110);
		const chunks = tokenizeFileDiff(
			DIFF_TEXT,
			'src/foo.ts',
			'done',
			THEME,
			width,
		);
		const lines = perLine(chunks);
		for (const line of lines.slice(2, 6)) {
			const total = line.reduce((sum, c) => sum + c.text.length, 0);
			expect(total).toBeLessThanOrEqual(width);
		}
	});

	test('similar paired lines get the darker word background', () => {
		const chunks = tokenizeFileDiff(DIFF_TEXT, 'src/foo.ts', 'done', THEME, 80);
		const lines = perLine(chunks);
		const remove = lines[2] ?? [];
		const wordBgs = remove
			.map(c => bg(c))
			.filter(
				(value): value is string =>
					value ===
					`rgb(${Math.round(0x88)},${Math.round(0x33)},${Math.round(0x44)})`,
			);
		expect(wordBgs.length).toBeGreaterThan(0);
	});

	test('asymmetric replacements highlight each row exact changed span', () => {
		const diff = [
			'✦ Edit app-delivery.spec.ts',
			' ⎿ 1 line → 1 line',
			'  97 - await page.getByLabel("To").fill(recipient);',
			'  97 + await page.getByPlaceholder("you@example.com").fill(recipient);',
		].join('\n');
		const chunks = tokenizeFileDiff(
			diff,
			'app-delivery.spec.ts',
			'done',
			THEME,
			100,
		);
		const lines = perLine(chunks);
		const removedBg = themeRgb(colors().diffRemovedWord);
		const addedBg = themeRgb(colors().diffAddedWord);
		const highlighted = (line: TextChunk[], targetBg: string) =>
			line
				.filter(chunk => bg(chunk) === targetBg)
				.map(chunk => chunk.text)
				.join('');
		// Closing `")` is shared suffix, so only differing middle is dark.
		expect(highlighted(lines[2] ?? [], removedBg)).toBe('Label("To');
		expect(highlighted(lines[3] ?? [], addedBg)).toBe(
			'Placeholder("you@example.com',
		);
	});
	test('rewritten pairs (>0.6 change ratio) skip the word background', () => {
		const chunks = tokenizeFileDiff(DIFF_TEXT, 'src/foo.ts', 'done', THEME, 80);
		const lines = perLine(chunks);
		// Line 5 = the `- 6 const alpha…` rewrite, no wordBg anywhere.
		const rewrite = lines[4] ?? [];
		const wordBg = `rgb(${Math.round(0x88)},${Math.round(0x33)},${Math.round(0x44)})`;
		expect(rewrite.some(c => bg(c) === wordBg)).toBe(false);
	});

	test('unpaired delete-only rows render plain row bg (no word bg)', () => {
		const deleteOnly = [
			'✦ Edit scratch/mock-delete.ts',
			' ⎿ 8 lines → 0 lines',
			'   1 - /**',
			'   2 -  * Legacy string utilities.',
			'   8 - }',
		].join('\n');
		const chunks = tokenizeFileDiff(
			deleteOnly,
			'scratch/mock-delete.ts',
			'done',
			THEME,
			80,
		);
		const lines = perLine(chunks);
		const wordBg = `rgb(${Math.round(0x88)},${Math.round(0x33)},${Math.round(0x44)})`;
		for (const line of lines.slice(2)) {
			expect(line.some(c => bg(c) === wordBg)).toBe(false);
		}
	});

	test('leading blank line (fence artifact) does not desync the body', () => {
		const withBlank = `\n${DIFF_TEXT}`;
		const chunks = tokenizeFileDiff(withBlank, 'src/foo.ts', 'done', THEME, 80);
		const lines = perLine(chunks);
		// The header is line 0 (after the stripped blank) and rows 2+ are
		// changed rows with backgrounds, no dim fallback.
		expect(lines[0]?.some(c => c.text.includes('Edit'))).toBe(true);
		for (const line of lines.slice(2, 6)) {
			expect(line.some(c => bg(c))).toBe(true);
		}
	});

	test('.txt diffs never get keyword syntax colors (plain text)', () => {
		const txtDiff = [
			'✦ Edit scratch/mock-edit.txt',
			' ⎿ 1 line → 1 line',
			'   1 - old text',
			'   1 + new text',
		].join('\n');
		const chunks = tokenizeFileDiff(
			txtDiff,
			'scratch/mock-edit.txt',
			'done',
			THEME,
			80,
		);
		const lines = perLine(chunks);
		// `new` is a JS keyword — on a .txt file it must NOT render primary;
		// it keeps the diff row foreground (success green) instead.
		const primary = themeRgb(colors().primary);
		const addText = lines[3]?.find(c => c.text.includes('new'));
		expect(addText).toBeDefined();
		expect(rgb(addText!)).not.toBe(primary);
		expect(rgb(addText!)).toBe(themeRgb(colors().diffAddedText));
	});

	test('.txt file previews stay plain (no keyword tint)', () => {
		const chunks = tokenizeFileRow(
			'✦ Write scratch/readme.txt\n ⎿ Write: 1 line\n   1 new text',
			'scratch/readme.txt',
			'done',
			THEME,
		);
		const primary = themeRgb(colors().primary);
		const bodyText = chunks.find(c => c.text.includes('new text'));
		expect(bodyText).toBeDefined();
		expect(rgb(bodyText!)).not.toBe(primary);
	});

	test('every diff text chunk stays readable on its background', () => {
		const jsDiff = [
			'✦ Edit src/foo.ts',
			' ⎿ 1 line → 1 line',
			'   1 - const x = compute(a, b);',
			'   1 + const x = compute(c, b);',
		].join('\n');
		const chunks = tokenizeFileDiff(jsDiff, 'src/foo.ts', 'done', THEME, 80);
		const lum = (v: RGBA): number => 0.2126 * v.r + 0.7152 * v.g + 0.0722 * v.b;
		for (const line of perLine(chunks).slice(2)) {
			for (const c of line) {
				if (!c.bg || !c.fg || c.text.trim() === '') continue;
				// The readableOn guard keeps the fg at least 0.35 luminance
				// away from the row/word background — never unreadable.
				expect(Math.abs(lum(c.fg) - lum(c.bg))).toBeGreaterThanOrEqual(0.35);
			}
		}
	});

	test('word-diff spans swap the fg when the diff color fails the bar', () => {
		// `old text` → `new text`: the paired WORD span (`old`/`new`) sits
		// on the darker word background. The red/error fg does NOT clear the
		// 0.35 luminance bar there, so readableOn must swap it — the exact
		// "hard to read" case that regressed before the guard existed.
		const txtDiff = [
			'✦ Edit scratch/mock-edit.txt',
			' ⎿ 1 line → 1 line',
			'   1 - old text',
			'   1 + new text',
		].join('\n');
		const chunks = tokenizeFileDiff(
			txtDiff,
			'scratch/mock-edit.txt',
			'done',
			THEME,
			80,
		);
		const lines = perLine(chunks);
		const error = themeRgb(colors().error);
		const removeWord = lines[2]?.find(c => c.text.trim() === 'old');
		expect(removeWord).toBeDefined();
		// The word span on the word background must NOT keep the error fg…
		expect(rgb(removeWord!)).not.toBe(error);
		// …and it must still clear the contrast bar against its background.
		const lum = (v: RGBA): number => 0.2126 * v.r + 0.7152 * v.g + 0.0722 * v.b;
		expect(removeWord!.bg).toBeDefined();
		expect(
			Math.abs(lum(removeWord!.fg!) - lum(removeWord!.bg!)),
		).toBeGreaterThanOrEqual(0.35);
	});

	test("ADD rows keep the code's indentation (tabs EXPANDED to spaces)", () => {
		// Two reported bugs here. (1) The greedy `[-+]\s+` sigil regex
		// swallowed the code's leading indentation → added lines rendered
		// flush at the gutter; the sigil takes EXACTLY one separator. (2)
		// Literal `\t` chunks break the NATIVE OpenTUI layout — every
		// tab-indented diff line renders a blank row after it in a real
		// terminal (herdr), invisible to the test renderer. Tabs must be
		// EXPANDED to spaces (2 per tab) so the indentation is preserved
		// and the rows stay contiguous.
		const tabDiff = [
			'✦ Edit src/foo.ts',
			' ⎿ 3 lines → 5 lines',
			'     1   \t\tconst display = read("./tool-display.ts");',
			'     3 + \t\t// INDENTATION: comment here',
			'     4 + \t\texpect(display).toMatch(/const lead/);',
			'     3   \t});',
		].join('\n');
		const chunks = tokenizeFileDiff(tabDiff, 'src/foo.ts', 'done', THEME, 80);
		const lines = perLine(chunks);
		// The ADD rows' code text starts with the SAME indentation as the
		// context row — `+     //`, never `+ //` (flush) and never a raw
		// `\t` (which would break the native layout).
		const add1 = lines[3] ?? [];
		expect(join(add1)).toMatch(/^ {5}3 \+ {5}\/\/ INDENTATION/);
		const add2 = lines[4] ?? [];
		expect(join(add2)).toMatch(/^ {5}4 \+ {5}expect\(display\)/);
		// No literal tab survives in ANY chunk of the diff.
		expect(add1.some(c => c.text.includes('\t'))).toBe(false);
		expect(add2.some(c => c.text.includes('\t'))).toBe(false);
		// And no chunk anywhere in the tokenized diff carries a tab.
		const allText = chunks.map(c => c.text).join('');
		expect(allText).not.toContain('\t');
	});
	test('long diff rows WRAP INSIDE the container, never overflow into a phantom line', () => {
		// The intermittent "additional lines" bug: a diff line longer than
		// the renderable width overflowed, and the TERMINAL wrapped the
		// orphan tail onto its own row (visible in herdr, invisible to the
		// clipped test renderer). Long rows must split into continuation
		// pieces that stay ≤ the width, indent to the code column, and keep
		// the row background — the painted rows then match the summary.
		const longOld = [
			'The legacy `CLAUDE.md` documents the **nanocoder fork workflow** (rc/fork',
			'branches, `fork-flow.sh`, upstream PRs). It is nanocoder-only: bobonyo does',
			'**not** follow it. bobonyo is a plain single-repo project on `main`, with no',
			'upstream remote and no branch fleet.',
		].join('\n');
		const longNew = [
			'This file replaces the old parent-level `CLAUDE.md` (which documented the',
			'nanocoder fork workflow — rc/fork branches, `fork-flow.sh`, upstream PRs).',
			'That file is gone and bobonyo does not follow it: bobonyo is a plain',
			'single-repo project on `main`, with no upstream remote and no branch fleet.',
		].join('\n');
		const raw = formatToolEntry(
			{
				name: 'string_replace',
				detail: 'AGENTS.md',
				output: `Replaced 1 occurrence in AGENTS.md (at line 8)\n${longNew}`,
				args: {path: 'AGENTS.md', old_string: longOld, new_string: longNew},
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
		const chunks = tokenizeFileDiff(inner, 'AGENTS.md', 'done', THEME, 84);
		const lines = perLine(chunks);
		// Every painted row stays inside the renderable width.
		for (const line of lines) {
			const total = line.reduce((sum, c) => sum + c.text.length, 0);
			expect(total).toBeLessThanOrEqual(84);
		}
		// The 77-char `10 - **not**…` row splits: first piece at the code
		// column, continuation re-indented to the SAME code column (9) and
		// still carrying the row background (part of the same painted row).
		const continuation = lines.find(line => {
			const text = join(line);
			// The continuation is the row that starts at the code column and
			// carries ONLY the wrapped fragment (no number, no sigil).
			return text.startsWith(' '.repeat(9)) && text.trim() === 'o';
		});
		expect(continuation).toBeDefined();
		expect(bg(continuation!.find(c => c.text.trim() === 'o')!)).toBeTruthy();
		// No BODY row is a bare orphan fragment at column 0 (the header row
		// legitimately starts with its ✦ glyph — skip it).
		for (const line of lines.slice(1)) {
			const text = join(line);
			if (text.trim()) expect(text.startsWith(' ')).toBe(true);
		}
	});
	test('a long path header is capped to the renderable width (never wraps a phantom line)', () => {
		// `✦ Edit /very/long/repo/path/file.ts` outgrows a narrow terminal; the
		// TERMINAL wraps the overflow onto a phantom blank row after the
		// header (the "extra breakline" in the diff view — the OpenTUI test
		// renderer clips instead of wrapping, so this is asserted at the
		// chunk level). The path shortens with a head ellipsis, the filename
		// stays visible.
		const width = historyFillWidth(70);
		const header =
			'✦ Edit /mnt/data/KSProjects/NanoCollective/bobonyo/src/components/completion-popup.tsx';
		const chunks = tokenizeFileDiff(
			`${header}\n ⎿ 2 lines → 17 lines\n   1 - const a = 1;`,
			'/mnt/data/KSProjects/NanoCollective/bobonyo/src/components/completion-popup.tsx',
			'done',
			THEME,
			width,
		);
		const lines = perLine(chunks);
		const headerLine = lines[0] ?? [];
		const total = headerLine.reduce((sum, c) => sum + c.text.length, 0);
		// The capped header fits the renderable — no overflow, no wrap.
		expect(total).toBeLessThanOrEqual(width);
		// The filename survives; the long head is ellipsized.
		const headerText = headerLine.map(c => c.text).join('');
		expect(headerText).toContain('completion-popup.tsx');
		expect(headerText).toContain('…');
		expect(headerText).not.toContain('NanoCollective');
	});
	test('a short path header stays untouched (no cap)', () => {
		const chunks = tokenizeFileDiff(DIFF_TEXT, 'src/foo.ts', 'done', THEME, 80);
		const lines = perLine(chunks);
		const headerText = (lines[0] ?? []).map(c => c.text).join('');
		expect(headerText).toBe('✦ Edit src/foo.ts');
	});
});

describe('tokenizeStatusRow', () => {
	test('model[effort] brackets survive the row tokenizer', () => {
		const text = [
			'Model:     mock-model-1[medium]',
			'Directory: /mnt/data',
		].join('\n');
		const chunks = tokenizeStatusRow(text, colors());
		expect(join(chunks)).toContain('mock-model-1[medium]');
	});

	test('labels render secondary, values in text color', () => {
		const chunks = tokenizeStatusRow('Model:     mock-model-1', colors());
		const lines = perLine(chunks);
		const line = lines[0] ?? [];
		const label = line.find(c => c.text.includes('Model:'));
		expect(rgb(label!)).toBe(themeRgb(colors().secondary));
	});
});

describe('tokenizeUserMessage', () => {
	test('the background spans the whole row, not just the text', () => {
		const chunks = tokenizeUserMessage('❯ hello\nworld\n\n', colors(), 40);
		const lines = perLine(chunks);
		expect(lines.length).toBe(2);
		for (const line of lines) {
			const total = line.reduce((sum, c) => sum + c.text.length, 0);
			expect(total).toBe(40);
			// Every line, including the continuation, carries the bg on
			// its text AND its padding (empty newline separators excluded).
			expect(line.filter(c => c.text.length > 0).every(c => bg(c))).toBe(true);
		}
	});

	test('message rows stay within the renderable width (no wrap gaps)', () => {
		const width = historyFillWidth(110);
		const chunks = tokenizeUserMessage('❯ hello\nworld', colors(), width);
		const lines = perLine(chunks);
		for (const line of lines) {
			const total = line.reduce((sum, c) => sum + c.text.length, 0);
			expect(total).toBeLessThanOrEqual(width);
		}
	});

	test('continuation lines keep message content indentation', () => {
		const chunks = tokenizeUserMessage(
			'❯ first line\n* second line\n* third line',
			colors(),
			0,
		);
		const lines = perLine(chunks);
		expect(lines[1]?.map(chunk => chunk.text).join('')).toBe('  * second line');
		expect(lines[2]?.map(chunk => chunk.text).join('')).toBe('  * third line');
	});

	test('colors KNOWN commands and REAL attachment tokens in the content', () => {
		const chunks = tokenizeUserMessage(
			'❯ check /status and [Image #1]',
			colors(),
			0,
			'1',
		);
		expect(rgb(chunks.find(c => c.text === '/status')!)).toBe(
			themeRgb(colors().primary),
		);
		expect(rgb(chunks.find(c => c.text === '[Image #1]')!)).toBe(
			themeRgb(colors().primary),
		);
	});

	test('colors a real image token on a continuation line', () => {
		const chunks = tokenizeUserMessage(
			'❯ now for aug 4, 7, 9:\n[Image #1]',
			colors(),
			0,
			'1',
		);
		expect(rgb(chunks.find(c => c.text === '[Image #1]')!)).toBe(
			themeRgb(colors().primary),
		);
	});
	test('MANUALLY typed [Image #N] tokens stay plain (not real attachments)', () => {
		const chunks = tokenizeUserMessage(
			'❯ [Image #1] is not attached',
			colors(),
			0,
			'',
		);
		expect(rgb(chunks.find(c => c.text === '[Image #1]')!)).toBe(
			themeRgb(colors().text),
		);
	});
});

describe('group header colors (compact tally)', () => {
	test('activity tree header is white; actions primary; connectors secondary', () => {
		const chunks = tokenizeToolRow(
			'Explored\n  ├ Read src/a.ts\n  └ Search needle',
			'done',
			colors(),
		);
		expect(rgb(chunks.find(c => c.text === 'Explored')!)).toBe(
			themeRgb(colors().text),
		);
		expect(rgb(chunks.find(c => c.text === 'Read')!)).toBe(
			themeRgb(colors().primary),
		);
		expect(rgb(chunks.find(c => c.text === '  ├ ')!)).toBe(
			themeRgb(colors().secondary),
		);
		expect(rgb(chunks.find(c => c.text === 'Search')!)).toBe(
			themeRgb(colors().primary),
		);
	});

	test('multi-word MCP action is primary; parenthesized details are normal text', () => {
		const chunks = tokenizeToolRow(
			'Codebase Memory MCP\n  └ search code(src/activity-groups.ts)',
			'done',
			colors(),
		);
		expect(rgb(chunks.find(c => c.text === 'search code')!)).toBe(
			themeRgb(colors().primary),
		);
		expect(rgb(chunks.find(c => c.text === '(src/activity-groups.ts)')!)).toBe(
			themeRgb(colors().text),
		);
	});

	test('Ran and ×N stay white; only tool names are primary', () => {
		const chunks = tokenizeToolRow(
			'✦ Ran Bash ×10 (ctrl-o to expand)\n  └   tail',
			'done',
			colors(),
		);
		const joined = join(chunks);
		expect(joined).toContain('Ran Bash ×10');
		const ran = chunks.find(c => c.text === 'Ran ');
		expect(rgb(ran!)).toBe(themeRgb(colors().text));
		const bash = chunks.find(c => c.text === 'Bash');
		expect(rgb(bash!)).toBe(themeRgb(colors().primary));
		const tally = chunks.find(c => c.text === ' ×10');
		expect(rgb(tally!)).toBe(themeRgb(colors().text));
	});

	test('multi-tool tally: tool names primary, separators white', () => {
		const chunks = tokenizeToolRow(
			'✦ Ran WebSearch ×3 and WebFetch ×2 (ctrl-o to expand)',
			'done',
			colors(),
		);
		const joined = join(chunks);
		expect(joined).toContain('WebSearch ×3 and WebFetch ×2');
		expect(rgb(chunks.find(c => c.text === 'WebSearch')!)).toBe(
			themeRgb(colors().primary),
		);
		expect(rgb(chunks.find(c => c.text === ' and ')!)).toBe(
			themeRgb(colors().text),
		);
		expect(rgb(chunks.find(c => c.text === ' ×3')!)).toBe(
			themeRgb(colors().text),
		);
	});

	test('GLYPH-LESS Ran header (liveRowSegments strips the glyph) still splits', () => {
		// The real pipeline passes the header WITHOUT the leading ✦/⚙ (the
		// glyph renders/blinks separately), so the tokenizer must color the
		// glyph-less form identically — a regression makes everything primary.
		const chunks = tokenizeToolRow('Ran Read ×2\n  └   tail', 'done', colors());
		expect(join(chunks)).toContain('Ran Read ×2');
		expect(rgb(chunks.find(c => c.text === 'Ran ')!)).toBe(
			themeRgb(colors().text),
		);
		expect(rgb(chunks.find(c => c.text === 'Read')!)).toBe(
			themeRgb(colors().primary),
		);
		expect(rgb(chunks.find(c => c.text === ' ×2')!)).toBe(
			themeRgb(colors().text),
		);
	});

	test('glyph-less multi-tool tally keeps separators and ×N white', () => {
		const chunks = tokenizeToolRow(
			'Ran WebSearch ×3 and WebFetch ×2 (ctrl-o to expand)',
			'done',
			colors(),
		);
		expect(join(chunks)).toContain('WebSearch ×3 and WebFetch ×2');
		expect(rgb(chunks.find(c => c.text === 'Ran ')!)).toBe(
			themeRgb(colors().text),
		);
		expect(rgb(chunks.find(c => c.text === ' and ')!)).toBe(
			themeRgb(colors().text),
		);
		expect(rgb(chunks.find(c => c.text === ' ×2')!)).toBe(
			themeRgb(colors().text),
		);
	});

	test('glyph-less agent row: Ran secondary, agent name primary', () => {
		const chunks = tokenizeAgentRow(
			'Ran agent:explore(task) done',
			'done',
			colors(),
		);
		expect(rgb(chunks.find(c => c.text === 'Ran ')!)).toBe(
			themeRgb(colors().secondary),
		);
		expect(rgb(chunks.find(c => c.text === 'agent:explore')!)).toBe(
			themeRgb(colors().primary),
		);
	});
});

describe('readableOn', () => {
	test('keeps a contrasting fg and swaps a matching one', () => {
		const bg = RGBA.fromHex('#565f89');
		const text = RGBA.fromHex('#ffffff');
		const base = RGBA.fromHex('#1a1b26');
		// White on the dark tint clears the bar → kept.
		expect(readableOn(bg, text, text, base)).toBe(text);
		// Secondary-on-secondary (invisible) → swapped to white.
		const swapped = readableOn(bg, bg, text, base);
		expect(Math.abs(swapped.r - text.r) < 0.02).toBe(true);
	});
});

describe('tokenizeWarningRow', () => {
	test('renders the fallback indicator in the WARNING (yellow) color', () => {
		const chunks = tokenizeWarningRow(
			'  ✦ Vision fallback: mimo-v2.5 analyzed 1 image → mimo-v2.5-pro responds',
			colors(),
		);
		const joined = join(chunks);
		expect(joined).toContain('Vision fallback');
		expect(rgb(chunks.find(c => c.text.includes('Vision'))!)).toBe(
			themeRgb(colors().warning),
		);
	});
});

describe('tokenizeTaskRow lifecycle', () => {
	test('completed and cancelled labels are struck through', () => {
		const chunks = tokenizeTaskRow(
			'✦ Tasks (1 done, 1 in progress, 1 open)\n  └ ◆ Inspect code\n    › Running tests\n    × Skip obsolete step\n    · Build release',
			'done',
			colors(),
		);
		const completed = chunks.find(chunk => chunk.text === 'Inspect code');
		const completedIcon = chunks.find(chunk => chunk.text === '◆');
		const cancelled = chunks.find(chunk => chunk.text === 'Skip obsolete step');
		const running = chunks.find(chunk => chunk.text === 'Running tests');
		expect(completed?.attributes).toBe(
			createTextAttributes({strikethrough: true, dim: true}),
		);
		expect(cancelled?.attributes).toBe(
			createTextAttributes({strikethrough: true, dim: true}),
		);
		expect(rgb(completed!)).toBe(themeRgb(colors().secondary));
		expect(rgb(completedIcon!)).toBe(themeRgb(colors().secondary));
		expect(completedIcon?.attributes).toBe(
			createTextAttributes({strikethrough: true, dim: true}),
		);
		expect(running?.attributes ?? 0).toBe(0);
	});

	test('task branch is secondary while first task keeps lifecycle color', () => {
		const chunks = tokenizeTaskRow(
			'✦ Deploy release (0 done, 1 in progress, 0 open)\n  └ › Checking build',
			'running',
			colors(),
		);
		expect(rgb(chunks.find(chunk => chunk.text === '└ ')!)).toBe(
			themeRgb(colors().secondary),
		);
		expect(rgb(chunks.find(chunk => chunk.text === '›')!)).toBe(
			themeRgb(colors().warning),
		);
	});
	test('compact completed task snapshot title is dim, not primary', () => {
		const chunks = tokenizeTaskRow(
			'✦ Potential import history triggers Solid? okay...\n  └ Tasks (3 done, 1 in progress, 0 open)',
			'done',
			colors(),
		);
		const title = chunks.find(chunk =>
			chunk.text.includes('Potential import history'),
		);
		expect(rgb(title!)).toBe(themeRgb(colors().secondary));
		expect(title?.attributes).toBe(createTextAttributes({dim: true}));
	});
});
