import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import type {PendingWorkItem} from './background-notification';
import {dequeuePendingWork} from './background-notification';
import {
	canDeliverQueuedSteering,
	deliverQueuedSteering,
	steeringSnapshot,
} from './queued-steering';

// Execute the application's scheduling conditions, not a copy of the bug/fix.
// A bounded fake provider makes a runaway final-response loop deterministic.
const appSource = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
const deliveryCondition = appSource.match(
	/if \(([^\n]+)\) await deliverPendingPrompts\(\);/,
)![1]!;
const continuationCondition = appSource
	.slice(appSource.indexOf('if (result.toolCalls.length === 0) {'))
	.match(/if \(result.toolCalls.length === 0\) \{\s*if \(([\s\S]*?)\) \{/)![1]!;

async function runSteeringLoop(options: {
	taskTurn?: boolean;
	detachedWorkStarted?: boolean;
	lateArrival?: boolean;
}) {
	const item = {value: 'queued chat'};
	let queue: PendingWorkItem[] = options.lateArrival ? [] : [item];
	const delivered: PendingWorkItem[] = [];
	const idleDispatched: PendingWorkItem[] = [];
	const taskTurn = options.taskTurn ?? false;
	const detachedWorkStarted = options.detachedWorkStarted ?? false;
	const canDeliverPendingPrompts = () =>
		canDeliverQueuedSteering({taskTurn, detachedWorkStarted, aborted: false});
	const evaluate = (condition: string): boolean =>
		new Function(
			'taskTurn',
			'canDeliverPendingPrompts',
			'steeringSnapshot',
			'pendingQueue',
			`return (${condition});`,
		)(taskTurn, canDeliverPendingPrompts, steeringSnapshot, () => queue);
	let providerCalls = 0;
	for (; providerCalls < 4;) {
		if (evaluate(deliveryCondition)) {
			await deliverQueuedSteering(
				queue,
				async pending => {
					if (!canDeliverPendingPrompts()) return false;
					delivered.push(pending);
					return true;
				},
				pending => {
					queue = queue.filter(candidate => candidate !== pending);
				},
			);
		}
		providerCalls += 1;
		// The provider yields a text-only final answer. Chat may arrive mid-stream.
		if (options.lateArrival && providerCalls === 1) queue.push(item);
		if (evaluate(continuationCondition)) continue;
		const next = dequeuePendingWork(queue, {currentWorkReady: true});
		if (next.item) idleDispatched.push(next.item);
		queue = next.remaining;
		break;
	}
	return {providerCalls, delivered, idleDispatched, queue};
}

describe('text-only turn scheduling with queued steering', () => {
	test('application delivery checks shared eligibility before and after preparation', () => {
		const delivery = appSource.slice(
			appSource.indexOf('const canDeliverPendingPrompts'),
			appSource.indexOf('// B15: preflight'),
		);
		expect(delivery).toContain('canDeliverQueuedSteering({');
		expect(delivery).toContain('taskTurn,');
		expect(delivery).toContain('detachedWorkStarted,');
		expect(delivery).toContain('aborted: controller.signal.aborted');
		expect(
			delivery.match(/if \(!canDeliverPendingPrompts\(\)\) return false;/g),
		).toHaveLength(2);
	});
	test('aborted turns cannot consume steering', () => {
		expect(
			canDeliverQueuedSteering({
				taskTurn: false,
				detachedWorkStarted: false,
				aborted: true,
			}),
		).toBe(false);
	});
	for (const state of [{taskTurn: true}, {detachedWorkStarted: true}]) {
		for (const lateArrival of [false, true]) {
			test(`ineligible chat reaches idle dispatcher: ${JSON.stringify({...state, lateArrival})}`, async () => {
				const result = await runSteeringLoop({...state, lateArrival});
				expect(result.providerCalls).toBe(1);
				expect(result.delivered).toEqual([]);
				expect(result.idleDispatched).toEqual([{value: 'queued chat'}]);
				expect(result.queue).toEqual([]);
			});
		}
	}
	for (const lateArrival of [false, true]) {
		test(`eligible chat is delivered once: lateArrival=${lateArrival}`, async () => {
			const result = await runSteeringLoop({lateArrival});
			expect(result.providerCalls).toBe(lateArrival ? 2 : 1);
			expect(result.delivered).toEqual([{value: 'queued chat'}]);
			expect(result.idleDispatched).toEqual([]);
			expect(result.queue).toEqual([]);
		});
	}
});

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
