import {describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
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
