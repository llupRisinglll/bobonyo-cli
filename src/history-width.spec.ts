import {describe, expect, test} from 'bun:test';
import {historyFillWidth} from './history-width';

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
