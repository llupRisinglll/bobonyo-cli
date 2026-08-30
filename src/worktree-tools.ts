import {existsSync, mkdirSync, realpathSync} from 'node:fs';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from 'node:path';

export interface WorktreeCommandResult {
	content: string;
	cwd?: string;
}

function git(cwd: string, args: string[]): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync(['git', ...args], {cwd});
}

function output(result: ReturnType<typeof Bun.spawnSync>): string {
	return [result.stdout?.toString().trim(), result.stderr?.toString().trim()]
		.filter(Boolean)
		.join('\n');
}

export function gitRepositoryRoot(cwd: string): string | null {
	const result = git(cwd, ['rev-parse', '--show-toplevel']);
	if (result.exitCode !== 0) return null;
	return result.stdout?.toString().trim() || null;
}

export function worktreeEntries(cwd: string): Array<{
	path: string;
	branch?: string;
	bare?: boolean;
	head?: string;
	locked?: boolean;
	prunable?: boolean;
}> {
	const result = git(cwd, ['worktree', 'list', '--porcelain']);
	if (result.exitCode !== 0) return [];
	const entries: Array<{
		path: string;
		branch?: string;
		bare?: boolean;
		head?: string;
		locked?: boolean;
		prunable?: boolean;
	}> = [];
	let current: {
		path: string;
		branch?: string;
		bare?: boolean;
		head?: string;
		locked?: boolean;
		prunable?: boolean;
	} | null = null;
	for (const line of result.stdout?.toString().split('\n') ?? []) {
		if (line.startsWith('worktree ')) {
			if (current) entries.push(current);
			current = {path: line.slice('worktree '.length)};
		} else if (line.startsWith('branch ') && current) {
			current.branch = line
				.slice('branch '.length)
				.replace(/^refs\/heads\//, '');
		} else if (line.startsWith('HEAD ') && current) {
			current.head = line.slice('HEAD '.length);
		} else if (line === 'bare' && current) current.bare = true;
		else if (line.startsWith('locked') && current) current.locked = true;
		else if (line.startsWith('prunable') && current) current.prunable = true;
	}
	if (current) entries.push(current);
	return entries;
}

function safeName(value: string): string | null {
	const name = value.trim();
	return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(name) &&
		!name.includes('..')
		? name
		: null;
}

export function enterWorktree(
	cwd: string,
	args: {name?: string; path?: string; base?: string},
): WorktreeCommandResult {
	const root = gitRepositoryRoot(cwd);
	if (!root)
		return {content: 'Error: current directory is not a git repository.'};
	const existing = args.path ? resolve(cwd, args.path) : undefined;
	if (existing && existsSync(existing)) {
		const registered = worktreeEntries(root).some(
			entry => realpathSync(entry.path) === realpathSync(existing),
		);
		if (!registered) {
			return {
				content: `Error: ${existing} exists but is not a registered git worktree.`,
			};
		}
		return {content: `Entered existing worktree ${existing}`, cwd: existing};
	}
	const requested = safeName(args.name || basename(existing || ''));
	if (!requested) {
		return {
			content: 'Error: enter_worktree requires a safe branch/worktree name.',
		};
	}
	const target =
		existing ??
		join(root, '.bobonyo', 'worktrees', requested.replaceAll('/', '-'));
	const rel = relative(root, target);
	if (rel.startsWith('..') || isAbsolute(rel)) {
		return {content: 'Error: new worktrees must stay inside the repository.'};
	}
	mkdirSync(dirname(target), {recursive: true});
	const base = args.base?.trim() || 'HEAD';
	const result = git(root, ['worktree', 'add', '-b', requested, target, base]);
	if (result.exitCode !== 0) {
		return {content: `Error: git worktree add failed.\n${output(result)}`};
	}
	return {
		content: `Created and entered worktree ${target}\nBranch: ${requested}\nBase: ${base}`,
		cwd: target,
	};
}

export function exitWorktree(cwd: string): WorktreeCommandResult {
	const entries = worktreeEntries(cwd).filter(entry => !entry.bare);
	if (entries.length === 0) return {content: 'Error: no git worktrees found.'};
	const current = realpathSync(cwd);
	const main = entries[0]!;
	if (realpathSync(main.path) === current) {
		return {content: `Already in main worktree ${main.path}`, cwd: main.path};
	}
	return {content: `Exited to main worktree ${main.path}`, cwd: main.path};
}

export function inspectWorktrees(cwd: string): WorktreeCommandResult {
	const root = gitRepositoryRoot(cwd);
	if (!root)
		return {content: 'Error: current directory is not a git repository.'};
	const current = realpathSync(cwd);
	const rows = worktreeEntries(root).filter(entry => !entry.bare);
	return {
		content: rows
			.map(entry => {
				let resolvedPath = resolve(entry.path);
				try {
					resolvedPath = realpathSync(entry.path);
				} catch {
					// Prunable entries may no longer exist on disk.
				}
				const dirty = existsSync(entry.path)
					? git(entry.path, ['status', '--porcelain']).stdout?.toString().trim()
					: '';
				return [
					resolvedPath === current ? '❯' : ' ',
					entry.path,
					entry.branch ? `[${entry.branch}]` : '(detached)',
					dirty ? 'dirty' : existsSync(entry.path) ? 'clean' : 'missing',
					entry.locked ? 'locked' : '',
					entry.prunable ? 'prunable' : '',
				]
					.filter(Boolean)
					.join(' ');
			})
			.join('\n'),
	};
}

export function removeWorktree(
	cwd: string,
	args: {path?: string; deleteBranch?: boolean},
): WorktreeCommandResult {
	const root = gitRepositoryRoot(cwd);
	if (!root)
		return {content: 'Error: current directory is not a git repository.'};
	if (!args.path) return {content: 'Error: remove_worktree requires a path.'};
	const target = resolve(cwd, args.path);
	const entries = worktreeEntries(root).filter(entry => !entry.bare);
	const entry = entries.find(candidate => {
		try {
			return realpathSync(candidate.path) === realpathSync(target);
		} catch {
			return resolve(candidate.path) === target;
		}
	});
	if (!entry)
		return {content: `Error: ${target} is not a registered git worktree.`};
	if (resolve(entry.path) === resolve(entries[0]!.path)) {
		return {content: 'Error: refusing to remove the main worktree.'};
	}
	try {
		if (realpathSync(entry.path) === realpathSync(cwd)) {
			return {content: 'Error: exit the worktree before removing it.'};
		}
	} catch {}
	const dirty = git(entry.path, ['status', '--porcelain']);
	if (dirty.exitCode !== 0)
		return {content: `Error: cannot inspect worktree.\n${output(dirty)}`};
	if (dirty.stdout?.toString().trim()) {
		return {
			content:
				'Error: worktree has uncommitted changes; commit or stash them first.',
		};
	}
	if (entry.branch) {
		const merged = git(root, [
			'branch',
			'--merged',
			'HEAD',
			'--format=%(refname:short)',
		]);
		const mergedBranches = new Set(
			merged.stdout
				?.toString()
				.split('\n')
				.map(line => line.trim())
				.filter(Boolean),
		);
		if (!mergedBranches.has(entry.branch)) {
			return {
				content: `Error: branch ${entry.branch} is not merged into HEAD; refusing removal.`,
			};
		}
	}
	const removed = git(root, ['worktree', 'remove', entry.path]);
	if (removed.exitCode !== 0)
		return {content: `Error: git worktree remove failed.\n${output(removed)}`};
	let result = `Removed worktree ${entry.path}`;
	if (args.deleteBranch && entry.branch) {
		const deleted = git(root, ['branch', '-d', entry.branch]);
		if (deleted.exitCode !== 0)
			return {
				content: `${result}\nWarning: branch was kept.\n${output(deleted)}`,
			};
		result += `\nDeleted merged branch ${entry.branch}`;
	}
	return {content: result};
}
