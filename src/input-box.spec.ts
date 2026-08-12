import {describe, expect, test} from 'bun:test';
import {
	atomicTokens,
	computeInputBoxHeight,
	cursorPosition,
	moveToNextWord,
	moveToPrevWord,
	offsetForLine,
	snapOutOfAtomicToken,
	tokenEndingAt,
	tokenizeInputLine,
	tokenStartingAt,
	workingLabel,
} from './components/input-box';
import {
	wrapText,
	wrapTextDetailed,
} from './text-wrap';

describe('wrapText', () => {
	test('wraps long lines at the width preserving words', () => {
		const lines = wrapText('one two three four', 8);
		// The wrap keeps the trailing separator space so the caret can map to
		// a typed space (trailing spaces render as blank cells).
		expect(lines.join('|')).toBe('one two |three |four');
	});

	test('splits explicit newlines into separate lines', () => {
		expect(wrapText('line1\nline2', 20)).toEqual(['line1', 'line2']);
	});

	test('hard-splits a single over-long word', () => {
		const lines = wrapText('abcdefghij', 4);
		expect(lines).toEqual(['abcd', 'efgh', 'ij']);
	});
});

describe('workingLabel (hide-thinking indicator phase)', () => {
	test('says Thinking only while reasoning AND hide-thinking is on', () => {
		expect(workingLabel(true, true)).toBe('Thinking');
		expect(workingLabel(true, false)).toBe('Working');
		expect(workingLabel(false, true)).toBe('Working');
		expect(workingLabel(false, false)).toBe('Working');
	});
});

describe('computeInputBoxHeight', () => {
	test('grows with the wrapped input lines (no single-row limit)', () => {
		const wrapped = wrapText('x'.repeat(200), 40).length;
		expect(computeInputBoxHeight('x'.repeat(200), 60, false)).toBe(wrapped + 2);
	});

	test('idle box stays one interior row', () => {
		expect(computeInputBoxHeight('', 80, false)).toBe(3);
	});
});

describe('tokenizeInputLine', () => {
	test('colors a KNOWN /command as primary at the start', () => {
		expect(tokenizeInputLine('/clear')).toEqual([
			{text: '/clear', token: true},
		]);
	});

	test('highlights a known /command ANYWHERE in the line (openclaude-style)', () => {
		expect(tokenizeInputLine('see /status for details')).toEqual([
			{text: 'see ', token: false},
			{text: '/status', token: true},
			{text: ' for details', token: false},
		]);
	});

	test('leaves UNKNOWN /words plain', () => {
		expect(tokenizeInputLine('/not-a-command')).toEqual([
			{text: '/not-a-command', token: false},
		]);
	});

	test('colors attachment blocks as primary', () => {
		expect(tokenizeInputLine('see [Image #1] now')).toEqual([
			{text: 'see ', token: false},
			{text: '[Image #1]', token: true},
			{text: ' now', token: false},
		]);
	});

	test('colors a known command and later attachment blocks', () => {
		expect(tokenizeInputLine('/clear [Text #2]')).toEqual([
			{text: '/clear', token: true},
			{text: ' ', token: false},
			{text: '[Text #2]', token: true},
		]);
	});

	test('mock commands highlight only in preview mode', () => {
		const saved = process.argv.slice();
		process.argv.push('--preview', 'tui');
		try {
			expect(tokenizeInputLine('/mock:compact10')).toEqual([
				{text: '/mock:compact10', token: true},
			]);
		} finally {
			process.argv = saved;
		}
		expect(tokenizeInputLine('/mock:compact10')).toEqual([
			{text: '/mock:compact10', token: false},
		]);
	});
});

describe('atomic token navigation helpers', () => {
	test('treats attachment blocks as atomic; commands stay ordinary text', () => {
		expect(atomicTokens('x[Image #1]')).toEqual([
			{start: 1, end: 11},
		]);
		expect(atomicTokens('/mock:md [Text #2]')).toEqual([
			{start: 9, end: 18},
		]);
	});

	test('tokenEndingAt matches a token end exactly', () => {
		const value = 'a[Image #1]';
		expect(tokenEndingAt(value, value.length)).toBe(10);
		expect(tokenEndingAt(value, 2)).toBeNull();
	});

	test('tokenStartingAt matches a token start exactly', () => {
		const value = 'a[Image #1]';
		expect(tokenStartingAt(value, 1)).toBe(10);
		expect(tokenStartingAt(value, 2)).toBeNull();
	});
});

describe('word-jump helpers (Ctrl+Left / Ctrl+Right)', () => {
	// Expectations mirror the ORIGINAL nanocoder text-input specs.
	test('Ctrl+Left jumps to the start of the previous word', () => {
		expect(moveToPrevWord('hello world', 11)).toBe(6);
		expect(moveToPrevWord('hello world', 8)).toBe(6);
	});

	test('Ctrl+Left at the start stays at the start', () => {
		expect(moveToPrevWord('hello', 0)).toBe(0);
	});

	test('Ctrl+Left skips runs of spaces', () => {
		expect(moveToPrevWord('hello   world', 10)).toBe(8);
	});

	test('Ctrl+Left crosses newlines (multiline word-jump)', () => {
		expect(moveToPrevWord('hello world\nfoo bar', 12)).toBe(6);
	});

	test('Ctrl+Right jumps to just past the next word', () => {
		expect(moveToNextWord('hello world', 0)).toBe(6);
		expect(moveToNextWord('hello world', 6)).toBe(11);
	});

	test('Ctrl+Right at the end stays at the end', () => {
		expect(moveToNextWord('hello', 5)).toBe(5);
	});

	test('Ctrl+Right skips spaces before the next word', () => {
		expect(moveToNextWord('hello   world', 5)).toBe(8);
	});

	test('snapOutOfAtomicToken never lands the caret inside a token', () => {
		// "a [Text #1]b": token spans [2, 11); the raw word-jump lands at 8.
		const value = 'a [Text #1]b';
		expect(snapOutOfAtomicToken(value, 8, 'left')).toBe(2);
		expect(snapOutOfAtomicToken(value, 8, 'right')).toBe(11);
	});

	test('snapOutOfAtomicToken leaves off-token offsets alone', () => {
		expect(snapOutOfAtomicToken('hello world', 5, 'left')).toBe(5);
		expect(snapOutOfAtomicToken('hello world', 5, 'right')).toBe(5);
		expect(snapOutOfAtomicToken('a[Image #1]', 1, 'left')).toBe(1);
		expect(snapOutOfAtomicToken('a[Image #1]', 11, 'left')).toBe(11);
	});
});

describe('wrapTextDetailed', () => {
	test('records raw start offsets for wrapped lines', () => {
		const lines = wrapTextDetailed('one two three', 8);
		expect(lines.map(entry => entry.text)).toEqual([
			'one two ',
			'three',
		]);
		expect(lines.map(entry => entry.start)).toEqual([0, 8]);
	});

	test('keeps an empty final row for a trailing newline', () => {
		expect(wrapTextDetailed('a\n', 20)).toEqual([
			{text: 'a', start: 0},
			{text: '', start: 2},
		]);
	});

	test('empty input wraps to one empty row at offset zero', () => {
		expect(wrapTextDetailed('', 20)).toEqual([{text: '', start: 0}]);
	});
});

describe('cursorPosition', () => {
	test('maps a raw cursor to the wrapped line and column', () => {
		// 'one two three' at width 8 wraps to ['one two', 'three'].
		expect(cursorPosition('one two three', 0, 8)).toEqual({
			line: 0,
			column: 0,
		});
		expect(cursorPosition('one two three', 7, 8)).toEqual({
			line: 0,
			column: 7,
		});
		expect(cursorPosition('one two three', 8, 8)).toEqual({
			line: 1,
			column: 0,
		});
		expect(cursorPosition('one two three', 13, 8)).toEqual({
			line: 1,
			column: 5,
		});
	});

	test('puts a cursor after a newline on the new row', () => {
		expect(cursorPosition('a\nb', 2, 20)).toEqual({line: 1, column: 0});
		expect(cursorPosition('a\nb', 3, 20)).toEqual({line: 1, column: 1});
	});

	test('clamps out-of-range cursors', () => {
		expect(cursorPosition('abc', 99, 20)).toEqual({line: 0, column: 3});
		expect(cursorPosition('abc', -1, 20)).toEqual({line: 0, column: 0});
	});
});

describe('offsetForLine', () => {
	test('maps a (line, column) back to a raw offset for ↑/↓ movement', () => {
		const wrapped = wrapTextDetailed('one two three', 8);
		// ['one two' (0), 'three' (8)].
		expect(offsetForLine(wrapped, 1, 0)).toBe(8);
		expect(offsetForLine(wrapped, 1, 3)).toBe(11);
		// Column clamps to the target line length.
		expect(offsetForLine(wrapped, 1, 99)).toBe(13);
		expect(offsetForLine(wrapped, 0, 4)).toBe(4);
	});

	test('empty/out-of-range lines clamp safely', () => {
		expect(offsetForLine([], 0, 0)).toBe(0);
		expect(offsetForLine(wrapTextDetailed('ab', 20), 5, 0)).toBe(0);
	});
});
