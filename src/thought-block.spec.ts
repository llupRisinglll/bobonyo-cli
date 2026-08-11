import {describe, expect, test} from 'bun:test';
import {RGBA} from '@opentui/core';
import {themeColors} from './highlight';
import {settledGlyphColor} from './row-highlight';
import {colors} from './theme';
import {thinkingSeconds} from './state';
import {liveThinkingHeader, wrapThoughtBody} from './components/history';

function rgb(c: RGBA): string {
	return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
}

describe('settledGlyphColor (thought gear never turns green)', () => {
	const palette = themeColors(colors());
	const secondary = rgb(palette.fg.secondary);
	const success = rgb(palette.fg.success);

	test('thought gear stays secondary whether done or running', () => {
		expect(rgb(settledGlyphColor('⚙', 'done', palette))).toBe(secondary);
		expect(rgb(settledGlyphColor('⚙', 'running', palette))).toBe(secondary);
	});

	test('tool glyphs follow the status (done = success green)', () => {
		expect(rgb(settledGlyphColor('✦', 'done', palette))).toBe(success);
		expect(rgb(settledGlyphColor('✦', 'running', palette))).toBe(secondary);
	});
});

describe('liveThinkingHeader (animated gear + dots BEFORE the timer)', () => {
	test('gear alternates ⚙ ↔ ✦ across frames', () => {
		for (let frame = 0; frame < 8; frame++) {
			const header = liveThinkingHeader(frame, 0);
			expect(header.startsWith(frame % 8 < 4 ? '⚙' : '✦')).toBe(true);
		}
	});

	test('dots sit BEFORE the real-time timer and animate 1→2→3', () => {
		const headers = [0, 4, 8].map(frame => liveThinkingHeader(frame, 5));
		const [one, two, three] = headers;
		expect(one!).toContain('Thinking . (5s)');
		expect(two!).toContain('Thinking .. (5s)');
		expect(three!).toContain('Thinking ... (5s)');
		// The timer NEVER appears before the dots.
		expect(one!.indexOf('(5s)')).toBeGreaterThan(
			one!.indexOf('Thinking .'),
		);
	});

	test('timer formats real durations (1m 2s, not 62s)', () => {
		expect(liveThinkingHeader(0, 62)).toContain('(1m 2s)');
		expect(liveThinkingHeader(0, 3723)).toContain('(1h 2m 3s)');
	});
});

describe('thinkingSeconds (settled Thought (Ns) duration)', () => {
	test('rounds to whole seconds and never reports 0', () => {
		expect(thinkingSeconds(1000, 5000)).toBe(4);
		expect(thinkingSeconds(1000, 1999)).toBe(1);
		expect(thinkingSeconds(1000, 1200)).toBe(1);
		expect(thinkingSeconds(0, 0)).toBe(1);
	});
});

describe('wrapThoughtBody (tool-style `  └   ` container)', () => {
	test('short text gets the `  └   ` lead and no continuations', () => {
		expect(wrapThoughtBody('short thought', 60)).toBe(
			'  └   short thought',
		);
	});

	test('long lines wrap with 6-space continuations inside the width', () => {
		const result = wrapThoughtBody(
			'one two three four five six seven eight nine',
			20,
		);
		const lines = result.split('\n');
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]!.startsWith('  └   ')).toBe(true);
		for (const line of lines.slice(1)) {
			expect(line.startsWith('      ')).toBe(true);
		}
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(20);
		}
		const content = lines
			.map(line => line.replace(/^\s+/, ''))
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
		expect(content).toContain('one two three four five six seven');
	});

	test('explicit newlines become 6-space continuations', () => {
		expect(wrapThoughtBody('first line\nsecond line', 60)).toBe(
			'  └   first line\n      second line',
		);
	});

	test('empty text returns an empty body', () => {
		expect(wrapThoughtBody('', 60)).toBe('');
		expect(wrapThoughtBody('   ', 60)).toBe('');
	});

	test('narrow widths stay safe (content width never drops below 1)', () => {
		const result = wrapThoughtBody('abcdefghijklmnopqrstuvwxyz', 8);
		expect(result.split('\n').every(line => line.length >= 1)).toBe(true);
	});
});
