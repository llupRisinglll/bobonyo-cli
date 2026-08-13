import {cpSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

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
