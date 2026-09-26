import {afterEach, beforeEach, expect, test} from 'bun:test';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runHooks} from './hooks';
import {executeTool, preprocessToolInput} from './tools';
import {tasks, setTasks} from './state';

let root: string;
let cwd: string;
let config: string | undefined;
let previousTasks: ReturnType<typeof tasks>;

beforeEach(() => {
	cwd = process.cwd();
	config = process.env.BOBONYO_CONFIG_DIR;
	previousTasks = tasks();
	root = mkdtempSync(join(tmpdir(), 'checklist-hook-'));
	mkdirSync(join(root, '.bobonyo'));
	process.chdir(root);
	process.env.BOBONYO_CONFIG_DIR = join(root, '.bobonyo');
	const action = {
		type: 'command',
		command: `cat >/dev/null; echo invoked >> '${join(root, 'hook-calls')}'; printf '%s' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"Blocked: no concrete progress for 8 minutes.","updatedInput":{"title":"User verification","tasks":[]}}}'; exit 2`,
	};
	writeFileSync(
		join(root, '.bobonyo/settings.json'),
		JSON.stringify({
			hooks: {
				PreToolUse: [{matcher: '.*', hooks: [action]}],
				PostToolUse: [{matcher: '.*', hooks: [action]}],
			},
		}),
	);
	setTasks([{id: 'work', title: 'Implement change', status: 'in_progress'}]);
});

afterEach(() => {
	setTasks(previousTasks);
	process.chdir(cwd);
	if (config === undefined) delete process.env.BOBONYO_CONFIG_DIR;
	else process.env.BOBONYO_CONFIG_DIR = config;
	rmSync(root, {recursive: true, force: true});
});

const call = (name: string, args: Record<string, unknown>) => ({
	id: name,
	name,
	arguments: args,
	rawArguments: JSON.stringify(args),
});

test('blanket hook denial cannot block or rewrite checklist tools in either execution path', async () => {
	const replacement = call('write_tasks', {
		title: 'Implement change',
		tasks: [{id: 'work', title: 'Implement change', status: 'completed'}],
	});
	const args = await preprocessToolInput(replacement);
	expect(args).toEqual(replacement.arguments);
	expect(
		(await executeTool(replacement, {preprocessedArgs: args})).content,
	).not.toStartWith('Error:');
	expect(tasks()[0]?.status).toBe('completed');
	const created = await executeTool(
		call('task_create', {title: 'Run regression tests'}),
	);
	expect(created.content).not.toStartWith('Error:');
	const id = tasks().at(-1)!.id;
	for (const [name, input] of [
		['task_get', {task_id: id}],
		['task_list', {}],
		['task_update', {task_id: id, status: 'in_progress'}],
	] as [string, Record<string, unknown>][]) {
		expect((await executeTool(call(name, input))).content).not.toStartWith(
			'Error:',
		);
	}
	expect(tasks().at(-1)?.status).toBe('in_progress');
	expect(() => readFileSync(join(root, 'hook-calls'))).toThrow();
});

test('checklist exemption retains schema and agent-ownership validation atomically', async () => {
	const before = structuredClone(tasks());
	expect(
		(await executeTool(call('write_tasks', {tasks: []}))).content,
	).toContain('Invalid tool arguments');
	expect(
		(
			await executeTool(
				call('write_tasks', {
					title: 'Work',
					tasks: [{title: 'User verification', status: 'pending'}],
				}),
			)
		).content,
	).toContain('outside the checklist');
	expect(tasks()).toEqual(before);
});

test('non-checklist hooks still deny tools, including similarly named tools', async () => {
	for (const toolName of [
		'write_file',
		'execute_bash',
		'agent',
		'task_delete',
		'write_tasks_extra',
	]) {
		const result = await runHooks({
			event: 'PreToolUse',
			toolName,
			toolInput: {},
		});
		expect(result.denied).toContain('no concrete progress');
	}
	expect(
		(await executeTool(call('read_file', {path: 'missing.txt'}))).content,
	).toContain('no concrete progress');
	expect(readFileSync(join(root, 'hook-calls'), 'utf8')).toContain('invoked');
});
