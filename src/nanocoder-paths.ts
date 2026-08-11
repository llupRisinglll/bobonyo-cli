import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * NANOCODER storage paths (parity with nanocoder's `source/config/paths.ts`).
 * bobonyo still READS/WRITES the nanocoder config + sessions, the rename
 * happens once the rewrite is stable.
 */
export function nanocoderConfigDir(): string {
	if (process.env.NANOCODER_CONFIG_DIR) return process.env.NANOCODER_CONFIG_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'nanocoder');
	return join(homedir(), '.config', 'nanocoder');
}

export function nanocoderDataDir(): string {
	if (process.env.NANOCODER_DATA_DIR) return process.env.NANOCODER_DATA_DIR;
	if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'nanocoder');
	return join(homedir(), '.local', 'share', 'nanocoder');
}
