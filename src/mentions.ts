import {readdirSync} from 'node:fs';
import {join} from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.cache']);

/** Walk the project for `@` mention candidates (bounded depth + count). */
export function listProjectFiles(
	cwd = process.cwd(),
	maxDepth = 3,
	limit = 300,
): string[] {
	const files: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth || files.length >= limit) return;
		let entries;
		try {
			entries = readdirSync(dir, {withFileTypes: true});
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (files.length < limit) files.push(full);
		}
	};
	walk(cwd, 0);
	return files;
}

/** The mention token after the LAST `@` (up to a space). */
export function mentionToken(input: string): string | null {
	const at = input.lastIndexOf('@');
	if (at === -1) return null;
	const after = input.slice(at + 1);
	const token = after.split(/\s/)[0] ?? '';
	// Don't suggest inside a `/` command (e.g. `/mock:@x`).
	if (input.slice(0, at).trimStart().startsWith('/')) return null;
	return token;
}

/** Insert `path` at the `@token` position, replacing the token. */
export function insertMention(
	input: string,
	path: string,
	token: string,
): string {
	const at = input.lastIndexOf('@');
	return input.slice(0, at + 1) + path + ' ' + input.slice(at + 1 + token.length);
}
