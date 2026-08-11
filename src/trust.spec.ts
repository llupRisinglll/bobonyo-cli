import {describe, expect, test} from 'bun:test';
import {trustDecision} from './trust';

describe('trustDecision', () => {
	test('explicit y (any case, trimmed) trusts the directory', () => {
		expect(trustDecision('y')).toBe('trust');
		expect(trustDecision('Y')).toBe('trust');
		expect(trustDecision('  y  ')).toBe('trust');
	});

	test('anything else, including an unanswered/empty prompt, exits', () => {
		expect(trustDecision('')).toBe('exit');
		expect(trustDecision('n')).toBe('exit');
		expect(trustDecision('yes')).toBe('exit');
		expect(trustDecision('hello')).toBe('exit');
	});
});
