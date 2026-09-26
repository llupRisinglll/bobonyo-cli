import {describe, expect, spyOn, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bashCwdFailure, runBash} from './bash';
import * as sandbox from './sandbox';

describe('Bash deleted working directory', () => {
	test('refuses without spawning or silently switching to launch workspace', async () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-bash-cwd-'));
		const cwd = join(root, 'deleted');
		mkdirSync(cwd);
		rmdirSync(cwd);
		const spawn = spyOn(Bun, 'spawn');
		const changes: string[] = [];
		try {
			const result = await runBash(
				'printf unsafe > relative-file',
				undefined,
				undefined,
				cwd,
				next => changes.push(next),
				'user',
				root,
			);
			expect(spawn).not.toHaveBeenCalled();
			expect(result.content).toContain('Command was not executed');
			expect(result.content).toContain('no fallback directory was used');
			expect(result.content).toContain(JSON.stringify(root));
			expect(result.cwd).toBeUndefined();
			expect(changes).toEqual([]);
		} finally {
			spawn.mockRestore();
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('handles process.cwd failure before default argument evaluation', async () => {
		const root = process.cwd();
		const cwd = spyOn(process, 'cwd').mockImplementation(() => {
			throw Object.assign(new Error('getcwd ENOENT'), {code: 'ENOENT'});
		});
		try {
			const result = await runBash(
				'pwd',
				undefined,
				undefined,
				undefined,
				undefined,
				'user',
				root,
			);
			expect(result.content).toContain('working directory (unavailable)');
			expect(result.content).toContain(JSON.stringify(root));
		} finally {
			cwd.mockRestore();
		}
	});

	test('does not recommend a missing launch workspace', () => {
		const root = mkdtempSync(join(tmpdir(), 'bobonyo-bash-cwd-'));
		rmdirSync(root);
		expect(bashCwdFailure(root, root)?.content).toContain(
			'Restart BoboNyo from an existing workspace directory.',
		);
	});

	for (const removeBeforeSpawn of [false, true]) {
		test(
			removeBeforeSpawn
				? 'diagnoses cwd deleted between preflight and spawn'
				: 'preserves missing executable ENOENT when cwd exists',
			async () => {
				const root = mkdtempSync(join(tmpdir(), 'bobonyo-bash-cwd-'));
				const cwd = join(root, 'cwd');
				mkdirSync(cwd);
				const error = Object.assign(new Error('ENOENT posix_spawn bash'), {
					code: 'ENOENT',
				});
				const build = spyOn(sandbox, 'buildSandboxCommand').mockReturnValue({
					argv: ['bash', '-c', 'pwd'],
					active: false,
					backend: 'none',
				});
				const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
					if (removeBeforeSpawn) rmdirSync(cwd);
					throw error;
				});
				try {
					const result = runBash(
						'pwd',
						undefined,
						undefined,
						cwd,
						undefined,
						'user',
						root,
					);
					if (removeBeforeSpawn) {
						expect((await result).content).toContain(
							'Command was not executed',
						);
					} else {
						await expect(result).rejects.toBe(error);
					}
				} finally {
					spawn.mockRestore();
					build.mockRestore();
					rmSync(root, {recursive: true, force: true});
				}
			},
		);
	}
});
