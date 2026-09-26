import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {resolveRulesFile} from './rules-file';

let context: {root: string; rulesPath: string} | undefined;

/** Pin ownership before resume or worktree navigation changes cwd. */
export function initializeProjectContext(cwd: string): void {
	const rulesPath = resolveRulesFile(cwd);
	context = {
		root: rulesPath ? dirname(rulesPath) : resolve(cwd),
		rulesPath: rulesPath ?? join(resolve(cwd), 'AGENTS.md'),
	};
}

/** Reload launch rules for every provider prompt, including after compaction. */
export function projectContextPrompt(): string {
	if (!context) return '';
	const {root, rulesPath} = context;
	let rules: string;
	try {
		rules = readFileSync(rulesPath, 'utf8');
	} catch {
		rules =
			'Launch AGENTS.md is unavailable. Report this before project changes; do not silently substitute another project’s rules.';
	}
	return `\n\n## LAUNCH PROJECT\nProject configuration root: ${root}\nCreate project skills, hooks, agents, commands, and other BoboNyo configuration under ${join(root, '.bobonyo')}, unless the user explicitly selects another project. Changing cwd or entering a worktree does not change this ownership.\nLaunch AGENTS.md: ${rulesPath}\nThese freshly read rules remain active after compaction. A summary or additional working-directory rules do not replace them.\n${rules}`;
}
