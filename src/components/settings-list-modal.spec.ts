import {describe, expect, test} from 'bun:test';
import {listScrollStart} from './settings-list-modal';

describe('listScrollStart', () => {
	test('stays at the top while the selection fits', () => {
		expect(listScrollStart(0, 3, 10)).toBe(0);
		expect(listScrollStart(3, 3, 10)).toBe(0);
	});

	test('scrolls once the selection leaves the window', () => {
		expect(listScrollStart(7, 20, 10)).toBe(7);
		expect(listScrollStart(19, 20, 10)).toBe(10);
	});

	test('clamps to the last window for oversized indexes', () => {
		expect(listScrollStart(99, 20, 10)).toBe(10);
	});
});
