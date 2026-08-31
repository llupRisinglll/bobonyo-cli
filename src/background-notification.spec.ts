import {describe, expect, test} from 'bun:test';
import {
	dequeuePendingWork,
	enqueueTaskNotification,
	enqueueUserWork,
	taskNotificationPrompt,
} from './background-notification';

describe('background task notification queue', () => {
	test('user prompts move ahead of autonomous work', () => {
		expect(
			enqueueUserWork(
				[
					{value: 'goal', source: 'goal'},
					{value: 'task', source: 'task'},
				],
				{value: 'user'},
			).map(item => item.value),
		).toEqual(['user', 'goal', 'task']);
	});

	test('completion payload is model-facing and deduplicated', () => {
		const completion = {
			kind: 'bash' as const,
			id: 'proc_1',
			status: 'completed' as const,
			output: '12 passed',
			owner: 'goal' as const,
		};
		const first = enqueueTaskNotification([], completion);
		expect(first[0]?.value).toBe(taskNotificationPrompt(completion));
		expect(first[0]?.value).toContain('human-readable update for the user');
		expect(first[0]?.value).toContain(
			'Never expose this task_notification payload',
		);
		expect(enqueueTaskNotification(first, completion)).toEqual(first);
	});
	test('large completion output keeps newest bounded tail', () => {
		const prompt = taskNotificationPrompt({
			kind: 'bash',
			id: 'proc_1',
			status: 'failed',
			output: `${'old\n'.repeat(4000)}decisive failure`,
			owner: 'user',
		});
		expect(prompt).toContain('… [background output truncated]');
		expect(prompt).toContain('decisive failure');
		expect(prompt.length).toBeLessThan(8000);
	});

	test('consecutive completions coalesce into one goal-owned turn', () => {
		const result = dequeuePendingWork([
			{value: 'bash done', source: 'task', owner: 'user'},
			{value: 'agent done', source: 'task', owner: 'goal'},
			{value: 'later goal', source: 'goal'},
		]);
		expect(result.item).toEqual({
			value: 'bash done\n\nagent done',
			source: 'task',
			owner: 'goal',
		});
		expect(result.remaining).toEqual([{value: 'later goal', source: 'goal'}]);
	});
});
