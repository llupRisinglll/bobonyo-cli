import {describe, expect, test} from 'bun:test';
import {
	MAX_BASH_OUTPUT_CHARS,
	MAX_BASH_OUTPUT_LINES,
	capOutputTail,
} from './bash';

describe('capOutputTail (bash output capture caps)', () => {
	test('keeps output unchanged when it fits within both caps', () => {
		const {lines, truncated} = capOutputTail(['a', 'b', 'c']);
		expect(lines).toEqual(['a', 'b', 'c']);
		expect(truncated).toBe(false);
	});

	test('keeps the TAIL when the line cap is exceeded', () => {
		const lines = Array.from({length: MAX_BASH_OUTPUT_LINES + 10}, (_, i) =>
			`line ${i}`,
		);
		const {lines: capped, truncated} = capOutputTail(lines);
		expect(truncated).toBe(true);
		expect(capped.length).toBe(MAX_BASH_OUTPUT_LINES);
		// Results/errors are at the end, so the tail must survive.
		expect(capped.at(-1)).toBe(`line ${MAX_BASH_OUTPUT_LINES + 9}`);
		expect(capped.at(0)).toBe('line 10');
	});

	test('a single giant line (minified one-line file) is sliced to the char cap', () => {
		const giant = 'x'.repeat(MAX_BASH_OUTPUT_CHARS * 4);
		const {lines, truncated} = capOutputTail([giant]);
		expect(truncated).toBe(true);
		expect(lines.length).toBe(1);
		// The TAIL of the line survives (with a leading `…` marker).
		expect(lines[0]!.startsWith('…')).toBe(true);
		expect(lines[0]!.endsWith('x'.repeat(MAX_BASH_OUTPUT_CHARS))).toBe(true);
	});

	test('later lines push earlier ones out of both caps together', () => {
		// 3 lines of 40 chars each with a 100-char cap: the last two fit
		// fully, the first is sliced to the remaining budget.
		const lines = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
		const {lines: capped, truncated} = capOutputTail(lines, 10, 100);
		expect(truncated).toBe(true);
		// The first line is sliced to the remaining 19-char budget, with a
		// `…` marker so the truncation is visible.
		expect(capped[0]!.startsWith('…')).toBe(true);
		expect(capped[0]!.slice(1)).toBe('a'.repeat(19));
		expect(capped.slice(1)).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
	});
});
