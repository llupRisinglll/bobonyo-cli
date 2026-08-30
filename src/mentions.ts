import {readdirSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

const SKIP = new Set([
	'node_modules',
	'dist',
	'build',
	'.git',
	'.next',
	'.cache',
]);
const MAX_MENTION_FILE_LINES = 400;
const MAX_MENTION_FILE_CHARS = 50_000;
const MAX_MENTION_DIR_ENTRIES = 1000;
const MAX_MENTION_CONTEXT_CHARS = 100_000;

function withinWorkspace(path: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), resolve(path));
	return (
		rel === '' ||
		(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

/** Walk project for `@` mention candidates. Directories are selectable too. */
export function listProjectFiles(
	cwd = process.cwd(),
	maxDepth = 3,
	limit = 300,
): string[] {
	const paths: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth || paths.length >= limit) return;
		let entries;
		try {
			entries = readdirSync(dir, {withFileTypes: true}).sort((left, right) => {
				if (left.isDirectory() !== right.isDirectory())
					return left.isDirectory() ? -1 : 1;
				return left.name.localeCompare(right.name);
			});
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (paths.length < limit) paths.push(full);
				walk(full, depth + 1);
			} else if (paths.length < limit) paths.push(full);
			if (paths.length >= limit) return;
		}
	};
	walk(cwd, 0);
	return paths;
}

/** Relative suggestion label/insertion text, with `/` marking directories. */
export function mentionPathText(path: string, cwd = process.cwd()): string {
	const rel = withinWorkspace(path, cwd) ? relative(cwd, path) || '.' : path;
	try {
		return statSync(path).isDirectory() ? `${rel.replaceAll('\\', '/')}/` : rel;
	} catch {
		return rel;
	}
}

/** The active mention token after last `@`, up to cursor/space. */
export function mentionToken(
	input: string,
	cursor = input.length,
): string | null {
	const at = input.lastIndexOf('@', cursor - 1);
	if (at === -1) return null;
	const before = input.slice(0, at);
	const after = input.slice(at + 1, cursor);
	if (
		(before.length > 0 && !/\s/.test(before.at(-1)!)) ||
		before.trimStart().startsWith('/')
	)
		return null;
	if (
		/\s/.test(after) &&
		!(after.startsWith('"') && !after.slice(1).includes('"'))
	)
		return null;
	return after;
}

/** Path-only query used while a `#L7-9` suffix is being typed. */
export function mentionSearchToken(token: string): string {
	return token.replace(/^"/, '').replace(/"?(?:#L\d*(?:-\d*)?)?$/i, '');
}

/** Quote paths containing spaces so extraction remains unambiguous. */
export function mentionInsertionText(path: string): string {
	return /\s/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path;
}

/** Insert `path` at `@token`, replacing token. */
export function insertMention(
	input: string,
	path: string,
	token: string,
	cursor = input.length,
): string {
	const at = input.lastIndexOf('@', cursor - 1);
	if (at < 0) return input;
	const suffix = /(#L\d+(?:-\d+)?)$/i.exec(token)?.[1] ?? '';
	const inserted = `${mentionInsertionText(path)}${suffix}`;
	return input.slice(0, at + 1) + inserted + ' ' + input.slice(cursor);
}

export interface MentionReference {
	path: string;
	lineStart?: number;
	lineEnd?: number;
}

/** Parse `path`, `path#L7`, and inclusive `path#L7-9` references. */
export function parseMentionReference(mention: string): MentionReference {
	const match = /^(.+?)(?:#L(\d+)(?:-(\d+))?)?$/.exec(mention);
	if (!match) return {path: mention};
	const lineStart = match[2] ? Math.max(1, Number(match[2])) : undefined;
	const requestedEnd = match[3] ? Math.max(1, Number(match[3])) : lineStart;
	return {
		path: match[1] ?? mention,
		...(lineStart
			? {lineStart, lineEnd: Math.max(lineStart, requestedEnd ?? lineStart)}
			: {}),
	};
}

/** Extract quoted or whitespace-delimited file/directory mentions. */
export function extractMentionReferences(input: string): MentionReference[] {
	const references: MentionReference[] = [];
	const seen = new Set<string>();
	for (const match of input.matchAll(
		/(^|\s)@(?:"((?:\\.|[^"\n])+)"|([^\s#]+))((?:#L\d+(?:-\d+)?)?)/gi,
	)) {
		const quoted = match[2]?.replace(/\\"/g, '"');
		const rawPath = quoted ?? (match[3] ?? '').replace(/[),.;:!?]+$/, '');
		const raw = `${rawPath}${match[4] ?? ''}`;
		if (!raw || seen.has(raw)) continue;
		seen.add(raw);
		references.push(parseMentionReference(raw));
	}
	return references;
}

function attribute(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return (rel || '.').replaceAll('\\', '/');
}

function resolveMentionPath(requested: string, cwd: string): string | null {
	const absolute = resolve(cwd, requested.replace(/\/$/, ''));
	if (!withinWorkspace(absolute, cwd)) return null;
	try {
		const real = realpathSync(absolute);
		return withinWorkspace(real, realpathSync(cwd)) ? absolute : null;
	} catch {
		return null;
	}
}

function directoryContext(path: string, cwd: string): string {
	const entries = readdirSync(path, {withFileTypes: true})
		.filter(entry => !entry.name.startsWith('.') && !SKIP.has(entry.name))
		.sort((left, right) => {
			if (left.isDirectory() !== right.isDirectory())
				return left.isDirectory() ? -1 : 1;
			return left.name.localeCompare(right.name);
		});
	const visible = entries
		.slice(0, MAX_MENTION_DIR_ENTRIES)
		.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
	if (entries.length > visible.length)
		visible.push(`… and ${entries.length - visible.length} more entries`);
	const name = displayPath(path, cwd);
	return `<directory path="${attribute(name)}">\n${visible.join('\n')}\n</directory>`;
}

function fileContext(
	path: string,
	cwd: string,
	lineStart?: number,
	lineEnd?: number,
): string {
	const stat = statSync(path);
	if (stat.size > 10 * 1024 * 1024) return '';
	const source = readFileSync(path, 'utf8');
	if (source.includes('\u0000')) return '';
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const start = Math.max(1, lineStart ?? 1);
	const requestedEnd = Math.max(
		start,
		lineEnd ?? start + MAX_MENTION_FILE_LINES - 1,
	);
	const end = Math.min(
		lines.length,
		requestedEnd,
		start + MAX_MENTION_FILE_LINES - 1,
	);
	let body = lines
		.slice(start - 1, end)
		.map((line, index) => `${start + index}: ${line}`)
		.join('\n');
	let truncated = requestedEnd > end || (!lineStart && lines.length > end);
	if (body.length > MAX_MENTION_FILE_CHARS) {
		body = body.slice(0, MAX_MENTION_FILE_CHARS);
		truncated = true;
	}
	if (truncated) body += '\n… [mention content truncated]';
	const name = displayPath(path, cwd);
	return `<file path="${attribute(name)}" lines="${start}-${end}">\n${body}\n</file>`;
}

/** Build bounded local context for valid workspace `@` mentions. */
export function buildMentionContext(
	input: string,
	cwd = process.cwd(),
): string {
	const blocks: string[] = [];
	let chars = 0;
	for (const reference of extractMentionReferences(input)) {
		const path = resolveMentionPath(reference.path, cwd);
		if (!path) continue;
		let block = '';
		try {
			block = statSync(path).isDirectory()
				? directoryContext(path, cwd)
				: fileContext(path, cwd, reference.lineStart, reference.lineEnd);
		} catch {
			continue;
		}
		if (!block) continue;
		const remaining = MAX_MENTION_CONTEXT_CHARS - chars;
		if (remaining <= 0) break;
		if (block.length > remaining)
			block = `${block.slice(0, remaining)}\n… [mention context truncated]`;
		blocks.push(block);
		chars += block.length;
	}
	return blocks.length > 0
		? `\n\n<mentioned-context>\n${blocks.join('\n')}\n</mentioned-context>`
		: '';
}
