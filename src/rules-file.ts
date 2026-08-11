import {dirname, join} from 'node:path';
import {existsSync} from 'node:fs';

/**
 * Resolve the project RULES file (AGENTS.md) the way Codex does: the nearest
 * AGENTS.md walking UP from the working directory (cwd wins over ancestors).
 * Pure + unit-tested; the CLIENT embeds this file in the system prompt and
 * `/status` reports exactly which file was resolved, so a developer always
 * knows what rules the model is actually running under.
 */
export function resolveRulesFile(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		const candidate = join(dir, 'AGENTS.md');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
