import {afterEach, describe, expect, mock, test} from 'bun:test';
import {createDebouncedFlush} from './debounced-flush';

afterEach(() => mock.restore());

describe('createDebouncedFlush', () => {
	test('coalesces progress bursts and flushes immediately on settlement', () => {
		const callback = mock(() => {});
		const scheduled: Array<() => void> = [];
		mock.module('node:timers', () => ({}));
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((handler: () => void) => {
			scheduled.push(handler);
			return scheduled.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
		try {
			const flush = createDebouncedFlush(callback, 750);
			flush.schedule();
			flush.schedule();
			flush.schedule();
			expect(scheduled).toHaveLength(1);
			expect(callback).toHaveBeenCalledTimes(0);
			flush.flush();
			expect(callback).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});
});
