import {describe, expect, test} from 'bun:test';
import type {TextChunk} from '@opentui/core';
import {
	applyHoverBackground,
	readableOn,
	tokenizeBanner,
	tokenizeFileDiff,
	tokenizeStatusRow,
	tokenizeToolRow,
	tokenizeUserMessage,
} from './row-highlight';
import {RGBA} from '@opentui/core';
import {colors, type Colors} from './theme';
import {historyFillWidth} from './history-width';

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
		'   -   2  return `Hello, ${name.toUpperCase()}!`;',
		'   +   2  return `Hi, ${name.toUpperCase()}!`;',
		'   -   6  const alpha = compute(firstArgument, secondArgument);',
		'   +   6  const result = await loadEverythingFromScratch();',
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
		const chunks = tokenizeFileDiff(DIFF_TEXT, 'src/foo.ts', 'done', THEME, width);
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
			.filter((value): value is string => value === `rgb(${Math.round(0x88)},${Math.round(0x33)},${Math.round(0x44)})`);
		expect(wordBgs.length).toBeGreaterThan(0);
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
			'   -   1 /**',
			'   -   2  * Legacy string utilities.',
			'   -   8 }',
		].join('\n');
		const chunks = tokenizeFileDiff(deleteOnly, 'scratch/mock-delete.ts', 'done', THEME, 80);
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
});

describe('hover contrast (text can never become invisible)', () => {
	test('secondary text on the secondary tint is replaced with a readable fg', () => {
		const chunks = tokenizeToolRow(
			'✦ Bash(echo hi)\n  └   EXIT_CODE: 0',
			'done',
			colors(),
		);
		const hovered = applyHoverBackground(chunks, true, colors());
		// The TITLE line keeps NO tint (hover highlights only the `└` body);
		// every BODY chunk carries the tint background…
		const firstNewline = chunks.findIndex(c => c.text.includes('\n'));
		expect(hovered.slice(0, firstNewline + 1).every(c => !bg(c))).toBe(true);
		expect(hovered.slice(firstNewline + 1).every(c => bg(c))).toBe(true);
		// …and none of the BODY chunks has the SAME color as the tint
		// (invisible text).
		const tint = RGBA.fromHex(colors().secondary);
		for (const c of hovered.slice(firstNewline + 1)) {
			if (!c.fg) continue;
			const same =
				Math.abs(c.fg.r - tint.r) < 0.02 &&
				Math.abs(c.fg.g - tint.g) < 0.02 &&
				Math.abs(c.fg.b - tint.b) < 0.02;
			expect(same).toBe(false);
		}
	});

	test('readableOn keeps a contrasting fg and swaps a matching one', () => {
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
