import {describe, expect, test} from 'bun:test';
import {formatCount, formatDuration} from './format';

describe('formatCount (number shortcuts)', () => {
	test('small counts stay exact', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(9)).toBe('9');
		expect(formatCount(999)).toBe('999');
	});

	test('thousands truncate to one decimal instead of rounding up', () => {
		expect(formatCount(7995)).toBe('7.9K');
		expect(formatCount(482_000)).toBe('482K');
		expect(formatCount(1_999)).toBe('1.9K');
	});

	test('millions use up to two decimals', () => {
		expect(formatCount(1_240_000)).toBe('1.24M');
		expect(formatCount(12_400_000)).toBe('12.4M');
		expect(formatCount(1_000_000)).toBe('1M');
	});
});

describe('formatDuration (ms below a second, 2dp seconds above)', () => {
	test('sub-second durations render as milliseconds', () => {
		expect(formatDuration(0.2)).toBe('200ms');
		expect(formatDuration(0.987)).toBe('987ms');
		expect(formatDuration(0)).toBe('0ms');
	});

	test('second-scale durations keep two decimals, trailing zeros trimmed', () => {
		expect(formatDuration(1.98)).toBe('1.98s');
		expect(formatDuration(1.9)).toBe('1.9s');
		expect(formatDuration(12)).toBe('12s');
	});
});
