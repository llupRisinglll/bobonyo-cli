import {describe, expect, test} from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
	displayToolName,
	executeTool,
	isReadOnlyTool,
	requiresApproval,
	toolCatalog,
} from './tools';
import {
	beginFileUndoExchange,
	resetFileUndoStack,
	undoFileExchange,
} from './file-undo';

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
			{},
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
			{},
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
			{},
		);
		expect(dir.content).toMatch(/directory/i);
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
				{},
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
