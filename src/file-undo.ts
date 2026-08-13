import {
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';

/**
 * File-state undo (openclaude-rewind style): before every FILE mutation
 * tool runs we snapshot the target file's pre-state into the CURRENT
 * exchange. `/undo` then restores those files alongside the transcript
 * truncation, so undoing a turn reverts its file changes too.
 *
 * Snapshots are IN-MEMORY (a session's file contents can be large); they
 * cover the dedicated file tools (write/edit/delete/file_op, best-effort
 * diff_edit). Bash-driven mutations are intentionally out of scope — a
 * shell command can rewrite anything and is not safely reversible.
 */

export interface FileUndoEntry {
	path: string;
	/** The file existed BEFORE the mutation — restore its content. */
	existed: boolean;
	/** Previous content when the file existed. */
	content?: string;
}

export interface FileUndoExchange {
	/** The user prompt this exchange started from. */
	prompt: string;
	files: Map<string, FileUndoEntry>;
}

const stack: FileUndoExchange[] = [];

/** Start a new exchange for a submitted user prompt. */
export function beginFileUndoExchange(prompt: string): void {
	stack.push({prompt, files: new Map()});
}

/** Record a file's pre-mutation state into the CURRENT exchange (once per
 *  path per exchange — later writes in the same turn keep the ORIGINAL
 *  pre-turn content). */
export function snapshotFileBeforeMutation(path: string): void {
	const top = stack[stack.length - 1];
	if (!top || !path || top.files.has(path)) return;
	const existed = existsSync(path);
	top.files.set(path, {
		path,
		existed,
		content: existed ? readFileSync(path, 'utf8') : undefined,
	});
}

/**
 * Paths a mutation tool will touch (before execution). Returns [] for
 * non-file tools so callers can snapshot blindly.
 */
export function mutationTargetPaths(
	name: string,
	args: Record<string, unknown>,
): string[] {
	const str = (key: string): string =>
		typeof args[key] === 'string' ? (args[key] as string) : '';
	switch (name) {
		case 'write_file':
		case 'string_replace':
		case 'delete_file':
			return str('path') ? [str('path')] : [];
		case 'file_op': {
			const op = str('op');
			const paths = [str('path'), str('target')];
			if (op === 'move' || op === 'rename' || op === 'copy') {
				return paths.filter(Boolean);
			}
			return paths.slice(0, 1).filter(Boolean);
		}
		case 'diff_edit': {
			// Best-effort: pull `+++ b/<path>` / `--- a/<path>` headers from
			// the unified diff and resolve them against the cwd.
			const diff = str('diff');
			const cwd = str('cwd') || process.cwd();
			const paths: string[] = [];
			for (const line of diff.split('\n')) {
				const m = /^\+\+\+\s+(?:a\/|b\/)?(.+)$/.exec(line.trim());
				if (m && !paths.includes(m[1] ?? '')) paths.push(m[1] ?? '');
			}
			return paths.map(p =>
				/^[/\\]/.test(p) ? p : `${cwd}/${p}`,
			);
		}
		default:
			return [];
	}
}

/** Snapshot every file the named tool will mutate. */
export function snapshotMutationTargets(
	name: string,
	args: Record<string, unknown>,
): void {
	for (const path of mutationTargetPaths(name, args)) {
		snapshotFileBeforeMutation(path);
	}
}

/**
 * Restore the most recent exchange's files, pop it, and report what was
 * undone. Returns null when there is no exchange.
 */
export function undoFileExchange(): {
	prompt: string;
	restored: string[];
} | null {
	const top = stack.pop();
	if (!top) return null;
	const restored: string[] = [];
	for (const entry of top.files.values()) {
		try {
			if (entry.existed) {
				writeFileSync(entry.path, entry.content ?? '');
			} else if (existsSync(entry.path)) {
				// The file did not exist before this exchange — remove it.
				rmSync(entry.path);
			}
			restored.push(entry.path);
		} catch {
			// best-effort restore; never fail the undo because a file is
			// locked or the path was deleted externally.
		}
	}
	return {prompt: top.prompt, restored};
}

/** Number of pending file-undo exchanges (for tests/debug). */
export function fileUndoDepth(): number {
	return stack.length;
}

/** Clear the stack (new session / tests). */
export function resetFileUndoStack(): void {
	stack.length = 0;
}
