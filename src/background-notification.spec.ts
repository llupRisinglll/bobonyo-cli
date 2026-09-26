import {describe, expect, test} from 'bun:test';
import {
	backgroundWaitingMessage,
	elapsedSinceOldest,
	dequeuePendingWork,
	enqueueTaskNotification,
	invalidateGoalContinuations,
	enqueueUserWork,
	shouldReleaseDetachedAgentBatch,
	shouldProcessDetachedCompletion,
	taskNotificationPrompt,
	isTaskNotification,
	classifyPendingWorkDelivery,
	type PendingWorkItem,
} from './background-notification';
import {normalizeGoal, reviseGoal, goalOwnerFromGraphId} from './goal-loop';
describe('goal continuation revisions', () => {
	test('edit, replacement and clear remove old prompts but retain result graphs', () => {
		const goal = normalizeGoal({
			objective: 'old',
			status: 'active',
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		});
		const goalOwner = goalOwnerFromGraphId(goal.graphId)!;
		const continuation: PendingWorkItem = {
			value: 'continue old',
			source: 'goal',
			graphId: goal.graphId,
			goalOwner,
		};
		const queue = enqueueTaskNotification([continuation], {
			kind: 'agent',
			id: 'old-agent',
			status: 'completed',
			output: 'old output',
			owner: 'goal',
			graphId: goal.graphId,
			goalOwner,
		});
		expect(invalidateGoalContinuations(queue, goal)).toEqual(queue);
		for (const next of [
			reviseGoal(goal, 'edited'),
			normalizeGoal({...goal, id: undefined}),
			undefined,
		]) {
			const retained = invalidateGoalContinuations(queue, next);
			expect(retained).toHaveLength(1);
			expect(retained[0]).toMatchObject({
				source: 'task',
				graphId: goal.graphId,
				goalOwner,
			});
			expect(dequeuePendingWork(retained).item?.goalOwner).toEqual(goalOwner);
		}
	});
	test('notifications with different goal revisions never coalesce', () => {
		const first: PendingWorkItem = {
			value: 'one',
			source: 'task',
			owner: 'goal',
			graphId: 'shared',
			goalOwner: {id: 'goal', revision: 1, graphId: 'shared'},
		};
		const second = {
			...first,
			value: 'two',
			goalOwner: {...first.goalOwner!, revision: 2},
		};
		const result = dequeuePendingWork([first, second]);
		expect(result.item).toEqual(first);
		expect(result.remaining).toEqual([second]);
	});
});

describe('background task notification queue', () => {
	test('classifies only explicit current-work sequencing', () => {
		for (const value of [
			'after current subagent tasks',
			'After current subagent tasks, fix the tests.',
			'please also fix this after we fix this current problem',
			'once current task finishes',
			'When the current task is done, update docs.',
			'Fix this after you resolve our current issue.',
		]) {
			expect(classifyPendingWorkDelivery(value)).toBe('after-current');
		}
		for (const value of [
			'Fix the error after login.',
			'Run tests after editing the file.',
			'The current task fails after a timeout.',
			'Explain what happens after current task creation.',
			'Fix this current problem now.',
			'once upon a time',
		]) {
			expect(classifyPendingWorkDelivery(value)).toBe('steer');
		}
	});

	test('explicit follow-ups keep metadata and do not outrank current work', () => {
		const current: PendingWorkItem = {value: 'goal', source: 'goal'};
		const followup: PendingWorkItem = {
			value: 'Fix this after current subagent tasks',
			delivery: 'after-current',
			attachments: {'1': '/saved/a.png'},
			waitForAgentIds: ['agent-a'],
		};
		const queue = enqueueUserWork([current], followup);
		expect(queue).toEqual([current, followup]);
		expect(queue[1]).toBe(followup);
		expect(queue[1]?.attachments).toBe(followup.attachments);
		expect(
			enqueueUserWork(queue, {value: 'urgent'}).map(item => item.value),
		).toEqual(['urgent', 'goal', followup.value]);
		expect(enqueueUserWork([queue[1]!], {value: 'urgent'})[0]?.value).toBe(
			'urgent',
		);
	});

	test('natural-language sequencing never implicitly defers user work', () => {
		const current: PendingWorkItem = {value: 'goal', source: 'goal'};
		for (const value of [
			'after current subagent tasks',
			'When the current task is done, update docs.',
			'Fix this after you resolve our current issue.',
		]) {
			const item: PendingWorkItem = {
				value,
				graphId: 'graph-b',
				owner: 'user',
				attachments: {'1': '/saved/a.png'},
				waitForAgentIds: ['agent-a'],
			};
			const queue = enqueueUserWork([current], item);
			expect(queue).toEqual([item, current]);
			expect(queue[0]).toBe(item);
			expect(item.delivery).toBeUndefined();
		}
	});

	test('explicit delivery and commands retain dispatch semantics', () => {
		for (const item of [
			{value: 'after current subagent tasks', delivery: 'steer' as const},
			{value: '/custom after current subagent tasks'},
			{value: '!echo after current subagent tasks'},
			{
				value: 'after current subagent tasks',
				command: {kind: 'skill' as const, name: 'custom', body: 'body'},
			},
		]) {
			expect(enqueueUserWork([{value: 'task', source: 'task'}], item)[0]).toBe(
				item,
			);
		}
		const explicit: PendingWorkItem = {
			value: 'fix it',
			delivery: 'after-current',
		};
		expect(
			enqueueUserWork([{value: 'goal', source: 'goal'}], explicit)[1],
		).toBe(explicit);
	});

	test('blocked follow-ups allow current-work continuations and completions through', () => {
		const deferred: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
			waitForAgentIds: ['agent-a'],
		};
		const queue: PendingWorkItem[] = [
			deferred,
			{value: 'goal', source: 'goal'},
			{value: 'done', source: 'task', graphId: 'graph-b'},
		];
		const readiness = {
			activeAgentRuns: [{id: 'agent-a', graphId: 'graph-a', status: 'running'}],
			currentWorkReady: false,
		};
		const first = dequeuePendingWork(queue, readiness);
		expect(first.item).toBe(queue[1]);
		const second = dequeuePendingWork(first.remaining, readiness);
		expect(second.item?.source).toBe('task');
		expect(second.remaining).toEqual([deferred]);
		expect(dequeuePendingWork(second.remaining, readiness)).toEqual({
			remaining: [deferred],
		});
		expect(queue).toHaveLength(3);
	});
	test('A1 completion waits for A2 while a later user prompt B delivers', () => {
		const notification = enqueueTaskNotification([], {
			kind: 'agent',
			id: 'A1',
			status: 'completed',
			output: 'A1 done',
			owner: 'user',
			graphId: 'graph-a',
		})[0]!;
		const prompt: PendingWorkItem = {
			value: 'B',
			owner: 'user',
			graphId: 'graph-b',
		};
		const runs = [
			{id: 'A1', graphId: 'graph-a', status: 'completed'},
			{id: 'A2', graphId: 'graph-a', status: 'running'},
		];
		const queue = [notification, prompt];
		const first = dequeuePendingWork(queue, {activeAgentRuns: runs});
		expect(first.item).toBe(prompt);
		expect(first.remaining).toEqual([notification]);
		expect(
			dequeuePendingWork(first.remaining, {activeAgentRuns: runs}),
		).toEqual({
			remaining: [notification],
		});
		const settled = dequeuePendingWork(first.remaining, {
			activeAgentRuns: runs.map(run => ({...run, status: 'completed'})),
		});
		expect(settled.item).toEqual(notification);
		expect(settled.remaining).toEqual([]);
		expect(queue).toEqual([notification, prompt]);
	});
	test('ready graph B notifications coalesce without releasing blocked graph A', () => {
		const task = (value: string, graphId: string): PendingWorkItem => ({
			value,
			graphId,
			owner: 'user',
			source: 'task',
		});
		const queue = [
			task('A1', 'graph-a'),
			task('B1', 'graph-b'),
			task('B2', 'graph-b'),
			task('C1', 'graph-c'),
		];
		const result = dequeuePendingWork(queue, {
			activeAgentRuns: [{id: 'A2', graphId: 'graph-a', status: 'running'}],
		});
		expect(result.item).toEqual({...queue[1], value: 'B1\n\nB2'});
		expect(result.remaining).toEqual([queue[0]!, queue[3]!]);
	});
	test('missing graph metadata preserves the safest global task barrier', () => {
		const scoped: PendingWorkItem = {
			value: 'done',
			source: 'task',
			graphId: 'graph-b',
		};
		const prompt: PendingWorkItem = {value: 'now'};
		for (const readiness of [
			{activeAgentIds: ['A2']},
			{activeAgentRuns: [{id: 'A2', status: 'running'}]},
			{
				activeAgentIds: ['unknown'],
				activeAgentRuns: [{id: 'A2', graphId: 'graph-a', status: 'running'}],
			},
		]) {
			const result = dequeuePendingWork([scoped, prompt], readiness);
			expect(result.item).toBe(prompt);
			expect(result.remaining).toEqual([scoped]);
		}
		const legacy: PendingWorkItem = {value: 'legacy', source: 'task'};
		expect(
			dequeuePendingWork([legacy], {
				activeAgentRuns: [{id: 'A2', graphId: 'graph-a', status: 'running'}],
			}).item,
		).toBeUndefined();
	});
	test('explicit deferred work cannot bypass blocked completion integration', () => {
		const deferred: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
			waitForAgentIds: [],
		};
		const blocked: PendingWorkItem = {
			value: 'A1',
			source: 'task',
			graphId: 'graph-a',
		};
		const ready: PendingWorkItem = {
			value: 'B1',
			source: 'task',
			graphId: 'graph-b',
		};
		const prompt: PendingWorkItem = {value: 'now'};
		const readiness = {
			activeAgentRuns: [{id: 'A2', graphId: 'graph-a', status: 'running'}],
		};
		const first = dequeuePendingWork(
			[deferred, blocked, ready, prompt],
			readiness,
		);
		expect(first.item).toEqual(ready);
		const second = dequeuePendingWork(first.remaining, readiness);
		expect(second.item).toBe(prompt);
		expect(
			dequeuePendingWork(second.remaining, readiness).item,
		).toBeUndefined();
		const settled = dequeuePendingWork(second.remaining, {activeAgentRuns: []});
		expect(settled.item).toEqual(blocked);
		expect(dequeuePendingWork(settled.remaining).item).toBe(deferred);
	});
	test('run snapshots also gate explicit deferred agent dependencies', () => {
		const deferred: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
			waitForAgentIds: ['A2'],
		};
		expect(
			dequeuePendingWork([deferred], {
				activeAgentRuns: [{id: 'A2', graphId: 'graph-a', status: 'running'}],
			}).item,
		).toBeUndefined();
		expect(
			dequeuePendingWork([deferred], {
				activeAgentRuns: [{id: 'A2', graphId: 'graph-a', status: 'cancelled'}],
			}).item,
		).toBe(deferred);
	});

	test('settled children still deliver all queued results before the follow-up', () => {
		const deferred: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
		};
		const secondDeferred: PendingWorkItem = {
			value: 'later still',
			delivery: 'after-current',
		};
		const queue: PendingWorkItem[] = [
			deferred,
			{value: 'first result', source: 'task', owner: 'user'},
			{value: 'second result', source: 'task', owner: 'goal'},
			secondDeferred,
			{value: 'third result', source: 'task', owner: 'loop'},
		];
		const first = dequeuePendingWork(queue, {
			activeAgentIds: [],
			currentWorkReady: true,
		});
		expect(first.item).toEqual({
			value: 'first result',
			source: 'task',
			owner: 'user',
		});
		expect(first.remaining).toEqual([deferred, ...queue.slice(2)]);
		const second = dequeuePendingWork(first.remaining);
		expect(second.item).toEqual(queue[2]);
		expect(second.remaining).toEqual([deferred, secondDeferred, queue[4]!]);
		const third = dequeuePendingWork(second.remaining);
		expect(third.item).toEqual(queue[4]);
		expect(third.remaining).toEqual([deferred, secondDeferred]);
		// The dispatcher keeps this false while the parent integrates results.
		expect(
			dequeuePendingWork(third.remaining, {currentWorkReady: false}).item,
		).toBeUndefined();
		const ready = dequeuePendingWork(third.remaining, {
			currentWorkReady: true,
		});
		expect(ready.item).toBe(deferred);
		expect(ready.remaining).toEqual([secondDeferred]);
	});

	test('dependencies and parent readiness gate only deferred work', () => {
		const deferred: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
			waitForAgentIds: ['agent-a'],
		};
		expect(
			dequeuePendingWork([deferred], {activeAgentIds: ['agent-a']}).item,
		).toBeUndefined();
		expect(
			dequeuePendingWork([deferred], {activeAgentIds: ['unrelated']}).item,
		).toBe(deferred);
		expect(
			dequeuePendingWork([deferred], {
				activeAgentIds: [],
				currentWorkReady: false,
			}).item,
		).toBeUndefined();
		const allAgents: PendingWorkItem = {
			value: 'later',
			delivery: 'after-current',
		};
		expect(
			dequeuePendingWork([allAgents], {activeAgentIds: ['unrelated']}).item,
		).toBeUndefined();
		const noAgents: PendingWorkItem = {...allAgents, waitForAgentIds: []};
		expect(
			dequeuePendingWork([noAgents], {activeAgentIds: ['unrelated']}).item,
		).toBe(noAgents);
		const immediate: PendingWorkItem = {value: 'now', delivery: 'steer'};
		expect(
			dequeuePendingWork([deferred, immediate], {
				activeAgentIds: ['agent-a'],
				currentWorkReady: false,
			}).item,
		).toBe(immediate);
		expect(dequeuePendingWork([deferred]).item).toBe(deferred);
		expect(dequeuePendingWork([])).toEqual({remaining: []});
	});

	test('omits zero-second runtime and shows it from one second', () => {
		expect(backgroundWaitingMessage('8 agents', 0)).toBe(
			'✦ Waiting for 8 agents. Chat remains available.',
		);
		expect(backgroundWaitingMessage('8 agents', 1)).toBe(
			'✦ Waiting for 8 agents · running 1s. Chat remains available.',
		);
		expect(backgroundWaitingMessage('2 agents', 28_812, 28_812)).toContain(
			'no update for 28812s',
		);
		expect(elapsedSinceOldest([1_000, 1_800], 1_999)).toBe(0);
		expect(elapsedSinceOldest([1_000, 1_800], 2_000)).toBe(1);
		expect(elapsedSinceOldest([1_000, 1_800], 3_500)).toBe(2);
	});
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
		expect(first[0]?.value).toContain('one combined update');
		expect(first[0]?.value).toContain('Do not repeat full assignments');
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
			{value: 'bash done', source: 'task', owner: 'goal'},
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

	test('interleaved graphs and owners retain queue order and metadata', () => {
		const notification = (
			value: string,
			graphId: string,
			owner: PendingWorkItem['owner'],
		): PendingWorkItem => ({value, source: 'task', graphId, owner});
		const first: PendingWorkItem = {
			...notification('a1', 'graph-a', 'goal'),
			attachments: {'1': '/saved/result.png'},
			delivery: 'steer',
			waitForAgentIds: [],
		};
		const queue = [
			first,
			notification('a2', 'graph-a', 'goal'),
			notification('b1', 'graph-b', 'goal'),
			notification('a3', 'graph-a', 'goal'),
			notification('a4', 'graph-a', 'loop'),
			notification('a5', 'graph-a', 'user'),
			notification('b2', 'graph-b', 'user'),
			notification('b3', 'graph-b', 'user'),
		];
		const original = [...queue];
		const expected = [
			{...first, value: 'a1\n\na2'},
			queue[2],
			queue[3],
			queue[4],
			queue[5],
			{...queue[6], value: 'b2\n\nb3'},
		];
		let remaining = queue;
		for (const item of expected) {
			const result = dequeuePendingWork(remaining);
			expect(result.item).toEqual(item);
			remaining = result.remaining;
		}
		expect(remaining).toEqual([]);
		expect(queue).toEqual(original);
		expect(first.value).toBe('a1');
	});

	test('legacy unscoped notifications only coalesce with matching legacy ownership', () => {
		const queue: PendingWorkItem[] = [
			{value: 'legacy 1', source: 'task'},
			{value: 'legacy 2', source: 'task'},
			{value: 'owned legacy', source: 'task', owner: 'user'},
			{value: 'scoped', source: 'task', owner: 'user', graphId: 'graph-a'},
			{value: 'ownerless scoped', source: 'task', graphId: 'graph-a'},
			{value: 'legacy 3', source: 'task'},
		];
		const first = dequeuePendingWork(queue);
		expect(first.item).toEqual({
			value: 'legacy 1\n\nlegacy 2',
			source: 'task',
		});
		expect(first.remaining).toEqual(queue.slice(2));
		let remaining = first.remaining;
		for (const item of queue.slice(2)) {
			const result = dequeuePendingWork(remaining);
			expect(result.item).toEqual(item);
			remaining = result.remaining;
		}
		expect(remaining).toEqual([]);
	});

	test('enqueued graph metadata survives coalesced delivery', () => {
		const completion = {
			kind: 'agent' as const,
			id: 'agent-a',
			status: 'completed' as const,
			output: 'done',
			owner: 'goal' as const,
			graphId: 'graph-a',
		};
		const queue = enqueueTaskNotification(
			enqueueTaskNotification([], completion),
			{...completion, id: 'agent-b'},
		);
		const result = dequeuePendingWork(queue);
		expect(result.item).toEqual({
			value: queue.map(item => item.value).join('\n\n'),
			source: 'task',
			owner: 'goal',
			graphId: 'graph-a',
		});
		expect(result.remaining).toEqual([]);
	});

	test('agent completion waits until the entire running batch settles', () => {
		expect(shouldProcessDetachedCompletion('agent', 4)).toBe(false);
		expect(shouldProcessDetachedCompletion('agent', 1)).toBe(false);
		expect(shouldProcessDetachedCompletion('agent', 0)).toBe(true);
		expect(shouldProcessDetachedCompletion('bash', 5)).toBe(true);
		expect(shouldProcessDetachedCompletion('agent', 5, 0)).toBe(true);
	});

	test('foreground releases only after successful background agent calls', () => {
		expect(
			shouldReleaseDetachedAgentBatch(
				[
					{name: 'agent', arguments: {background: true}},
					{name: 'agent', arguments: {background: true}},
				],
				[
					{content: 'Started background agent agent:general:1'},
					{content: 'Started background agent agent:general:2'},
				],
			),
		).toBe(true);
		expect(
			shouldReleaseDetachedAgentBatch(
				[{name: 'agent', arguments: {}}],
				[{content: 'Started background agent agent:general:3'}],
			),
		).toBe(true);
		expect(
			shouldReleaseDetachedAgentBatch(
				[{name: 'agent', arguments: {background: false}}],
				[{content: 'done'}],
			),
		).toBe(false);
		expect(
			shouldReleaseDetachedAgentBatch(
				[{name: 'agent', arguments: {background: true}}],
				[{content: 'Error: launch failed'}],
			),
		).toBe(false);
		expect(
			shouldReleaseDetachedAgentBatch(
				[{name: 'agent_wait', arguments: {}}],
				[{content: 'waiting'}],
			),
		).toBe(false);
	});
	test('recognizes internal task notifications', () => {
		expect(
			isTaskNotification('<task_notification>{}</task_notification>'),
		).toBe(true);
		expect(isTaskNotification('human-readable update')).toBe(false);
	});
});
