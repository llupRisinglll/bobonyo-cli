import {describe, expect, test} from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	displayToolName,
	callUsesGrantedExternalWritePath,
	executeTool,
	isReadOnlyTool,
	isParallelSafeTool,
	requiresApproval,
	requiresCallApproval,
	readonlyFailurePath,
	registerTool,
	toolCatalog,
	toolCatalogForModel,
	modelUsesApplyPatch,
	toolAvailability,
	resetDeferredToolActivation,
	resetSessionPermissionGrants,
	searchDeferredTools,
	MAX_SUBAGENT_TOOL_ROUNDS,
	SUBAGENT_FINALIZATION_PROMPT,
} from './tools';
import {loadPersistentMemory} from './memory';
import {
	beginFileUndoExchange,
	resetFileUndoStack,
	undoFileExchange,
} from './file-undo';

test('remember tool persists explicit session guidance', async () => {
	const root = mkdtempSync(join(tmpdir(), 'bobonyo-remember-'));
	const originalConfig = process.env.BOBONYO_CONFIG_DIR;
	const originalData = process.env.BOBONYO_DATA_DIR;
	try {
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		process.env.BOBONYO_DATA_DIR = join(root, 'data');
		const result = await executeTool(
			{
				id: 'remember-1',
				name: 'remember',
				arguments: {text: 'Keep responses concise.', scope: 'session'},
				rawArguments: '',
			},
			{cwd: root, sessionId: 'session-1'},
		);
		expect(result.content).toMatch(/Remembered session guidance/);
		expect(loadPersistentMemory(root, 'session-1').session).toContain(
			'Keep responses concise.',
		);
	} finally {
		if (originalConfig === undefined) delete process.env.BOBONYO_CONFIG_DIR;
		else process.env.BOBONYO_CONFIG_DIR = originalConfig;
		if (originalData === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = originalData;
		rmSync(root, {recursive: true, force: true});
	}
});

/**
 * Delete tool: the harness hook point for file deletions (approval in
 * normal mode + the future protection rules). The model must prefer it over
 * `rm` in bash, so it is advertised as the Delete tool in the catalog and
 * execute_bash's description points at it.
 */
describe('delete_file tool', () => {
	test('registered in the catalog with a schema and description', () => {
		const entry = toolCatalog().find(tool => tool.name === 'delete_file');
		expect(entry).toBeDefined();
		expect(entry?.description).toMatch(/delete/i);
		const schema = entry?.parameters as {properties?: Record<string, unknown>};
		expect(schema?.properties?.path).toBeDefined();
	});

	test('displays as Delete and is a mutation tool (needs approval)', () => {
		expect(displayToolName('delete_file')).toBe('Delete');
		expect(isReadOnlyTool('delete_file')).toBe(false);
		expect(requiresApproval('delete_file', 'normal')).toBe(true);
		expect(requiresApproval('delete_file', 'yolo')).toBe(false);
	});

	test('deletes an existing file and reports the path', async () => {
		const dir = '/tmp/bobonyo-delete-spec';
		mkdirSync(dir, {recursive: true});
		const path = join(dir, 'to-delete.txt');
		writeFileSync(path, 'x');
		const result = await executeTool(
			{id: 'c1', name: 'delete_file', arguments: {path}, rawArguments: ''},
			{cwd: dir},
		);
		expect(result.content).toBe(`Deleted ${path}`);
		expect(() => statSync(path)).toThrow();
	});

	test('missing files and directories are rejected with clear errors', async () => {
		const missing = await executeTool(
			{
				id: 'c2',
				name: 'delete_file',
				arguments: {path: '/tmp/bobonyo-delete-spec/nope.txt'},
				rawArguments: '',
			},
			{cwd: '/tmp/bobonyo-delete-spec'},
		);
		expect(missing.content).toMatch(/does not exist/);

		mkdirSync('/tmp/bobonyo-delete-spec/dir', {recursive: true});
		const dir = await executeTool(
			{
				id: 'c3',
				name: 'delete_file',
				arguments: {path: '/tmp/bobonyo-delete-spec/dir'},
				rawArguments: '',
			},
			{cwd: '/tmp/bobonyo-delete-spec'},
		);
		expect(dir.content).toMatch(/directory/i);
	});
});

describe('stable workspace boundary after nested cwd changes', () => {
	test('edit_file can modify a sibling under launch workspace', async () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-workspace-root-'));
		const nested = join(root, 'nested', 'checkout');
		const sibling = join(root, 'finance');
		mkdirSync(nested, {recursive: true});
		mkdirSync(sibling, {recursive: true});
		const path = join(sibling, 'file.txt');
		writeFileSync(path, 'before');
		try {
			const result = await executeTool(
				{
					id: 'nested-edit',
					name: 'edit_file',
					arguments: {
						path,
						old_string: 'before',
						new_string: 'after',
					},
					rawArguments: '',
				},
				{cwd: nested, workspaceRoot: root},
			);
			expect(result.content).toContain('Replaced 1 occurrence');
			expect(readFileSync(path, 'utf8')).toBe('after');
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});
});

describe('external folder write approvals', () => {
	test('write_file asks once and session grant covers later edits', async () => {
		resetSessionPermissionGrants();
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-grant-root-'));
		const workspace = join(root, 'workspace');
		const external = join(root, 'external');
		mkdirSync(workspace, {recursive: true});
		mkdirSync(external, {recursive: true});
		let prompts = 0;
		const askUser = async () => {
			prompts += 1;
			return 'Allow folder for session';
		};
		try {
			for (const name of ['one.txt', 'two.txt']) {
				const result = await executeTool(
					{
						id: name,
						name: 'write_file',
						arguments: {path: join(external, name), content: name},
						rawArguments: '',
					},
					{cwd: workspace, workspaceRoot: workspace, askUser},
				);
				expect(result.content).toContain('Wrote');
			}
			expect(prompts).toBe(1);
		} finally {
			resetSessionPermissionGrants();
			rmSync(root, {recursive: true, force: true});
		}
	});
	test('folder grant bypasses normal approval only for files below that folder', async () => {
		resetSessionPermissionGrants();
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-grant-scope-'));
		const workspace = join(root, 'workspace');
		const external = join(root, 'external');
		mkdirSync(workspace, {recursive: true});
		mkdirSync(external, {recursive: true});
		try {
			await executeTool(
				{
					id: 'grant-folder',
					name: 'write_file',
					arguments: {path: join(external, 'one.txt'), content: 'one'},
					rawArguments: '',
				},
				{
					cwd: workspace,
					workspaceRoot: workspace,
					askUser: async () => 'Allow folder for session',
				},
			);
			const allowed = {
				id: 'allowed',
				name: 'write_file',
				arguments: {path: join(external, 'two.txt'), content: 'two'},
				rawArguments: '',
			};
			expect(
				callUsesGrantedExternalWritePath(allowed, workspace, workspace),
			).toBe(true);
			expect(
				requiresCallApproval(allowed, 'normal', [], workspace, workspace),
			).toBe(false);
			expect(
				callUsesGrantedExternalWritePath(
					{
						...allowed,
						arguments: {path: join(root, 'other.txt'), content: 'x'},
					},
					workspace,
					workspace,
				),
			).toBe(false);
			expect(
				requiresCallApproval(
					{
						...allowed,
						arguments: {path: join(root, 'other.txt'), content: 'x'},
					},
					'normal',
					[],
					workspace,
					workspace,
				),
			).toBe(true);
			expect(
				callUsesGrantedExternalWritePath(
					{
						...allowed,
						name: 'Write',
					},
					workspace,
					workspace,
				),
			).toBe(true);
			expect(
				callUsesGrantedExternalWritePath(
					{
						...allowed,
						name: 'string_replace',
						arguments: {
							path: join(external, 'two.txt'),
							old_string: 'two',
							new_string: 'three',
						},
					},
					workspace,
					workspace,
				),
			).toBe(false);
			expect(
				callUsesGrantedExternalWritePath(
					{
						...allowed,
						name: 'execute_bash',
						arguments: {command: 'touch file'},
					},
					workspace,
					workspace,
				),
			).toBe(false);
		} finally {
			resetSessionPermissionGrants();
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('denial keeps external folder unchanged', async () => {
		resetSessionPermissionGrants();
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-grant-deny-'));
		const workspace = join(root, 'workspace');
		const external = join(root, 'external');
		mkdirSync(workspace, {recursive: true});
		mkdirSync(external, {recursive: true});
		const path = join(external, 'denied.txt');
		try {
			const result = await executeTool(
				{
					id: 'deny-write',
					name: 'write_file',
					arguments: {path, content: 'no'},
					rawArguments: '',
				},
				{
					cwd: workspace,
					workspaceRoot: workspace,
					askUser: async () => 'Deny',
				},
			);
			expect(result.content).toContain('Permission denied');
			expect(existsSync(path)).toBe(false);
		} finally {
			resetSessionPermissionGrants();
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('extracts blocked paths from common EROFS errors', () => {
		expect(
			readonlyFailurePath(
				"EROFS: read-only file system, rename '/repo/node_modules/pkg' -> '/repo/node_modules/.pkg-tmp'",
			),
		).toBe('/repo/node_modules/pkg');
		expect(
			readonlyFailurePath(
				"touch: cannot touch '/repo/blocked.txt': Read-only file system",
			),
		).toBe('/repo/blocked.txt');
		expect(
			readonlyFailurePath(
				"touch: cannot touch '/repo/wrapped.txt'\n: Read-only file system",
			),
		).toBe('/repo/wrapped.txt');
	});
});

describe('executeTool file-undo wiring (openclaude-rewind parity)', () => {
	test('write_file snapshots its target so /undo removes a newly created file', async () => {
		const dir = '/tmp/bobonyo-undo-wire';
		mkdirSync(dir, {recursive: true});
		const path = join(dir, 'created.txt');
		beginFileUndoExchange('create a file');
		try {
			await executeTool(
				{
					id: 'w1',
					name: 'write_file',
					arguments: {path, content: 'hello'},
					rawArguments: '',
				},
				{cwd: dir, workspaceRoot: dir},
			);
			expect(readFileSync(path, 'utf8')).toBe('hello');

			const undone = undoFileExchange();
			expect(undone?.restored).toContain(path);
			expect(existsSync(path)).toBe(false);
		} finally {
			resetFileUndoStack();
		}
	});

	test('string_replace snapshots the OLD content so /undo restores it', async () => {
		const dir = '/tmp/bobonyo-undo-wire';
		mkdirSync(dir, {recursive: true});
		const path = join(dir, 'edit.txt');
		writeFileSync(path, 'old text');
		beginFileUndoExchange('edit a file');
		try {
			await executeTool(
				{
					id: 's1',
					name: 'string_replace',
					arguments: {
						path,
						old_string: 'old text',
						new_string: 'new text',
					},
					rawArguments: '',
				},
				{},
			);
			expect(readFileSync(path, 'utf8')).toBe('new text');

			undoFileExchange();
			expect(readFileSync(path, 'utf8')).toBe('old text');
		} finally {
			resetFileUndoStack();
		}
	});
	test('edit_file requires one exact match and snapshots for undo', async () => {
		const dir = '/tmp/bobonyo-edit-file';
		mkdirSync(dir, {recursive: true});
		const path = join(dir, 'edit.txt');
		writeFileSync(path, 'one\ntwo\n');
		beginFileUndoExchange('strict edit');
		try {
			const result = await executeTool(
				{
					id: 'edit-file-1',
					name: 'edit_file',
					arguments: {path: 'edit.txt', old_string: 'two', new_string: 'three'},
					rawArguments: '',
				},
				{cwd: dir},
			);
			expect(result.content).toContain('(at line 2)');
			expect(readFileSync(path, 'utf8')).toBe('one\nthree\n');
			undoFileExchange();
			expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n');
		} finally {
			resetFileUndoStack();
		}
	});
	test('string_replace reports the ABSOLUTE line of the first occurrence', async () => {
		// The edit preview numbers the diff against the FILE; the result
		// must carry where the replacement actually happened, never a
		// snippet-relative 1..N. An edit on line 3 of a 5-line file reports
		// `(at line 3)`, and a fresh file (replacement at the top) reports 1.
		const dir = '/tmp/bobonyo-replace-line';
		mkdirSync(dir, {recursive: true});
		const path = join(dir, 'edit.txt');
		writeFileSync(
			path,
			['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n') + '\n',
		);
		const result = await executeTool(
			{
				id: 's2',
				name: 'string_replace',
				arguments: {
					path,
					old_string: 'line 3',
					new_string: 'line 3\nline 3b',
				},
				rawArguments: '',
			},
			{},
		);
		expect(result.content).toMatch(/\(at line 3\)/);
		expect(result.content).not.toMatch(/\(at line 1\)/);
		// A brand-new target (file did not exist) starts at line 1.
		const fresh = await executeTool(
			{
				id: 's3',
				name: 'string_replace',
				arguments: {
					path: join(dir, 'fresh.txt'),
					old_string: 'seed',
					new_string: 'seed\nchild',
				},
				rawArguments: '',
			},
			{},
		);
		expect(fresh.content).toMatch(/\(at line 1\)/);
	});

	test('non-file tools never snapshot (no undo side effects)', async () => {
		beginFileUndoExchange('run bash');
		try {
			await executeTool(
				{
					id: 'b1',
					name: 'execute_bash',
					arguments: {command: 'echo hi'},
					rawArguments: '',
				},
				{},
			);
			const undone = undoFileExchange();
			expect(undone?.restored).toEqual([]);
		} finally {
			resetFileUndoStack();
		}
	});
});

test('executeTool propagates AbortError so Esc cancels subagents', async () => {
	registerTool('abort_test', {
		execute() {
			throw new DOMException('Aborted', 'AbortError');
		},
	});
	await expect(
		executeTool({
			id: 'abort-call',
			name: 'abort_test',
			arguments: {},
			rawArguments: '{}',
		}),
	).rejects.toMatchObject({name: 'AbortError'});
});

describe('deferred tool discovery', () => {
	test('custom and MCP tools stay hidden until tool_search activates them', async () => {
		registerTool('custom__deferred_demo', {
			source: 'custom',
			readOnly: true,
			description: 'Inspect deferred demo records',
			parameters: {type: 'object', properties: {}},
			execute: () => 'ok',
		});
		resetDeferredToolActivation();
		expect(
			toolCatalogForModel('claude-opus-4').map(tool => tool.name),
		).not.toContain('custom__deferred_demo');
		expect(searchDeferredTools('demo records')[0]?.name).toBe(
			'custom__deferred_demo',
		);
		const result = await executeTool({
			id: 'tool-search-1',
			name: 'tool_search',
			arguments: {query: 'demo records'},
			rawArguments: '',
		});
		expect(result.content).toContain('custom__deferred_demo');
		expect(
			toolCatalogForModel('claude-opus-4').map(tool => tool.name),
		).toContain('custom__deferred_demo');
	});
});

describe('scoped permission requests', () => {
	test('grant is session-scoped and external access is path-scoped', async () => {
		resetSessionPermissionGrants();
		expect(requiresApproval('execute_bash', 'normal')).toBe(true);
		const external = mkdtempSync(join(tmpdir(), 'bobonyo-external-grant-'));
		const workspace = mkdtempSync(join(tmpdir(), 'bobonyo-workspace-'));
		const allowed = join(external, 'general-purpose.md');
		const denied = join(tmpdir(), 'bobonyo-external-denied.md');
		writeFileSync(allowed, 'agent');
		writeFileSync(denied, 'keep');
		let prompt = '';
		const granted = await executeTool(
			{
				id: 'permission-1',
				name: 'request_permissions',
				arguments: {
					permissions: [
						{
							tool: 'delete_file',
							reason: 'remove duplicate agent definition',
							operation: `delete_file ${allowed}`,
							paths: [allowed],
						},
					],
				},
				rawArguments: '',
			},
			{
				askUser: async question => {
					prompt = question;
					return 'Grant';
				},
			},
		);
		expect(granted.content).toContain('Granted for this session');
		expect(prompt).toContain(`Command: delete_file ${allowed}`);
		expect(prompt).toContain(`External paths: ${allowed}`);
		const deleted = await executeTool(
			{
				id: 'permission-escape',
				name: 'delete_file',
				arguments: {path: allowed},
				rawArguments: '',
			},
			{cwd: workspace, askUser: async () => 'Deny'},
		);
		expect(deleted.content).toBe(`Deleted ${allowed}`);
		const escaped = await executeTool(
			{
				id: 'permission-outside-scope',
				name: 'delete_file',
				arguments: {path: denied},
				rawArguments: '',
			},
			{cwd: workspace, askUser: async () => 'Deny'},
		);
		expect(escaped.content).toContain('external folder remains read-only');
		expect(existsSync(denied)).toBe(true);
		rmSync(external, {recursive: true, force: true});
		rmSync(workspace, {recursive: true, force: true});
		rmSync(denied, {force: true});
		resetSessionPermissionGrants();
	});

	test('denial and unknown tools produce no grant', async () => {
		resetSessionPermissionGrants();
		const unknown = await executeTool(
			{
				id: 'permission-unknown',
				name: 'request_permissions',
				arguments: {permissions: [{tool: 'magic', reason: 'test'}]},
				rawArguments: '',
			},
			{askUser: async () => 'Grant'},
		);
		expect(unknown.content).toContain('unknown tools');
		const denied = await executeTool(
			{
				id: 'permission-denied',
				name: 'request_permissions',
				arguments: {permissions: [{tool: 'execute_bash', reason: 'test'}]},
				rawArguments: '',
			},
			{askUser: async () => 'Deny'},
		);
		expect(denied.content).toBe('Permission denied.');
		expect(requiresApproval('execute_bash', 'normal')).toBe(true);
	});
});

describe('Herdr skill delivery', () => {
	test('skill tool returns bundled Herdr instructions, not only its name', async () => {
		const result = await executeTool({
			id: 'skill-herdr-test',
			name: 'skill',
			arguments: {name: 'herdr'},
			rawArguments: '{"name":"herdr"}',
		});
		expect(result.content).toContain('<command-invocation name="/herdr">');
		expect(result.content).toContain('HERDR_ENV');
		expect(result.content).toContain('herdr --help');
	});
});

describe('write_tasks explicit lifecycle', () => {
	test('catalog requires status-bearing task objects and proactive guidance', () => {
		const entry = toolCatalog().find(tool => tool.name === 'write_tasks');
		expect(entry?.description).toMatch(/Use proactively/i);
		expect(entry?.description).toMatch(/exactly one in_progress/i);
		expect(entry?.description).toMatch(/only work the agent must perform/i);
		expect(entry?.description).toMatch(/Never add user-owned actions/i);
		expect(entry?.description).toMatch(/manual verification/i);
		const schema = entry?.parameters as {
			properties?: {tasks?: {items?: {properties?: Record<string, unknown>}}};
		};
		expect(schema.properties?.tasks?.items?.properties?.status).toBeDefined();
	});

	test('preserves completed status and limits in_progress to one', async () => {
		const result = await executeTool(
			{
				id: 'tasks-1',
				name: 'write_tasks',
				arguments: {
					title: 'Implement requested changes',
					tasks: [
						{title: 'Inspect code', status: 'completed'},
						{
							title: 'Implement fix',
							activeForm: 'Implementing fix',
							status: 'in_progress',
						},
						{title: 'Run tests', status: 'in_progress'},
					],
				},
				rawArguments: '',
			},
			{},
		);
		expect(result.content).toContain('Inspect code [completed]');
		expect(result.content).toContain('Implement fix [in_progress]');
		expect(result.content).toContain('Run tests [pending]');
		expect(result.displayArgs?.tasks).toEqual([
			{id: 'task_1', title: 'Inspect code', status: 'completed'},
			{
				id: 'task_2',
				title: 'Implement fix',
				activeForm: 'Implementing fix',
				status: 'in_progress',
			},
			{id: 'task_3', title: 'Run tests', status: 'pending'},
		]);
	});

	test('task lifecycle tools enforce dependencies and preserve ownership', async () => {
		const {setTasks} = await import('./state');
		setTasks([
			{id: 'task_a', title: 'Foundation', status: 'pending'},
			{
				id: 'task_b',
				title: 'Dependent',
				status: 'pending',
				dependsOn: ['task_a'],
				owner: 'agent:explore',
			},
		]);
		const blocked = await executeTool({
			id: 'task-update-blocked',
			name: 'task_update',
			arguments: {task_id: 'task_b', status: 'in_progress'},
			rawArguments: '',
		});
		expect(blocked.content).toContain('blocked by task_a');
		await executeTool({
			id: 'task-update-a',
			name: 'task_update',
			arguments: {task_id: 'task_a', status: 'completed'},
			rawArguments: '',
		});
		const started = await executeTool({
			id: 'task-update-b',
			name: 'task_update',
			arguments: {task_id: 'task_b', status: 'in_progress'},
			rawArguments: '',
		});
		expect(started.content).toContain('owner agent:explore');
		const listed = await executeTool({
			id: 'task-list',
			name: 'task_list',
			arguments: {},
			rawArguments: '',
		});
		expect(listed.content).toContain('task_b · in_progress');
	});
});

describe('command tool interpretation', () => {
	test('is advertised as read-only adaptable guidance', () => {
		const entry = toolCatalog().find(tool => tool.name === 'command');
		expect(entry?.description).toMatch(/interpret/i);
		expect(entry?.description).toMatch(/does not execute/i);
		expect(isReadOnlyTool('command')).toBe(true);
	});
});

test('subagentTranscriptTail keeps only recent human-readable events', async () => {
	const {subagentTranscriptTail} = await import('./tools');
	expect(subagentTranscriptTail(['a', 'b', 'c'], 2)).toBe('b\nc');
	expect(subagentTranscriptTail(['only'], 0)).toBe('only');
});

test('formatSubagentStatusMessage renders chat-like tool activity and hides routine results', async () => {
	const {formatSubagentStatusMessage} = await import('./tools');
	expect(
		formatSubagentStatusMessage({
			role: 'assistant',
			content: '',
			tool_calls: [
				{
					id: 'call_1',
					name: 'execute_bash',
					arguments: '{"command":"bun test"}',
				},
			],
		}),
	).toBe('Bash bun test');
	expect(
		formatSubagentStatusMessage({role: 'tool', content: '20 tests passed'}),
	).toBeNull();
	expect(
		formatSubagentStatusMessage({role: 'tool', content: 'Error: test failed'}),
	).toBe('Failed: Error: test failed');
	expect(
		formatSubagentStatusMessage({
			role: 'assistant',
			content: 'Implemented first slice.\nMore details follow.',
		}),
	).toBe('Implemented first slice.');
});

describe('model-facing parity tools', () => {
	test('catalog exposes question, agent lifecycle, LSP, and worktree schemas', () => {
		const catalog = new Map(toolCatalog().map(tool => [tool.name, tool]));
		for (const name of [
			'question',
			'agent',
			'agent_message',
			'agent_status',
			'agent_cancel',
			'lsp',
			'enter_worktree',
			'exit_worktree',
		]) {
			expect(catalog.get(name)?.description).toBeTruthy();
			expect(catalog.get(name)?.parameters).toBeDefined();
		}
		expect(catalog.has('file_op')).toBe(false);
	});

	test('question delegates prompts to harness interaction sequentially', async () => {
		const seen: string[] = [];
		const result = await executeTool(
			{
				id: 'question-1',
				name: 'question',
				arguments: {
					questions: [
						{
							header: 'Base',
							question: 'Which branch?',
							options: ['main', 'staging'],
						},
						{question: 'Confirm path?'},
					],
				},
				rawArguments: '',
			},
			{
				askUser: async question => {
					seen.push(question);
					return seen.length === 1 ? 'staging' : '/tmp/project';
				},
			},
		);
		expect(seen).toEqual(['[Base] Which branch?', 'Confirm path?']);
		expect(result.content).toContain('1. staging');
		expect(result.content).toContain('2. /tmp/project');
	});

	test('agent lifecycle inspection and cancellation handle missing ids cleanly', async () => {
		const status = await executeTool({
			id: 'status-1',
			name: 'agent_status',
			arguments: {agent_id: 'missing'},
			rawArguments: '',
		});
		expect(status.content).toBe('Agent missing not found.');
		const cancel = await executeTool({
			id: 'cancel-1',
			name: 'agent_cancel',
			arguments: {agent_id: 'missing'},
			rawArguments: '',
		});
		expect(cancel.content).toBe('Agent missing is not running.');
	});
});

describe('hardened core tool contracts', () => {
	test('agent spawns remain eligible for parallel read-only batches', () => {
		expect(isReadOnlyTool('agent')).toBe(true);
		expect(isParallelSafeTool('agent')).toBe(true);
		expect(isParallelSafeTool('agent_message')).toBe(false);
	});

	test('every shipped built-in tool has a description and JSON schema', () => {
		const builtins = new Set([
			'read_file',
			'apply_patch',
			'lsp',
			'question',
			'execute_bash',
			'enter_worktree',
			'exit_worktree',
			'list_worktrees',
			'remove_worktree',
			'write_file',
			'string_replace',
			'diff_edit',
			'delete_file',
			'check_skill',
			'glob',
			'grep',
			'web_search',
			'fetch_url',
			'command',
			'skill',
			'review_changes',
			'agent',
			'agent_message',
			'agent_status',
			'agent_wait',
			'agent_cancel',
			'write_tasks',
		]);
		const catalog = new Map(toolCatalog().map(tool => [tool.name, tool]));
		for (const name of builtins) {
			expect(catalog.get(name)?.description, name).toBeTruthy();
			expect(catalog.get(name)?.parameters, name).toBeDefined();
		}
	});

	test('read_file applies line windows and search tools recurse safely', async () => {
		const dir = '/tmp/bobonyo-core-contracts';
		mkdirSync(join(dir, 'folder'), {recursive: true});
		writeFileSync(join(dir, 'sample.txt'), 'one\ntwo\nthree\nfour\n');
		writeFileSync(join(dir, 'folder', 'nested.txt'), 'needle\n');
		const read = await executeTool(
			{
				id: 'read-window',
				name: 'read_file',
				arguments: {path: 'sample.txt', offset: 2, limit: 2},
				rawArguments: '',
			},
			{cwd: dir},
		);
		expect(read.content).toBe('two\nthree\n… +2 more lines');
		const globbed = await executeTool(
			{
				id: 'glob-1',
				name: 'glob',
				arguments: {pattern: '**/*.txt'},
				rawArguments: '',
			},
			{cwd: dir},
		);
		expect(globbed.content).toContain('folder/nested.txt');
		expect(globbed.content).toContain('sample.txt');
		const grepped = await executeTool(
			{
				id: 'grep-1',
				name: 'grep',
				arguments: {pattern: 'needle', file_pattern: '*.txt'},
				rawArguments: '',
			},
			{cwd: dir},
		);
		expect(grepped.content).toContain('folder/nested.txt:1:needle');
	});

	test('fetch_url rejects unsupported protocols before network access', async () => {
		const result = await executeTool({
			id: 'fetch-1',
			name: 'fetch_url',
			arguments: {url: 'file:///etc/passwd'},
			rawArguments: '',
		});
		expect(result.content).toContain('only HTTP and HTTPS');
	});
});

test('agent_wait returns settled state without polling and live messages queue', async () => {
	const {setActiveAgentRuns} = await import('./state');
	setActiveAgentRuns([
		{
			id: 'agent-settled',
			name: 'explore',
			description: 'done task',
			output: 'Finished.',
			transcript: [],
			streaming: '',
			history: [],
			status: 'completed',
		},
		{
			id: 'agent-running',
			name: 'explore',
			description: 'running task',
			output: 'Working…',
			transcript: [],
			streaming: '',
			history: [],
			status: 'running',
		},
	]);
	try {
		const waited = await executeTool({
			id: 'wait-settled',
			name: 'agent_wait',
			arguments: {agent_id: 'agent-settled'},
			rawArguments: '',
		});
		expect(waited.content).toContain('agent-settled · completed');
		const queued = await executeTool({
			id: 'message-running',
			name: 'agent_message',
			arguments: {agent_id: 'agent-running', message: 'Check the edge case.'},
			rawArguments: '',
		});
		expect(queued.content).toContain('Queued message for running agent');
	} finally {
		setActiveAgentRuns([]);
	}
});

test('subagent exhaustion has a bounded recovery finalization contract', () => {
	expect(MAX_SUBAGENT_TOOL_ROUNDS).toBeGreaterThan(6);
	expect(SUBAGENT_FINALIZATION_PROMPT).toContain('Do not call tools');
	expect(SUBAGENT_FINALIZATION_PROMPT).toContain('verified findings');
});

test('read and search tools reject symlink escapes outside workspace', async () => {
	const {rmSync, symlinkSync} = await import('node:fs');
	const dir = '/tmp/bobonyo-boundary-contracts';
	rmSync(dir, {recursive: true, force: true});
	mkdirSync(dir, {recursive: true});
	symlinkSync('/etc/passwd', join(dir, 'escaped-file'));
	symlinkSync('/etc', join(dir, 'escaped-dir'));
	const read = await executeTool(
		{
			id: 'read-escape',
			name: 'read_file',
			arguments: {path: 'escaped-file'},
			rawArguments: '',
		},
		{cwd: dir},
	);
	expect(read.content).toContain('resolves outside');
	const globbed = await executeTool(
		{
			id: 'glob-escape',
			name: 'glob',
			arguments: {path: 'escaped-dir', pattern: '**/*'},
			rawArguments: '',
		},
		{cwd: dir},
	);
	expect(globbed.content).toContain('resolves outside');
});

describe('GPT apply_patch catalog filtering', () => {
	test('matches OpenCode GPT eligibility and excludes GPT-4/OSS', () => {
		expect(modelUsesApplyPatch('gpt-5.4')).toBe(true);
		expect(modelUsesApplyPatch('gpt-5-codex')).toBe(true);
		expect(modelUsesApplyPatch('GPT-5.2')).toBe(true);
		expect(modelUsesApplyPatch('gpt-4.1')).toBe(false);
		expect(modelUsesApplyPatch('gpt-oss-120b')).toBe(false);
		expect(modelUsesApplyPatch('claude-opus-4')).toBe(false);
	});

	test('eligible GPT models see apply_patch instead of overlapping edit/write tools', () => {
		const gpt = toolCatalogForModel('gpt-5.4').map(tool => tool.name);
		expect(gpt).toContain('apply_patch');
		expect(gpt).not.toContain('edit_file');
		expect(gpt).not.toContain('write_file');
		expect(gpt).not.toContain('string_replace');
		expect(gpt).not.toContain('diff_edit');
		expect(gpt).toContain('delete_file');

		const claude = toolCatalogForModel('claude-opus-4').map(tool => tool.name);
		expect(claude).not.toContain('apply_patch');
		expect(claude).toContain('edit_file');
		expect(claude).toContain('write_file');
		expect(claude).not.toContain('string_replace');
		expect(claude).not.toContain('diff_edit');
	});

	test('apply_patch returns pre-mutation DiffView data only to the display', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'bobonyo-patch-result-'));
		writeFileSync(join(cwd, 'value.txt'), 'old\n');
		try {
			const result = await executeTool(
				{
					id: 'patch-display',
					name: 'apply_patch',
					arguments: {
						patchText:
							'*** Begin Patch\n*** Update File: value.txt\n@@\n-old\n+new\n*** End Patch',
					},
					rawArguments: '{}',
				},
				{cwd},
			);
			expect(result.content).not.toContain('_applyPatchDisplay');
			expect(result.displayArgs?._applyPatchDisplay).toEqual([
				{
					type: 'update',
					path: 'value.txt',
					rows: [
						{kind: 'remove', line: 1, text: 'old'},
						{kind: 'add', line: 1, text: 'new'},
					],
				},
			]);
		} finally {
			rmSync(cwd, {recursive: true, force: true});
		}
	});

	test('execution availability enforces the same model gate and plan safety', () => {
		expect(
			toolAvailability('apply_patch', 'full', 'yolo', 'gpt-5.4').available,
		).toBe(true);
		expect(
			toolAvailability('write_file', 'full', 'yolo', 'gpt-5.4').available,
		).toBe(false);
		expect(
			toolAvailability('apply_patch', 'full', 'yolo', 'claude-opus-4')
				.available,
		).toBe(false);
		expect(
			toolAvailability('apply_patch', 'full', 'plan', 'gpt-5.4').available,
		).toBe(false);
	});
});
