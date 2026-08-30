import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {bobonyoConfigDir, migrateProjectDir} from './bobonyo-paths';

/** Return Git top-level directory, or the nearest Bobonyo marker. */
export function projectRoot(startDir = process.cwd()): string {
	const start = resolve(startDir);
	try {
		const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
			cwd: start,
		});
		if (result.exitCode === 0) {
			const root = result.stdout.toString().trim();
			if (root) return resolve(root);
		}
	} catch {
		// Non-Git directories use marker discovery below.
	}
	let dir = start;
	for (;;) {
		if (
			existsSync(join(dir, '.bobonyo')) ||
			existsSync(join(dir, '.nanocoder'))
		)
			return dir;
		const parent = dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/** Bobonyo project config directories from nearest to farthest. */
export function projectConfigDirs(startDir = process.cwd()): string[] {
	const start = resolve(startDir);
	const dirs: string[] = [];
	let dir = start;
	for (;;) {
		migrateProjectDir(dir);
		if (existsSync(join(dir, '.bobonyo'))) dirs.push(join(dir, '.bobonyo'));
		else if (existsSync(join(dir, '.nanocoder')))
			dirs.push(join(dir, '.nanocoder'));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

/** Global config plus every project ancestor, nearest first. */
export function configSearchDirs(startDir = process.cwd()): string[] {
	return [...new Set([bobonyoConfigDir(), ...projectConfigDirs(startDir)])];
}
