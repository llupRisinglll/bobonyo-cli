import {describe, expect, test} from 'bun:test';
import {historyFillWidth} from './history-width';

describe('historyFillWidth', () => {
	test('reserves the root padding (2) + scrollbar column (1)', () => {
		expect(historyFillWidth(110)).toBe(107);
		expect(historyFillWidth(80)).toBe(77);
		expect(historyFillWidth(70)).toBe(67);
	});

	test('never collapses below one column', () => {
		expect(historyFillWidth(1)).toBe(1);
		expect(historyFillWidth(0)).toBe(1);
	});
});
