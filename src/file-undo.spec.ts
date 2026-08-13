import {afterEach, describe, expect, test} from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
	beginFileUndoExchange,
	fileUndoDepth,
	mutationTargetPaths,
	resetFileUndoStack,
	snapshotFileBeforeMutation,
	undoFileExchange,
} from './file-undo';

const tempDirs: string[] = [];

describe('file undo (openclaude-rewind parity)', () => {
	afterEach(() => {
		resetFileUndoStack();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	test('undo restores the content an edit overwrote', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bobonyo-undo-'));
		tempDirs.push(dir);
		const path = join(dir, 'app.ts');
		writeFileSync(path, 'const a = 1;\n');
		beginFileUndoExchange('update app.ts');
		snapshotFileBeforeMutation(path);
		writeFileSync(path, 'const a = 2;\n');

		const result = undoFileExchange();
		expect(result?.prompt).toBe('update app.ts');
		expect(result?.restored).toContain(path);
		expect(readFileSync(path, 'utf8')).toBe('const a = 1;\n');
	});

	test('undo removes files that did not exist before the exchange', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bobonyo-undo-'));
		tempDirs.push(dir);
		const path = join(dir, 'new.txt');
		beginFileUndoExchange('create new.txt');
		snapshotFileBeforeMutation(path);
		writeFileSync(path, 'created');

		undoFileExchange();
		expect(existsSync(path)).toBe(false);
	});

	test('later writes in the same exchange keep the ORIGINAL pre-turn content', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bobonyo-undo-'));
		tempDirs.push(dir);
		const path = join(dir, 'a.txt');
		writeFileSync(path, 'v1');
		beginFileUndoExchange('touch a.txt');
		snapshotFileBeforeMutation(path);
		writeFileSync(path, 'v2');
		// A SECOND mutation in the same exchange must not re-snapshot — the
		// undo restores v1, not v2.
		snapshotFileBeforeMutation(path);
		writeFileSync(path, 'v3');

		undoFileExchange();
		expect(readFileSync(path, 'utf8')).toBe('v1');
		expect(fileUndoDepth()).toBe(0);
	});

	test('mutationTargetPaths maps the file tools', () => {
		expect(
			mutationTargetPaths('write_file', {path: 'x.ts'}),
		).toEqual(['x.ts']);
		expect(
			mutationTargetPaths('delete_file', {path: 'x.ts'}),
		).toEqual(['x.ts']);
		expect(
			mutationTargetPaths('file_op', {op: 'move', path: 'a', target: 'b'}),
		).toEqual(['a', 'b']);
		expect(mutationTargetPaths('execute_bash', {command: 'rm x'})).toEqual(
			[],
		);
	});

	test('diff_edit extracts paths from the unified diff headers', () => {
		const diff = '--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new\n';
		const paths = mutationTargetPaths('diff_edit', {
			diff,
			cwd: '/repo',
		});
		expect(paths).toContain('/repo/src/new.ts');
	});
});
