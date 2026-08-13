import {cpSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

/**
 * BOBONYO storage paths. The rewrite now owns its own directories
 * (`~/.config/bobonyo`, `~/.local/share/bobonyo`) instead of the legacy
 * nanocoder ones; on first run the old nanocoder dirs are COPIED over so
 * providers, sessions and preferences survive the rename. The legacy
 * `NANOCODER_*` env vars still work as fallbacks.
 */

function migrateLegacy(source: string, target: string): void {
	try {
		if (!existsSync(target) && existsSync(source)) {
			cpSync(source, target, {recursive: true});
		}
	} catch {
		// Migration failure: keep going with the (empty) bobonyo dir rather
		// than crashing startup.
	}
}

export function bobonyoConfigDir(): string {
	const env =
		process.env.BOBONYO_CONFIG_DIR ??
		process.env.NANOCODER_CONFIG_DIR;
	if (env) return env;
	if (process.env.XDG_CONFIG_HOME) {
		const target = join(process.env.XDG_CONFIG_HOME, 'bobonyo');
		migrateLegacy(join(process.env.XDG_CONFIG_HOME, 'nanocoder'), target);
		return target;
	}
	const target = join(homedir(), '.config', 'bobonyo');
	migrateLegacy(join(homedir(), '.config', 'nanocoder'), target);
	return target;
}

export function bobonyoDataDir(): string {
	const env =
		process.env.BOBONYO_DATA_DIR ??
		process.env.NANOCODER_DATA_DIR;
	if (env) return env;
	if (process.env.XDG_DATA_HOME) {
		const target = join(process.env.XDG_DATA_HOME, 'bobonyo');
		migrateLegacy(join(process.env.XDG_DATA_HOME, 'nanocoder'), target);
		return target;
	}
	const target = join(homedir(), '.local', 'share', 'bobonyo');
	migrateLegacy(join(homedir(), '.local', 'share', 'nanocoder'), target);
	return target;
}

/** Project roots already checked for migration (no repeated walk-ups). */
const migratedProjects = new Set<string>();

/**
 * Migrate PROJECT-level configs: walk UP from `startDir` and, wherever a
 * legacy `.nanocoder` folder exists without a `.bobonyo` sibling, copy it
 * over (idempotent, non-destructive — the legacy folder stays as a
 * fallback). This is what moves e.g. Hilinga's agents/commands/skills into
 * bobonyo-owned project folders automatically.
 */
export function migrateProjectDir(startDir: string): void {
	let dir = startDir;
	for (;;) {
		if (migratedProjects.has(dir)) break;
		migratedProjects.add(dir);
		try {
			const source = join(dir, '.nanocoder');
			const target = join(dir, '.bobonyo');
			if (!existsSync(target) && existsSync(source)) {
				cpSync(source, target, {recursive: true});
			}
		} catch {
			// read-only / permission issue: keep going with the fallback.
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
