import {describe, expect, test} from 'bun:test';
import {MIN_TOOL_RUNNING_MS, toolRunningRemainingMs} from './app';

describe('toolRunningRemainingMs (min visible running floor)', () => {
	test('fast tool calls still owe the rest of the floor', () => {
		// An MCP stdio round trip can be ~1ms while OpenTUI frames at
		// ~16ms — without the floor the row settles before the next paint
		// and the grey running glyph is never seen.
		const startedAt = 1_000;
		const executedAt = 1_001;
		expect(toolRunningRemainingMs(startedAt, executedAt)).toBe(
			MIN_TOOL_RUNNING_MS - 1,
		);
	});

	test('returns 0 once the floor has elapsed', () => {
		const startedAt = 1_000;
		const executedAt = startedAt + MIN_TOOL_RUNNING_MS + 500;
		expect(toolRunningRemainingMs(startedAt, executedAt)).toBe(0);
	});

	test('a custom floor is honored', () => {
		expect(toolRunningRemainingMs(1_000, 1_100, 250)).toBe(150);
	});
});
