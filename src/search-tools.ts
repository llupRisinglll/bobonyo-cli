import {lstatSync, readdirSync, realpathSync, readFileSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';

const DEFAULT_SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

export interface WorkspaceEntry {
	path: string;
	isDirectory: boolean;
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return (
		rel === '' ||
		(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
	);
}

/** Walk workspace without following symlinks or escaping root. */
export function workspaceEntries(
	cwd: string,
	base = '.',
	includeHidden = false,
): WorkspaceEntry[] {
	const root = realpathSync(resolve(cwd));
	const start = realpathSync(resolve(cwd, base));
	if (!inside(root, start))
		throw new Error(`${base} resolves outside workspace`);
	const out: WorkspaceEntry[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, {withFileTypes: true})) {
			if (!includeHidden && entry.name.startsWith('.')) continue;
			if (entry.isDirectory() && DEFAULT_SKIPPED_DIRS.has(entry.name)) continue;
			const absolute = resolve(directory, entry.name);
			const stat = lstatSync(absolute);
			if (stat.isSymbolicLink()) continue;
			const rel = relative(root, absolute).split(sep).join('/');
			out.push({path: rel, isDirectory: stat.isDirectory()});
			if (stat.isDirectory()) visit(absolute);
		}
	};
	visit(start);
	return out;
}

function globMatches(pattern: string, path: string): boolean {
	const glob = new Bun.Glob(pattern);
	return (
		glob.match(path) ||
		(!pattern.includes('/') && glob.match(path.split('/').at(-1) ?? path))
	);
}

export function globWorkspace(options: {
	cwd: string;
	pattern: string;
	path?: string;
	includeHidden?: boolean;
	includeDirectories?: boolean;
	limit?: number;
}): string {
	const limit = Math.max(1, Math.min(5000, Math.floor(options.limit ?? 500)));
	const matches = workspaceEntries(
		options.cwd,
		options.path,
		options.includeHidden,
	)
		.filter(entry => options.includeDirectories || !entry.isDirectory)
		.filter(entry => globMatches(options.pattern, entry.path))
		.map(entry => `${entry.path}${entry.isDirectory ? '/' : ''}`)
		.sort((a, b) => a.localeCompare(b));
	const shown = matches.slice(0, limit);
	return shown.length === 0
		? 'No matches.'
		: `${shown.join('\n')}${matches.length > shown.length ? `\n… +${matches.length - shown.length} more matches` : ''}`;
}

export function grepWorkspace(options: {
	cwd: string;
	pattern: string;
	path?: string;
	filePattern?: string;
	includeHidden?: boolean;
	literal?: boolean;
	caseSensitive?: boolean;
	context?: number;
	limit?: number;
}): string {
	const limit = Math.max(1, Math.min(5000, Math.floor(options.limit ?? 200)));
	const context = Math.max(0, Math.min(10, Math.floor(options.context ?? 0)));
	let regex: RegExp;
	try {
		const source = options.literal
			? options.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			: options.pattern;
		regex = new RegExp(source, options.caseSensitive ? '' : 'i');
	} catch (error) {
		throw new Error(
			`invalid search pattern: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const lines: string[] = [];
	let total = 0;
	for (const entry of workspaceEntries(
		options.cwd,
		options.path,
		options.includeHidden,
	)) {
		if (entry.isDirectory) continue;
		if (options.filePattern && !globMatches(options.filePattern, entry.path))
			continue;
		const absolute = resolve(options.cwd, entry.path);
		if (lstatSync(absolute).size > MAX_SEARCH_FILE_BYTES) continue;
		const content = readFileSync(absolute);
		if (content.includes(0)) continue;
		const fileLines = content
			.toString('utf8')
			.replace(/\r\n/g, '\n')
			.split('\n');
		for (let index = 0; index < fileLines.length; index++) {
			if (!regex.test(fileLines[index] ?? '')) continue;
			total += 1;
			if (lines.length >= limit) continue;
			const from = Math.max(0, index - context);
			const to = Math.min(fileLines.length - 1, index + context);
			for (let line = from; line <= to; line++) {
				lines.push(
					`${entry.path}:${line + 1}:${line === index ? '' : '-'}${fileLines[line] ?? ''}`,
				);
			}
		}
	}
	if (total === 0) return 'No matches.';
	return `${lines.slice(0, limit).join('\n')}${total > limit ? `\n… +${total - limit} more matches` : ''}`;
}
