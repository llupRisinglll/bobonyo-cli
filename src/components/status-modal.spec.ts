import {expect, test} from 'bun:test';
import {statusCardY} from './status-modal';

test('status modal recenters when async content changes height', () => {
	expect(statusCardY(40, 12)).toBe(14);
	expect(statusCardY(40, 20)).toBe(10);
});

test('status modal never moves above tiny viewport', () => {
	expect(statusCardY(8, 20)).toBe(1);
});
