import {describe, expect, test} from 'bun:test';
import {hitTestBlock} from './components/history';

describe('hitTestBlock (hover/click row mapping)', () => {
	const entry = (overrides: {
		start?: number;
		rows?: number;
		screenY?: number;
		height?: number;
	}) => ({
		ref: {
			screenY: overrides.screenY ?? 10,
			...(overrides.height !== undefined ? {height: overrides.height} : {}),
		},
		start: overrides.start ?? 4,
		rows: overrides.rows ?? 6,
	});

	test('normal blocks map rows 1:1 within the span', () => {
		const e = entry({start: 4, rows: 6, screenY: 10, height: 6});
		expect(hitTestBlock(e, 10)).toBe(4);
		expect(hitTestBlock(e, 12)).toBe(6);
		expect(hitTestBlock(e, 15)).toBe(9);
		// One past the block (next block's top) is NOT this block's row.
		expect(hitTestBlock(e, 16)).toBeNull();
	});

	test('a briefed block (height > doc rows) clamps extra rows into the block', () => {
		// The pre-tool brief adds one rendered row absent from docLines:
		// actual height 7, doc span 6. The bottom border row (y = top+6)
		// must resolve to the block's LAST doc row, never spill to null or
		// the next block.
		const e = entry({start: 4, rows: 6, screenY: 10, height: 7});
		expect(hitTestBlock(e, 10 + 6)).toBe(4 + 5);
		expect(hitTestBlock(e, 10 + 5)).toBe(4 + 5);
	});

	test('bash borders (height = rows + 2) also stay inside the block', () => {
		const e = entry({start: 0, rows: 4, screenY: 20, height: 6});
		expect(hitTestBlock(e, 20 + 5)).toBe(3);
		expect(hitTestBlock(e, 20 + 6)).toBeNull();
	});

	test('no ref / outside the block returns null', () => {
		expect(hitTestBlock({ref: null, start: 0, rows: 4}, 5)).toBeNull();
		const e = entry({screenY: 10, height: 6});
		expect(hitTestBlock(e, 9)).toBeNull();
		expect(hitTestBlock(e, 16)).toBeNull();
	});
});
