import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverWorkingDirectory} from './cwd-recovery';

test('deleted worktree automatically returns to launch directory', () => {
	const original = process.cwd();
	const root = mkdtempSync(join(tmpdir(), 'cwd-repair-'));
	try {
		const child = join(root, 'worktree');
		mkdirSync(child);
		process.chdir(child);
		expect(recoverWorkingDirectory(child, root)).toBeUndefined();
		rmSync(child, {recursive: true});
		expect(recoverWorkingDirectory(child, root)).toBe(root);
		expect(process.cwd()).toBe(root);
		expect(() => recoverWorkingDirectory(child, join(root, 'missing'))).toThrow(
			'launch workspace',
		);
	} finally {
		process.chdir(original);
		rmSync(root, {recursive: true, force: true});
	}
});
