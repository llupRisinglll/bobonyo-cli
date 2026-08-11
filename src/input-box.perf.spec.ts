import {describe, expect, test} from 'bun:test';
import {
	cursorPositionFromWrapped,
	tokenizeInputLine,
	wrapText,
	wrapTextDetailed,
} from './components/input-box';

/**
 * Input hot-path benchmarks. The user-input render runs per FRAME while
 * typing: wrap the value, locate the caret, tokenize every line (attachment
 * blocks + known commands). These specs simulate typing speed, a large
 * multiline buffer, and a busy frame so a regression (e.g. re-wrapping per
 * helper, O(n²) tokenization) fails loudly instead of "feeling" slow.
 *
 * Bounds are deliberately LOOSE (they catch quadratic/blocking regressions,
 * not micro-jitter) so the suite stays green on slow CI machines.
 */

const KNOWN = new Set<string>(['status', 'clear', 'help', 'exit', 'mock:compact10']);

function frameCost(text: string, cursor: number, width: number): number {
	const started = performance.now();
	const wrapped = wrapTextDetailed(text, width);
	cursorPositionFromWrapped(wrapped, cursor);
	for (const line of wrapped) tokenizeInputLine(line.text, KNOWN);
	return performance.now() - started;
}

describe('input hot path (typing speed)', () => {
	test('typing a 300-char message stays smooth (one frame per keystroke)', () => {
		let input = '';
		let cursor = 0;
		const started = performance.now();
		for (let i = 0; i < 300; i++) {
			// One "keystroke": insert a char at the caret, then render a frame.
			const ch = i % 2 === 0 ? 'a' : ' ';
			input = input.slice(0, cursor) + ch + input.slice(cursor);
			cursor += 1;
			frameCost(input, cursor, 96);
		}
		const elapsed = performance.now() - started;
		// 300 frames in < 300ms = well under the 16ms/frame budget.
		expect(elapsed).toBeLessThan(300);
	});

	test('typing a message with /commands and attachments tokenizes per frame', () => {
		let input = '';
		const started = performance.now();
		const words = [
			'/status',
			'see',
			'/clear',
			'[Image #1]',
			'/mock:compact10',
			'after',
			'/not-a-command',
		];
		for (let i = 0; i < 120; i++) {
			input += ` ${words[i % words.length] ?? ''}`;
			frameCost(input, input.length, 96);
		}
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(300);
	});
});

describe('input hot path (large buffers)', () => {
	test('a 200-line multiline frame renders under budget', () => {
		const lines = Array.from(
			{length: 200},
			(_, i) =>
				`line ${i} with some words ${'word '.repeat(20)} /status`,
		);
		const text = lines.join('\n');
		expect(wrapText(text, 96).length).toBeGreaterThan(250);
		const elapsed = frameCost(text, text.length, 96);
		expect(elapsed).toBeLessThan(25);
	});

	test('cost stays near-linear for very long input (no O(n²) tokenizer)', () => {
		const small = 'alpha beta gamma /status delta '.repeat(400); // ~12KB
		const large = 'alpha beta gamma /status delta '.repeat(1600); // ~48KB
		const smallMs = frameCost(small, small.length, 96);
		const largeMs = frameCost(large, large.length, 96);
		// 4× the input must not cost 4×+slack AND blow the frame budget.
		expect(largeMs).toBeLessThan(60);
		expect(largeMs).toBeLessThan(smallMs * 6 + 10);
	});
});

describe('input hot path (simultaneous busy rendering)', () => {
	test('a busy frame (wrap + caret + tokenize + history scan) stays fast', () => {
		const text = 'while busy the model streams a reply\nand /status still colors\n';
		const started = performance.now();
		for (let frame = 0; frame < 120; frame++) {
			const growing = text + `frame ${frame} data `.repeat(2);
			frameCost(growing, growing.length, 96);
			// Simulate the completion/history scans the same frame performs.
			wrapText(growing, 96);
		}
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(300);
	});
});
