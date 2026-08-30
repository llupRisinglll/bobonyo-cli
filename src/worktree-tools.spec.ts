import {describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {enterWorktree, exitWorktree, worktreeEntries} from './worktree-tools';

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), 'bobonyo-worktree-'));
	Bun.spawnSync(['git', 'init', '-q'], {cwd: root});
	Bun.spawnSync(['git', 'config', 'user.email', 'spec@example.com'], {
		cwd: root,
	});
	Bun.spawnSync(['git', 'config', 'user.name', 'Spec'], {cwd: root});
	writeFileSync(join(root, 'README.md'), 'root\n');
	Bun.spawnSync(['git', 'add', 'README.md'], {cwd: root});
	Bun.spawnSync(['git', 'commit', '-qm', 'initial'], {cwd: root});
	return root;
}
describe.serial('worktree lifecycle tools', () => {
	test('creates an isolated worktree and exits without deleting it', () => {
		const root = repository();
		try {
			const entered = enterWorktree(root, {name: 'fix/tool-gap'});
			expect(entered.content).toContain('Created and entered worktree');
			expect(entered.cwd).toContain('.bobonyo/worktrees/fix-tool-gap');
			expect(worktreeEntries(root).map(entry => entry.branch)).toContain(
				'fix/tool-gap',
			);
			const exited = exitWorktree(entered.cwd!);
			expect(exited.cwd).toBe(root);
			expect(exited.content).toContain('Exited to main worktree');
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('rejects unsafe names and unregistered existing directories', () => {
		const root = repository();
		try {
			expect(enterWorktree(root, {name: '../escape'}).content).toContain(
				'safe',
			);
			const ordinary = join(root, 'ordinary-directory');
			mkdirSync(ordinary);
			expect(enterWorktree(root, {path: ordinary}).content).toContain(
				'not a registered git worktree',
			);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});
});

describe.serial('worktree lifecycle safety', () => {
	test('inspect reports clean state and removal refuses dirty or unmerged worktrees', async () => {
		const {inspectWorktrees, removeWorktree} = await import('./worktree-tools');
		const root = repository();
		try {
			const entered = enterWorktree(root, {name: 'feature/unmerged'});
			expect(inspectWorktrees(root).content).toContain('clean');
			writeFileSync(join(entered.cwd!, 'dirty.txt'), 'dirty\n');
			expect(removeWorktree(root, {path: entered.cwd}).content).toContain(
				'uncommitted changes',
			);
			Bun.spawnSync(['git', 'add', 'dirty.txt'], {cwd: entered.cwd});
			Bun.spawnSync(['git', 'commit', '-qm', 'feature'], {cwd: entered.cwd});
			expect(removeWorktree(root, {path: entered.cwd}).content).toContain(
				'not merged',
			);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('removes a clean merged worktree and optionally its branch', async () => {
		const {removeWorktree, worktreeEntries} = await import('./worktree-tools');
		const root = repository();
		try {
			const entered = enterWorktree(root, {name: 'merged-clean'});
			writeFileSync(join(entered.cwd!, 'merged.txt'), 'merged\n');
			Bun.spawnSync(['git', 'add', 'merged.txt'], {cwd: entered.cwd});
			Bun.spawnSync(['git', 'commit', '-qm', 'merged change'], {
				cwd: entered.cwd,
			});
			Bun.spawnSync(['git', 'merge', '--no-edit', 'merged-clean'], {cwd: root});
			const removed = removeWorktree(root, {
				path: entered.cwd,
				deleteBranch: true,
			});
			expect(removed.content).toContain('Removed worktree');
			expect(removed.content).toContain('Deleted merged branch merged-clean');
			expect(
				worktreeEntries(root).some(entry => entry.branch === 'merged-clean'),
			).toBe(false);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});
});
