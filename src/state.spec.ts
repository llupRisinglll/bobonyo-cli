import {describe, expect, test} from 'bun:test';
import {
	glyphBlinkOn,
	loadingDots,
	reasoning,
	settleThinkingPhase,
	setReasoning,
	setThinkingElapsed,
	thinkingElapsed,
} from './state';

describe('glyphBlinkOn', () => {
	test('blinks on a 500ms cadence (4 frames per 100ms tick)', () => {
		// Frames 0-3 (0-300ms) visible, 4-7 (400-700ms) hidden, 8+ visible.
		expect(glyphBlinkOn(0)).toBe(true);
		expect(glyphBlinkOn(2)).toBe(true);
		expect(glyphBlinkOn(3)).toBe(true);
		expect(glyphBlinkOn(4)).toBe(false);
		expect(glyphBlinkOn(6)).toBe(false);
		expect(glyphBlinkOn(7)).toBe(false);
		expect(glyphBlinkOn(8)).toBe(true);
	});
});

describe('loadingDots', () => {
	test('cycles 1→2→3 every 200ms', () => {
		expect(loadingDots(0)).toBe('.');
		expect(loadingDots(1)).toBe('.');
		expect(loadingDots(2)).toBe('..');
		expect(loadingDots(3)).toBe('..');
		expect(loadingDots(4)).toBe('...');
		expect(loadingDots(5)).toBe('...');
		expect(loadingDots(6)).toBe('.');
	});
});

describe('settleThinkingPhase (the live Thinking block must not hang above tools)', () => {
	test('clears the live reasoning signal and the ticking timer', () => {
		setReasoning('a streamed thought in progress');
		setThinkingElapsed(7);
		settleThinkingPhase();
		expect(reasoning()).toBe('');
		expect(thinkingElapsed()).toBe(0);
	});
});
