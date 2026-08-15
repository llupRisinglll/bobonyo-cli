import {describe, expect, test} from 'bun:test';
import {historyFillWidth, toolRowFillWidth} from './history-width';
describe('historyFillWidth', () => {
	test('reserves root padding (2) + right gap (2) + scrollbar (1)', () => {
		expect(historyFillWidth(110)).toBe(105);
		expect(historyFillWidth(80)).toBe(75);
		expect(historyFillWidth(70)).toBe(65);
	});
	test('never collapses below one column', () => {
		expect(historyFillWidth(1)).toBe(1);
		expect(historyFillWidth(0)).toBe(1);
	});
});
describe('toolRowFillWidth', () => {
	test('briefed file rows shrink the fill by the 2-wide brief indent', () => {
		// FileToolRow prepends a 2-col indent box per body row when the entry
		// carries a brief; the fill must shrink by 2 or the padded row is
		// `fill + 2` cells wide and the TERMINAL wraps a phantom line after
		// every diff row (the "blank line between diff rows" bug — invisible
		// to the OpenTUI test renderer because it clips, not wraps).
		expect(toolRowFillWidth(122, 'I will check X')).toBe(
			historyFillWidth(122) - 2,
		);
		expect(toolRowFillWidth(110, 'brief')).toBe(historyFillWidth(110) - 2);
	});
	test("batch marker brief (`' '`) shrinks the fill too", () => {
		// The ' ' batch marker also renders the indent box (batchBriefed).
		expect(toolRowFillWidth(100, ' ')).toBe(historyFillWidth(100) - 2);
	});
	test('no brief keeps the full fill', () => {
		expect(toolRowFillWidth(122, undefined)).toBe(historyFillWidth(122));
		expect(toolRowFillWidth(122, '')).toBe(historyFillWidth(122));
	});
	test('never collapses below one column', () => {
		expect(toolRowFillWidth(3, 'brief')).toBe(1);
	});
});
