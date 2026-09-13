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
	applyChunks,
	executeApplyPatch,
	parseApplyPatch,
	planApplyPatch,
} from './apply-patch';

let root = '';
function workspace(): string {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-apply-patch-'));
	return root;
}
afterEach(() => {
	if (root) rmSync(root, {recursive: true, force: true});
	root = '';
});

describe('GPT apply_patch parser and executor', () => {
	test('adds, updates, moves, and deletes files in one verified patch', () => {
		const cwd = workspace();
		writeFileSync(join(cwd, 'update.txt'), 'one\ntwo\nthree\n');
		writeFileSync(join(cwd, 'move.txt'), 'old\n');
		writeFileSync(join(cwd, 'delete.txt'), 'gone\n');
		const patch = `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Update File: update.txt
@@
 one
-two
+changed
 three
*** Update File: move.txt
*** Move to: renamed/moved.txt
@@
-old
+new
*** Delete File: delete.txt
*** End Patch`;
		const planned = planApplyPatch(cwd, patch);
		expect(planned.map(change => change.type)).toEqual([
			'add',
			'update',
			'move',
			'delete',
		]);
		const output = executeApplyPatch(cwd, patch);
		expect(output).toContain('Applied patch successfully.');
		expect(readFileSync(join(cwd, 'nested/new.txt'), 'utf8')).toBe('created\n');
		expect(readFileSync(join(cwd, 'update.txt'), 'utf8')).toBe(
			'one\nchanged\nthree\n',
		);
		expect(readFileSync(join(cwd, 'renamed/moved.txt'), 'utf8')).toBe('new\n');
		expect(existsSync(join(cwd, 'move.txt'))).toBe(false);
		expect(existsSync(join(cwd, 'delete.txt'))).toBe(false);
	});

	test('verifies every hunk before writing any file', () => {
		const cwd = workspace();
		writeFileSync(join(cwd, 'first.txt'), 'before\n');
		writeFileSync(join(cwd, 'second.txt'), 'actual\n');
		const patch = `*** Begin Patch
*** Update File: first.txt
@@
-before
+after
*** Update File: second.txt
@@
-missing
+changed
*** End Patch`;
		expect(() => executeApplyPatch(cwd, patch)).toThrow(
			/failed to find expected/,
		);
		expect(readFileSync(join(cwd, 'first.txt'), 'utf8')).toBe('before\n');
		expect(readFileSync(join(cwd, 'second.txt'), 'utf8')).toBe('actual\n');
	});

	test('rejects malformed, empty, duplicate, absolute, and escaping patches', () => {
		const cwd = workspace();
		expect(() => parseApplyPatch('*** Begin Patch\n*** End Patch')).toThrow(
			/empty patch/,
		);
		expect(() =>
			planApplyPatch(
				cwd,
				'*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch',
			),
		).toThrow(/escapes workspace/);
		expect(() =>
			planApplyPatch(
				cwd,
				'*** Begin Patch\n*** Add File: /tmp/absolute.txt\n+x\n*** End Patch',
			),
		).toThrow(/invalid patch path/);
		expect(() =>
			planApplyPatch(
				cwd,
				'*** Begin Patch\n*** Add File: same.txt\n+x\n*** Add File: same.txt\n+y\n*** End Patch',
			),
		).toThrow(/more than once/);
	});

	test('parses the explicit End of File marker', () => {
		const hunks = parseApplyPatch(
			'*** Begin Patch\n*** Update File: sample.txt\n@@\n-last\n+final\n*** End of File\n*** End Patch',
		);
		expect(hunks[0]).toMatchObject({
			type: 'update',
			chunks: [{endOfFile: true, oldLines: ['last'], newLines: ['final']}],
		});
	});

	test('supports context anchors, EOF anchors, and whitespace-tolerant matching', () => {
		const original = 'function a() {\n  return 1;  \n}\nlast\n';
		const updated = applyChunks(
			'sample.ts',
			[
				{
					context: 'function a() {',
					oldLines: ['  return 1;'],
					newLines: ['  return 2;'],
				},
				{
					oldLines: ['last'],
					newLines: ['final'],
					endOfFile: true,
				},
			],
			original,
		);
		expect(updated).toBe('function a() {\n  return 2;\n}\nfinal\n');
	});

	test('rejects collapsed one-line TSX additions before writing any file', () => {
		const cwd = workspace();
		writeFileSync(join(cwd, 'first.txt'), 'before\n');
		writeFileSync(join(cwd, 'component.tsx'), 'export const Existing = 1;\n');
		const collapsed =
			"export const Existing=()=>{return <box><text>new</text><text>{['alpha','beta','gamma','delta'].map(value=><span>{value}</span>)}</text><text>more content makes this malformed addition unmistakably huge</text></box>}";
		const patch = `*** Begin Patch
*** Update File: first.txt
@@
-before
+after
*** Update File: component.tsx
@@
-export const Existing = 1;
+${collapsed}
*** End Patch`;
		expect(() => executeApplyPatch(cwd, patch)).toThrow(
			/collapsed code.*Retry with proper indentation and line breaks/,
		);
		expect(readFileSync(join(cwd, 'first.txt'), 'utf8')).toBe('before\n');
		expect(readFileSync(join(cwd, 'component.tsx'), 'utf8')).toBe(
			'export const Existing = 1;\n',
		);
	});

	test('preserves long non-code additions and existing formatting exactly', () => {
		const cwd = workspace();
		const existing = 'const legacy={bad:true}\n';
		writeFileSync(join(cwd, 'component.ts'), existing);
		const longString = 'x'.repeat(220);
		executeApplyPatch(
			cwd,
			`*** Begin Patch
*** Update File: component.ts
@@
 const legacy={bad:true}
+export const message = '${longString}';
*** End Patch`,
		);
		expect(readFileSync(join(cwd, 'component.ts'), 'utf8')).toBe(
			`${existing}export const message = '${longString}';\n`,
		);
	});
});

test('apply_patch tool snapshots every affected path for undo', async () => {
	const {executeTool} = await import('./tools');
	const {beginFileUndoExchange, resetFileUndoStack, undoFileExchange} =
		await import('./file-undo');
	const cwd = workspace();
	writeFileSync(join(cwd, 'existing.txt'), 'before\n');
	beginFileUndoExchange('patch files');
	try {
		const result = await executeTool(
			{
				id: 'patch-undo',
				name: 'apply_patch',
				arguments: {
					patchText:
						'*** Begin Patch\n*** Update File: existing.txt\n@@\n-before\n+after\n*** Add File: created.txt\n+created\n*** End Patch',
				},
				rawArguments: '',
			},
			{cwd},
		);
		expect(result.content).toContain('Applied patch successfully');
		expect(readFileSync(join(cwd, 'existing.txt'), 'utf8')).toBe('after\n');
		expect(existsSync(join(cwd, 'created.txt'))).toBe(true);
		undoFileExchange();
		expect(readFileSync(join(cwd, 'existing.txt'), 'utf8')).toBe('before\n');
		expect(existsSync(join(cwd, 'created.txt'))).toBe(false);
	} finally {
		resetFileUndoStack();
	}
});
