import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	executeTool,
	requiresApproval,
	requiresCallApproval,
	toolCatalog,
	resetSessionPermissionGrants,
} from './tools';
import {cliMode} from './cli-mode';
import {commandSandboxSettings, loadSettings} from './settings';
import {activeAgentRuns, setActiveAgentRuns, setTasks, tasks} from './state';

let root: string;
let previous: Record<string, string | undefined>;
const environment = [
	'BOBONYO_MODE',
	'NANOCODER_MODE',
	'BOBONYO_CONFIG_DIR',
	'NANOCODER_NONINTERACTIVE',
] as const;
beforeEach(() => {
	previous = Object.fromEntries(
		environment.map(key => [key, process.env[key]]),
	);
	for (const key of environment) delete process.env[key];
	root = mkdtempSync(join(tmpdir(), 'bobonyo-mode-permissions-'));
	process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
	mkdirSync(join(root, 'workspace'));
	resetSessionPermissionGrants();
});
afterEach(() => {
	resetSessionPermissionGrants();
	for (const key of environment) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
	rmSync(root, {recursive: true, force: true});
});

describe('mode-specific tool permissions', () => {
	test.each(['fresh', 'legacy-yolo', 'persisted-default'])(
		'%s keeps all old-yolo auto-approved tools and sandbox preferences',
		stored => {
			if (stored !== 'fresh') {
				mkdirSync(process.env.BOBONYO_CONFIG_DIR!, {recursive: true});
				writeFileSync(
					join(process.env.BOBONYO_CONFIG_DIR!, 'settings.json'),
					JSON.stringify({
						mode: stored === 'legacy-yolo' ? 'yolo' : 'default',
						sandbox: {
							mode: 'workspace-write',
							network: true,
							writablePaths: [],
						},
					}),
				);
			}
			const settings = loadSettings();
			expect(settings.mode).toBe('default');
			expect(commandSandboxSettings(settings).mode).toBe(
				stored === 'fresh' ? 'auto' : 'workspace-write',
			);
			const workspace = join(root, 'workspace');
			const names = new Set([
				...toolCatalog().map(tool => tool.name),
				'write_tasks',
				'task_create',
				'task_update',
				'execute_bash',
				'write_file',
				'edit_file',
				'delete_file',
				'apply_patch',
			]);
			for (const name of names) {
				expect(requiresApproval(name, settings.mode)).toBe(false);
				expect(
					requiresCallApproval(
						{
							id: name,
							name,
							arguments: {path: 'file.txt', command: 'echo test'},
							rawArguments: '',
						},
						settings.mode,
						[],
						workspace,
						workspace,
					),
				).toBe(false);
			}
		},
	);
	test.each(['foreground', 'subagent'])(
		'%s default executes checklist tools without approval or clarification',
		async owner => {
			const previousTasks = tasks();
			const previousRuns = activeAgentRuns();
			setTasks([]);
			setActiveAgentRuns([
				{
					id: 'mode-child',
					name: 'general',
					description: 'Mode regression',
					status: 'running',
					output: '',
					transcript: [],
					streaming: '',
					history: [],
					generation: 1,
				},
			]);
			let prompts = 0;
			const ctx = {
				cwd: join(root, 'workspace'),
				workspaceRoot: join(root, 'workspace'),
				...(owner === 'subagent'
					? {agentId: 'mode-child', agentGeneration: 1}
					: {}),
				askUser: async () => {
					prompts++;
					return 'Deny';
				},
			};
			try {
				for (const [name, args] of [
					[
						'write_tasks',
						{
							title: 'Verify mode behavior',
							tasks: [
								{
									id: 'mode-test',
									title: 'Run regression tests',
									status: 'in_progress',
								},
							],
						},
					],
					['task_update', {task_id: 'mode-test', status: 'completed'}],
					['task_create', {title: 'Inspect sandbox policy'}],
				] as const) {
					const call = {
						id: name,
						name,
						arguments: args,
						rawArguments: JSON.stringify(args),
					};
					// Foreground uses this shared gate; delegated dispatch executes directly.
					expect(
						requiresCallApproval(
							call,
							loadSettings().mode,
							[],
							ctx.cwd,
							ctx.workspaceRoot,
						),
					).toBe(false);
					const result = await executeTool(call, ctx);
					expect(result.content).not.toStartWith('Error:');
				}
				expect(prompts).toBe(0);
				const checklist =
					owner === 'subagent' ? activeAgentRuns()[0]!.tasks! : tasks();
				expect(checklist.find(task => task.id === 'mode-test')?.status).toBe(
					'completed',
				);
				expect(checklist).toHaveLength(2);
			} finally {
				setTasks(previousTasks);
				setActiveAgentRuns(previousRuns);
			}
		},
	);
	test('foreground and delegated dispatch retain their shared policy wiring', () => {
		const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
		const tools = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
		expect(app).toMatch(/requiresCallApproval\(\s*approvalCall,\s*mode\(\)/);
		expect(tools).toMatch(
			/executeTool\(call, \{\s*\.\.\.toolContext,\s*agentId,\s*agentGeneration,/,
		);
	});
	test('default still auto-approves mutations', () => {
		expect(requiresApproval('delete_file', loadSettings().mode)).toBe(false);
	});
	test('--yolo auto-approves tools and explicit permission requests without interaction', async () => {
		process.env.BOBONYO_MODE = cliMode(['--yolo']);
		expect(requiresApproval('execute_bash', loadSettings().mode)).toBe(false);
		const result = await executeTool({
			id: 'permission',
			name: 'request_permissions',
			arguments: {permissions: [{tool: 'execute_bash', reason: 'host access'}]},
			rawArguments: '',
		});
		expect(result.content).toContain('Granted');
	});
	test('--yolo allows external file writes without permission questions', async () => {
		process.env.BOBONYO_MODE = cliMode(['--yolo']);
		let questions = 0;
		const path = join(root, 'external.txt');
		const result = await executeTool(
			{
				id: 'write',
				name: 'write_file',
				arguments: {path, content: 'host'},
				rawArguments: '',
			},
			{
				cwd: join(root, 'workspace'),
				workspaceRoot: join(root, 'workspace'),
				askUser: async () => {
					questions++;
					return 'Deny';
				},
			},
		);
		expect(result.content).toContain('Wrote');
		expect(await Bun.file(path).text()).toBe('host');
		expect(questions).toBe(0);
	});
	test('default still asks before external writes', async () => {
		let questions = 0;
		const result = await executeTool(
			{
				id: 'write',
				name: 'write_file',
				arguments: {path: join(root, 'external.txt'), content: 'host'},
				rawArguments: '',
			},
			{
				cwd: join(root, 'workspace'),
				workspaceRoot: join(root, 'workspace'),
				askUser: async () => {
					questions++;
					return 'Deny';
				},
			},
		);
		expect(result.content).toContain('Permission denied');
		expect(questions).toBe(1);
	});
	test('--yolo preserves real clarification questions', async () => {
		process.env.BOBONYO_MODE = cliMode(['--yolo']);
		let questions = 0;
		const result = await executeTool(
			{
				id: 'question',
				name: 'question',
				arguments: {questions: [{question: 'Which target?'}]},
				rawArguments: '',
			},
			{
				askUser: async () => {
					questions++;
					return 'staging';
				},
			},
		);
		expect(questions).toBe(1);
		expect(result.content).toContain('staging');
	});
});
