import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {taskOwnershipError} from './task-ownership';
import {executeTool, type ToolContext} from './tools';
import {activeAgentRuns, setActiveAgentRuns, setTasks, tasks} from './state';

describe('agent-only checklist validation', () => {
	for (const title of [
		'User verifies the live UI',
		'User verification',
		'Manual user verification',
		'Wait for user to restart the harness',
		'Waiting for user approval',
		'Await restart confirmation',
		'Wait for manual verification',
		'Get user approval',
		'Ask the user to test the build',
		'Confirmation from the user',
		'Manual verification by the user',
	]) {
		test(`rejects ${title}`, () => {
			expect(taskOwnershipError({title})).toContain('outside the checklist');
		});
	}
	for (const title of [
		'Run automated tests',
		'Implement user approval dialog',
		'Test user restart confirmation flow',
		'Run pending agent tests after restart confirmation',
		'Verify restart behavior',
		'Implement wait for user input handling',
		'Review user feedback parser',
		'Run manual checks in prepared test environment',
	]) {
		test(`allows ${title}`, () => {
			expect(taskOwnershipError({title, owner: 'reviewer'})).toBeUndefined();
		});
	}
	test('checks active form and explicit human ownership', () => {
		expect(
			taskOwnershipError({
				title: 'Check UI',
				activeForm: 'Waiting for user approval',
			}),
		).toContain('agent-owned');
		expect(taskOwnershipError({title: 'Check UI', owner: 'user'})).toContain(
			'agent-owned',
		);
	});
});

describe('task tools reject user work atomically', () => {
	let previousTasks: ReturnType<typeof tasks>;
	let previousAgents: ReturnType<typeof activeAgentRuns>;
	beforeEach(() => {
		previousTasks = tasks();
		previousAgents = activeAgentRuns();
		const initial = [
			{
				id: 'active',
				title: 'Implement validator',
				status: 'in_progress' as const,
			},
			{id: 'tests', title: 'Run automated tests', status: 'pending' as const},
		];
		setTasks(structuredClone(initial));
		setActiveAgentRuns(
			['child-a', 'child-b'].map(id => ({
				id,
				name: 'general',
				description: id,
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				status: 'running',
				generation: 1,
				tasksTitle: 'Original checklist',
				tasks: structuredClone(initial),
			})),
		);
	});
	afterEach(() => {
		setTasks(previousTasks);
		setActiveAgentRuns(previousAgents);
	});
	const call = (
		name: string,
		args: Record<string, unknown>,
		ctx: ToolContext,
	) =>
		executeTool(
			{id: name, name, arguments: args, rawArguments: ''},
			{...ctx, preprocessedArgs: args},
		);

	for (const agentId of [undefined, 'child-a']) {
		test(`${agentId ?? 'main'} rejects every mutation without changing any checklist`, async () => {
			const beforeTasks = tasks();
			const beforeAgents = activeAgentRuns();
			const snapshot = structuredClone({
				tasks: tasks(),
				agents: activeAgentRuns(),
			});
			let saves = 0;
			const ctx = {
				agentId,
				onStateChange: () => {
					saves++;
				},
			};
			const mutations: [string, Record<string, unknown>][] = [
				[
					'write_tasks',
					{
						title: 'Rejected replacement',
						tasks: [
							{
								id: 'valid',
								title: 'Run automated tests',
								status: 'in_progress',
							},
							{
								id: 'invalid',
								title: 'Wait for user restart',
								status: 'pending',
							},
						],
					},
				],
				['task_create', {title: 'Get user approval'}],
				[
					'write_tasks',
					{
						title: 'Rejected active form',
						tasks: [
							{
								title: 'Check build',
								activeForm: 'Waiting for user restart',
								status: 'pending',
							},
						],
					},
				],
				[
					'write_tasks',
					{
						title: 'Rejected owner',
						tasks: [{title: 'Check build', owner: 'user', status: 'completed'}],
					},
				],
				['task_create', {title: 'Verify UI', owner: 'human'}],
				[
					'task_update',
					{task_id: 'tests', title: 'User verification', status: 'in_progress'},
				],
				[
					'task_update',
					{
						task_id: 'tests',
						activeForm: 'Waiting for user approval',
						status: 'completed',
					},
				],
				['task_update', {task_id: 'tests', owner: 'user', status: 'completed'}],
			];
			for (const [name, args] of mutations) {
				expect((await call(name, args, ctx)).content).toContain(
					'outside the checklist',
				);
				expect(tasks()).toBe(beforeTasks);
				expect(activeAgentRuns()).toBe(beforeAgents);
				expect({tasks: tasks(), agents: activeAgentRuns()}).toEqual(snapshot);
			}
			expect(saves).toBe(0);
		});
	}

	test('status-only update validates persisted title; correcting title succeeds', async () => {
		setTasks([{id: 'old', title: 'Wait for user approval', status: 'pending'}]);
		const before = tasks();
		expect(
			(await call('task_update', {task_id: 'old', status: 'completed'}, {}))
				.content,
		).toContain('agent-owned');
		expect(tasks()).toBe(before);
		expect(
			(
				await call(
					'task_update',
					{
						task_id: 'old',
						title: 'Implement user approval dialog',
						status: 'in_progress',
					},
					{},
				)
			).content,
		).not.toStartWith('Error:');
		expect(tasks()[0]?.status).toBe('in_progress');
	});

	test('legitimate pending agent tests and title/status updates stay child-local', async () => {
		const main = tasks();
		const sibling = activeAgentRuns()[1];
		const ctx = {agentId: 'child-a'};
		for (const [name, args] of [
			[
				'write_tasks',
				{
					title: 'Agent work',
					tasks: [
						{
							id: 'active',
							title: 'Implement user approval dialog',
							status: 'in_progress',
						},
						{id: 'tests', title: 'Run automated tests', status: 'pending'},
					],
				},
			],
			[
				'task_create',
				{title: 'Test user restart confirmation flow', owner: 'reviewer'},
			],
			[
				'task_update',
				{
					task_id: 'tests',
					title: 'Run pending agent tests after restart confirmation',
					status: 'pending',
				},
			],
			['task_update', {task_id: 'active', status: 'completed'}],
		] as [string, Record<string, unknown>][]) {
			expect((await call(name, args, ctx)).content).not.toStartWith('Error:');
		}
		expect(activeAgentRuns()[0]?.tasks?.[1]?.status).toBe('pending');
		expect(activeAgentRuns()[0]?.tasks?.[0]?.status).toBe('completed');
		expect(tasks()).toBe(main);
		expect(activeAgentRuns()[1]).toBe(sibling);
	});
});
