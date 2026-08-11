import {describe, expect, test} from 'bun:test';
import {glyphBlinkOn} from './state';

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
