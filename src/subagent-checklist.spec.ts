import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {executeTool, type ToolContext} from './tools';
import {
	activeAgentRuns,
	setActiveAgentRuns,
	setTasks,
	tasks,
	type ActiveAgentRun,
} from './state';

const agent = (id: string): ActiveAgentRun => ({
	id,
	name: 'general',
	description: id,
	output: '',
	transcript: [],
	streaming: '',
	history: [],
	status: 'running',
	generation: 1,
});
const call = (
	name: string,
	args: Record<string, unknown> = {},
	ctx: ToolContext = {},
) => executeTool({id: name, name, arguments: args, rawArguments: ''}, ctx);

describe('subagent checklist isolation', () => {
	let previousTasks: ReturnType<typeof tasks>;
	let previousAgents: ActiveAgentRun[];
	beforeEach(() => {
		previousTasks = tasks();
		previousAgents = activeAgentRuns();
		setTasks([{id: 'shared', title: 'Main work', status: 'in_progress'}]);
		setActiveAgentRuns([agent('child-a'), agent('child-b')]);
	});
	afterEach(() => {
		setTasks(previousTasks);
		setActiveAgentRuns(previousAgents);
	});

	test('concurrent writes and display snapshots belong to each child', async () => {
		let saves = 0;
		const results = await Promise.all(
			['child-a', 'child-b'].map(agentId =>
				call(
					'write_tasks',
					{
						title: `${agentId} checklist`,
						tasks: [{id: 'shared', title: agentId, status: 'in_progress'}],
					},
					{
						agentId,
						onStateChange: () => {
							saves++;
						},
					},
				),
			),
		);
		expect(tasks()[0]?.title).toBe('Main work');
		expect(saves).toBe(2);
		for (const [index, run] of activeAgentRuns().entries()) {
			expect(run.tasks?.[0]?.title).toBe(run.id);
			expect(run.tasksTitle).toBe(`${run.id} checklist`);
			expect(results[index]?.displayArgs?.agentId).toBe(run.id);
			expect(results[index]?.displayArgs?.tasks).toEqual(run.tasks);
			expect(results[index]?.displayArgs?.tasks).not.toBe(run.tasks);
		}
	});

	test('all task tools use local ids, dependencies, and active status', async () => {
		const ctx = {agentId: 'child-a'};
		expect((await call('task_list', {}, ctx)).content).toBe('No tasks.');
		expect(
			(await call('task_get', {task_id: 'shared'}, ctx)).content,
		).toContain('not found');
		await call(
			'write_tasks',
			{
				title: 'Child work',
				tasks: [
					{id: 'shared', title: 'Child prerequisite', status: 'pending'},
					{
						id: 'dependent',
						title: 'Child dependent',
						status: 'pending',
						dependsOn: ['shared'],
					},
				],
			},
			ctx,
		);
		expect(
			(
				await call(
					'task_update',
					{task_id: 'dependent', status: 'in_progress'},
					ctx,
				)
			).content,
		).toContain('blocked');
		await call('task_update', {task_id: 'shared', status: 'completed'}, ctx);
		await call(
			'task_update',
			{task_id: 'dependent', status: 'in_progress'},
			ctx,
		);
		await call(
			'task_create',
			{title: 'Extra child work', owner: 'reviewer'},
			ctx,
		);
		expect((await call('task_list', {}, ctx)).content).toContain(
			'Extra child work',
		);
		expect(
			(await call('task_get', {task_id: 'shared'}, ctx)).content,
		).toContain('completed');
		expect(activeAgentRuns()[0]?.tasks).toHaveLength(3);
		expect(activeAgentRuns()[1]?.tasks).toBeUndefined();
		expect(tasks()).toEqual([
			{id: 'shared', title: 'Main work', status: 'in_progress'},
		]);
		expect((await call('task_list')).content).toContain('Main work');
	});

	test('missing or stale child never falls back to main checklist', async () => {
		for (const ctx of [
			{agentId: 'missing'},
			{agentId: 'child-a', agentGeneration: 0},
		]) {
			for (const [name, args] of [
				['write_tasks', {title: 'Wrong owner', tasks: []}],
				['task_create', {title: 'Wrong owner'}],
				['task_update', {task_id: 'shared', status: 'completed'}],
				['task_get', {task_id: 'shared'}],
				['task_list', {}],
			] as const) {
				expect((await call(name, args, ctx)).content).toStartWith('Error:');
			}
		}
		expect(tasks()[0]?.status).toBe('in_progress');
	});

	test('restored child retains checklist and can continue updating', async () => {
		const ctx = {agentId: 'child-a'};
		await call(
			'write_tasks',
			{
				title: 'Resume work',
				tasks: [{id: 'resume', title: 'Keep progress', status: 'in_progress'}],
			},
			ctx,
		);
		setActiveAgentRuns(JSON.parse(JSON.stringify(activeAgentRuns())));
		await call('task_update', {task_id: 'resume', status: 'completed'}, ctx);
		expect(activeAgentRuns()[0]?.tasksTitle).toBe('Resume work');
		expect(activeAgentRuns()[0]?.tasks?.[0]?.status).toBe('completed');
		expect(tasks()[0]?.status).toBe('in_progress');
	});

	test('subagent dispatch passes child ownership, including review agents', () => {
		const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
		expect(source).toMatch(
			/executeTool\(call, \{\s*\.\.\.toolContext,\s*agentId,\s*agentGeneration,/,
		);
		expect(source).toMatch(
			/ctx\.onProgress\?\.\(render\(\)\);\s*\},\s*signal,\s*undefined,\s*undefined,\s*ctx,\s*id,/,
		);
	});
});
