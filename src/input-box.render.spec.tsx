import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {RGBA, type CapturedFrame, type CapturedLine} from '@opentui/core';
import {For, Show} from 'solid-js';
import type {TestRendererSetup} from '@opentui/core/testing';
import {InputBox} from './components/input-box';
import {
	input,
	setInput,
	setModelOpen,
	setPendingQueue,
	setSpinnerFrame,
} from './state';
import {colors} from './theme';
import {activeRowPalette} from './row-highlight';
import {createTextAttributes} from '@opentui/core';

/**
 * RENDER-LEVEL regression guard for the Shift+Enter caret (this bug
 * recurred repeatedly, so the guard must be as strict as possible):
 *
 * The old bug painted a phantom cell before the caret on EMPTY lines
 * because `tokenizeInputLine('')` produced `[{text:''}]` and OpenTUI
 * renders an empty <text> as ONE real cell — the block cursor landed one
 * column too far forward on the Shift+Enter continuation line. A second
 * variant deleted the caret cell in the hidden blink phase, shifting the
 * whole line. These tests mount the REAL InputBox through the REAL OpenTUI
 * test renderer, feed the herdr physical key encodings (`ESC[13;2u`
 * Shift+Enter, `ESC[104;5u` Backspace), and assert the EXACT painted cell
 * column of the caret span at every step, plus that the hidden blink phase
 * keeps the caret cell and the layout byte-identical.
 */

interface CaretHit {
	line: number;
	col: number;
	width: number;
	text: string;
}

function caretRgba(themeColors = colors()): RGBA {
	return activeRowPalette(themeColors).bg;
}

/** Every span painted with the active-row background (the caret block). */
function caretSpans(frame: CapturedFrame, themeColors = colors()): CaretHit[] {
	const palette = activeRowPalette(themeColors);
	const hits: CaretHit[] = [];
	frame.lines.forEach((line, y) => {
		let col = 0;
		for (const span of line.spans) {
			const bg = span.bg as RGBA;
			const match =
				Math.abs(bg.r - palette.bg.r) < 0.01 &&
				Math.abs(bg.g - palette.bg.g) < 0.01 &&
				Math.abs(bg.b - palette.bg.b) < 0.01;
			if (match) hits.push({line: y, col, width: span.width, text: span.text});
			col += span.width;
		}
	});
	return hits;
}

function spanTexts(line: CapturedLine): string[] {
	return line.spans.map(span => span.text);
}

/** Column where a span whose text CONTAINS `needle` starts, or -1. */
function columnOfText(line: CapturedLine, needle: string): number {
	let col = 0;
	for (const span of line.spans) {
		if (span.text.includes(needle)) return col;
		col += span.width;
	}
	return -1;
}

function textAt(line: CapturedLine, col: number): string | null {
	let c = 0;
	for (const span of line.spans) {
		if (c === col) return span.text;
		if (c > col) return null;
		c += span.width;
	}
	return null;
}

async function mountInput(): Promise<TestRendererSetup> {
	setInput('');
	setSpinnerFrame(0);
	return testRender(() => <InputBox onSubmit={() => {}} />, {
		width: 80,
		height: 24,
		// herdr/ghostty speaks the kitty keyboard protocol natively; the
		// mock then emits the SAME physical encodings the user's terminal
		// does (Shift+Enter = ESC[13;2u, Backspace = ESC[104;5u).
		kittyKeyboard: true,
	});
}

describe('InputBox caret rendering (Shift+Enter regression, render-level)', () => {
	test('herdr Shift+Enter: caret lands EXACTLY at the first content column of the empty continuation line, with no phantom cell', async () => {
		const setup = await mountInput();
		try {
			const {mockInput} = setup;
			await mockInput.typeText('hi');
			await setup.flush();

			// Typed text sits at cols 4-5 (border 0, padding 1, `❯ ` 2-3);
			// the caret block must be ONE cell at col 6, right after `hi`.
			// Capture rows: 0 = top border, 1 = first input row.
			expect(input()).toBe('hi');
			let frame = setup.captureSpans();
			let hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({line: 1, col: 6, width: 1});

			// herdr physical Shift+Enter = ESC[13;2u (kitty CSI-u).
			mockInput.pressEnter({shift: true});
			await setup.flush();
			expect(input()).toBe('hi\n');

			frame = setup.captureSpans();
			hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			// On the EMPTY continuation line the caret must be at col 4 —
			// the exact cell where the next typed character lands (after the
			// 2-space indent at cols 2-3). Any phantom cell pushes it to 5.
			expect(hits[0]).toMatchObject({line: 2, col: 4, width: 1});

			// STRICT structure: the caret line is EXACTLY
			//   border | padding | '  ' indent | CARET | fill | border
			// with the caret span immediately following the indent — no
			// extra plain span between them (that was the recurring bug).
			const caretLine = frame.lines[2]!;
			const texts = spanTexts(caretLine);
			expect(texts[0]).toBe('│');
			expect(texts[1]).toBe(' ');
			expect(texts[2]).toBe('  ');
			expect(texts[3]).toBe(' ');
			expect(caretLine.spans[3]!.width).toBe(1);
			// The indent occupies cols 2-3 and the caret starts at col 4:
			// NOTHING may sit between them (that phantom was the bug).
			expect(textAt(caretLine, 2)).toBe('  ');
			expect(textAt(caretLine, 4)).toBe(' ');
			// The caret span itself is the info-tinted block.
			expect(caretLine.spans[3]!.bg).toEqual(caretRgba());
		} finally {
			setup.renderer.destroy();
		}
	});

	test('typing on the continuation line lands at the caret; herdr Backspace (ESC[104;5u) and kitty Backspace (ESC[8u) both delete across the newline', async () => {
		const setup = await mountInput();
		try {
			const {mockInput} = setup;
			await mockInput.typeText('hi');
			mockInput.pressEnter({shift: true});
			await setup.flush();
			expect(input()).toBe('hi\n');

			await mockInput.typeText('s2');
			await setup.flush();
			expect(input()).toBe('hi\ns2');
			// `s2` painted exactly at cols 4-5, caret ONE cell at col 6.
			let frame = setup.captureSpans();
			let hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({line: 2, col: 6, width: 1});
			expect(spanTexts(frame.lines[2]!)).toEqual([
				'│',
				' ',
				'  ',
				's2',
				' ',
				expect.any(String),
				'│',
			]);

			// herdr PHYSICAL Backspace = kitty Ctrl+H = ESC[104;5u.
			mockInput.pressKey('h', {ctrl: true});
			await setup.flush();
			expect(input()).toBe('hi\ns');
			frame = setup.captureSpans();
			hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({line: 2, col: 5, width: 1});

			// kitty Backspace = ESC[8u (codepoint 8, the \x08 path).
			mockInput.pressBackspace();
			await setup.flush();
			expect(input()).toBe('hi\n');
			frame = setup.captureSpans();
			hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({line: 2, col: 4, width: 1});

			// Backspace joins the lines and keeps deleting up to empty.
			mockInput.pressBackspace();
			await setup.flush();
			expect(input()).toBe('hi');
			frame = setup.captureSpans();
			hits = caretSpans(frame);
			expect(hits[0]).toMatchObject({line: 1, col: 6, width: 1});

			mockInput.pressBackspace();
			mockInput.pressBackspace();
			await setup.flush();
			expect(input()).toBe('');
			frame = setup.captureSpans();
			hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			// Empty line 0: caret right after `❯ ` (cols 2-3), i.e. col 4.
			expect(hits[0]).toMatchObject({line: 1, col: 4, width: 1});
		} finally {
			setup.renderer.destroy();
		}
	});

	test('hidden blink phase keeps the caret CELL and the hint column (no line shift, square never disappears)', async () => {
		setInput('');
		setSpinnerFrame(0);
		const setup = await testRender(() => <InputBox onSubmit={() => {}} />, {
			width: 80,
			height: 24,
		});
		try {
			await setup.flush();

			// VISIBLE phase (spinnerFrame 0): caret block at col 4.
			let frame = setup.captureSpans();
			let hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({line: 1, col: 4, width: 1});
			expect(columnOfText(frame.lines[1]!, '/ commands')).toBe(5);

			// HIDDEN phase (spinnerFrame 4 -> (4 >> 2) % 2 === 1): the caret
			// cell stays as a PLAIN space at col 4 — the row width and the
			// hint position must not move (the "square disappeared" bug
			// removed the cell entirely and shifted the line left).
			setSpinnerFrame(4);
			await setup.flush();
			frame = setup.captureSpans();
			hits = caretSpans(frame);
			expect(hits).toHaveLength(0);
			expect(textAt(frame.lines[1]!, 4)).toBe(' ');
			expect(columnOfText(frame.lines[1]!, '/ commands')).toBe(5);

			// And back to visible: the block returns at the SAME column.
			setSpinnerFrame(0);
			await setup.flush();
			frame = setup.captureSpans();
			hits = caretSpans(frame);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({line: 1, col: 4, width: 1});
			expect(columnOfText(frame.lines[1]!, '/ commands')).toBe(5);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('paste is ignored while a modal is open (chat box is inert)', async () => {
		setInput('');
		setModelOpen(true);
		const setup = await testRender(() => <InputBox onSubmit={() => {}} />, {
			width: 80,
			height: 24,
			kittyKeyboard: true,
		});
		try {
			await setup.flush();
			// Bracketed paste must NOT reach the chat input behind the modal.
			await setup.mockInput.pasteBracketedText('sk-pasted123');
			await setup.flush();
			expect(input()).toBe('');
		} finally {
			setModelOpen(false);
			setup.renderer.destroy();
		}
	});
	test('queued messages: header and rows render on SEPARATE lines (no overlap)', async () => {
		// The reported bug: the queue block used bare <text> nodes inside a
		// fixed-height column — the header (`Queued messages (…)`) and the
		// first queued message painted THE SAME ROW, mangling both (the
		// message overwrote the header). Mounts the REAL InputBox with a real
		// queued message: the header must paint on its OWN row and the
		// message on the NEXT, with `(queued)` + the value spaced apart.
		setInput('');
		setPendingQueue([
			{
				value:
					'feel free to also research this because some people might have encountered a problem when they are some TUI inside the herdr',
			},
		]);
		const setup = await testRender(() => <InputBox onSubmit={() => {}} />, {
			width: 120,
			height: 12,
		});
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			const rows = frame.lines.map(line =>
				line.spans
					.map(span => span.text)
					.join('')
					.trimEnd(),
			);
			// Header row and message row are DISTINCT — the message never
			// overwrites the header (the old single-mangled-line bug).
			const headerRow = rows.findIndex(row =>
				row.includes('Queued messages (↑/↓ select, Enter edit, Del remove):'),
			);
			expect(headerRow).toBeGreaterThanOrEqual(0);
			expect(rows[headerRow]).not.toContain('(queued)');
			const msgRow = rows.findIndex(row =>
				row.includes('feel free to also research'),
			);
			expect(msgRow).toBeGreaterThan(headerRow);
			// Tag + value are spaced: `(queued) feel` never `(queued)feel`.
			expect(rows[msgRow]).toContain('(queued) feel free');
			expect(rows[msgRow]).not.toContain('(queued)feel');
		} finally {
			setPendingQueue([]);
			setup.renderer.destroy();
		}
	});
});
