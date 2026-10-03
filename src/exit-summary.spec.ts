import {describe, expect, test} from 'bun:test';
import {
	buildExitSummary,
	flushExitSummary,
	rendererExitSummaryOptions,
	queueExitSummary,
	takeExitSummary,
} from './exit-summary';

describe('exit summary', () => {
	test('builds resume instructions for persisted conversations', () => {
		const summary = buildExitSummary({
			banner: 'BANNER',
			hasConversation: true,
			sessionName: 'Demo',
			createdAt: Date.UTC(2026, 9, 3, 22, 0, 0),
			sessionId: 'sess_demo_1',
		});
		expect(summary).toContain('BANNER');
		expect(summary).toContain('Session   Demo - 2026-10-03T22:00:00.000Z');
		expect(summary).toContain('Continue  bobonyo --resume sess_demo_1');
	});

	test('flushes queued summary exactly once after renderer teardown', () => {
		queueExitSummary('goodbye');
		const writes: string[] = [];
		flushExitSummary(text => writes.push(text));
		flushExitSummary(text => writes.push(text));
		expect(writes).toEqual(['goodbye']);
		expect(takeExitSummary()).toBe('');
	});

	test('renderer options keep shutdown from clearing final summary', () => {
		const options = rendererExitSummaryOptions();
		expect(options.clearOnShutdown).toBe(false);
		expect(typeof options.onDestroy).toBe('function');
	});
});
