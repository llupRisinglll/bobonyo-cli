import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

describe('release launcher supervisor (isolated fake-child PTY)', () => {
	test('build ships the executable supervisor template', () => {
		const directory = mkdtempSync(join(tmpdir(), 'bobonyo-build-'));
		try {
			symlinkSync(
				join(import.meta.dir, '../node_modules'),
				join(directory, 'node_modules'),
				'dir',
			);
			const result = spawnSync(
				process.execPath,
				[join(import.meta.dir, '../scripts/build.mjs')],
				{cwd: directory, encoding: 'utf8', timeout: 12_000},
			);
			expect(result.error).toBeUndefined();
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
			const launcher = join(directory, 'dist/bobonyo');
			expect(readFileSync(launcher, 'utf8')).toBe(
				readFileSync(join(import.meta.dir, '../scripts/launcher.sh'), 'utf8'),
			);
			expect(statSync(launcher).mode & 0o777).toBe(0o755);
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	}, 15_000);

	for (const scenario of [
		'kill',
		'exit',
		'success',
		'signal-HUP',
		'signal-INT',
		'signal-QUIT',
		'signal-TERM',
		'group-term',
		'default-HUP',
		'default-INT',
		'default-QUIT',
		'default-TERM',
		'redirect-output',
		'redirect-input',
		'pipes',
	]) {
		test(
			scenario,
			() => {
				const result = spawnSync(
					'python3',
					[join(import.meta.dir, '../scripts/launcher-pty-test.py'), scenario],
					{encoding: 'utf8', timeout: 12_000},
				);
				expect(result.error).toBeUndefined();
				expect(result.stderr).toBe('');
				expect(result.status).toBe(0);
			},
			15_000,
		);
	}
});
