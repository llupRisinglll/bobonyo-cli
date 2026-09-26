import {describe, expect, test} from 'bun:test';
import type {PendingWorkItem} from './background-notification';
import {deliverQueuedSteering, steeringSnapshot} from './queued-steering';

describe('queued provider-boundary steering', () => {
	test('deferred follow-ups form a steering boundary even after their agents settle', () => {
		const first: PendingWorkItem = {value: 'now', delivery: 'steer'};
		const deferred: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
			waitForAgentIds: [],
		};
		expect(steeringSnapshot([first, deferred, {value: 'later still'}])).toEqual(
			[first],
		);
		expect(steeringSnapshot([deferred])).toEqual([]);
	});

	test('delivery never prepares or acknowledges deferred work', async () => {
		const first: PendingWorkItem = {value: 'now'};
		const deferred: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
		};
		let queue: PendingWorkItem[] = [first, deferred];
		const delivered: PendingWorkItem[] = [];
		await deliverQueuedSteering(
			queue,
			async item => {
				delivered.push(item);
				return true;
			},
			item => {
				queue = queue.filter(candidate => candidate !== item);
			},
		);
		expect(delivered).toEqual([first]);
		expect(queue).toEqual([deferred]);
	});

	test('delivers FIFO snapshots after the full tool batch, before the next provider call', async () => {
		const first = {
			value: 'first [Image #1]',
			attachments: {'1': '/saved/a.png'},
		};
		const second = {value: 'second'};
		const later = {value: 'arrived during preparation'};
		let queue: PendingWorkItem[] = [first, second];
		const history = ['assistant tool_calls: a,b'];
		const delivered: PendingWorkItem[] = [];
		let release!: () => void;
		const toolBatch = new Promise<void>(resolve => {
			release = resolve;
		});
		const nextRound = (async () => {
			await toolBatch;
			history.push('tool a', 'tool b');
			await deliverQueuedSteering(
				queue,
				async item => {
					if (item === first) queue = [...queue, later];
					await Promise.resolve();
					delivered.push(item);
					history.push(item.value);
					return true;
				},
				item => {
					queue = queue.filter(candidate => candidate !== item);
				},
			);
			history.push('provider');
		})();
		await Promise.resolve();
		expect(delivered).toEqual([]);
		release();
		await nextRound;
		expect(history).toEqual([
			'assistant tool_calls: a,b',
			'tool a',
			'tool b',
			first.value,
			second.value,
			'provider',
		]);
		expect(delivered[0]?.attachments).toEqual({'1': '/saved/a.png'});
		expect(queue).toEqual([later]);
	});

	test('commands and all system sources stay with the idle dispatcher', () => {
		for (const barrier of [
			{value: '/compact'},
			{value: '!pwd'},
			{
				value: 'body',
				command: {kind: 'skill' as const, name: 'x', body: 'body'},
			},
			...(['goal', 'loop', 'task'] as const).map(source => ({
				value: 'event',
				source,
			})),
		]) {
			expect(
				steeringSnapshot([{value: 'chat'}, barrier, {value: 'later'}]),
			).toEqual([{value: 'chat'}]);
		}
	});

	test('interruption keeps undelivered items, even identical prompts', async () => {
		const first = {value: 'same'};
		const second = {value: 'same'};
		let queue = [first, second];
		await deliverQueuedSteering(
			queue,
			async item => item === first,
			item => {
				queue = queue.filter(candidate => candidate !== item);
			},
		);
		expect(queue).toEqual([second]);
		expect(queue[0]).toBe(second);
	});

	test('preparation failure never acknowledges the failed item or later work', async () => {
		const queue = [{value: 'failed'}, {value: 'later'}];
		const acknowledged: PendingWorkItem[] = [];
		await expect(
			deliverQueuedSteering(
				queue,
				async () => {
					throw new Error('preparation failed');
				},
				item => {
					acknowledged.push(item);
				},
			),
		).rejects.toThrow('preparation failed');
		expect(acknowledged).toEqual([]);
	});
});
