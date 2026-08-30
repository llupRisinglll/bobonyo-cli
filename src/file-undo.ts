import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {applyPatchPaths} from './apply-patch';

/**
 * File-state undo (openclaude-rewind style): before every FILE mutation
 * tool runs we snapshot the target file's pre-state into the CURRENT
 * exchange. `/undo` then restores those files alongside the transcript
 * truncation, so undoing a turn reverts its file changes too.
 *
 * Snapshots are IN-MEMORY (a session's file contents can be large); they
 * cover the dedicated file tools (write/edit/delete, best-effort
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
export const MAX_FILE_UNDO_EXCHANGES = 20;
export const MAX_FILE_UNDO_BYTES = 64 * 1024 * 1024;

function entryBytes(entry: FileUndoEntry): number {
	return entry.path.length + (entry.content?.length ?? 0);
}

export function fileUndoBytes(): number {
	return stack.reduce(
		(total, exchange) =>
			total +
			exchange.prompt.length +
			[...exchange.files.values()].reduce(
				(exchangeTotal, entry) => exchangeTotal + entryBytes(entry),
				0,
			),
		0,
	);
}

function pruneFileUndoStack(): void {
	while (stack.length > MAX_FILE_UNDO_EXCHANGES) stack.shift();
	while (stack.length > 1 && fileUndoBytes() > MAX_FILE_UNDO_BYTES) {
		stack.shift();
	}
}

/** Start a new exchange for a submitted user prompt. */
export function beginFileUndoExchange(prompt: string): void {
	stack.push({prompt, files: new Map()});
	pruneFileUndoStack();
}

/** Record a file's pre-mutation state into the CURRENT exchange (once per
 *  path per exchange — later writes in the same turn keep the ORIGINAL
 *  pre-turn content). */
export function snapshotFileBeforeMutation(path: string): void {
	const top = stack[stack.length - 1];
	if (!top || !path || top.files.has(path)) return;
	const existed = existsSync(path);
	const entry: FileUndoEntry = {
		path,
		existed,
		content: existed ? readFileSync(path, 'utf8') : undefined,
	};
	// A giant file must not pin the process indefinitely. Skipping it is safer
	// than recording incomplete content that `/undo` could restore as empty.
	if (entryBytes(entry) > MAX_FILE_UNDO_BYTES) return;
	while (
		stack.length > 1 &&
		fileUndoBytes() + entryBytes(entry) > MAX_FILE_UNDO_BYTES
	) {
		stack.shift();
	}
	if (fileUndoBytes() + entryBytes(entry) > MAX_FILE_UNDO_BYTES) return;
	top.files.set(path, entry);
}

/**
 * Paths a mutation tool will touch (before execution). Returns [] for
 * non-file tools so callers can snapshot blindly.
 */
export function mutationTargetPaths(
	name: string,
	args: Record<string, unknown>,
	cwd = process.cwd(),
): string[] {
	const str = (key: string): string =>
		typeof args[key] === 'string' ? (args[key] as string) : '';
	switch (name) {
		case 'write_file':
		case 'edit_file':
		case 'string_replace':
		case 'delete_file':
			return str('path')
				? [/^[/\\]/.test(str('path')) ? str('path') : `${cwd}/${str('path')}`]
				: [];
		case 'apply_patch': {
			const patchText = str('patchText');
			if (!patchText) return [];
			try {
				return applyPatchPaths(process.cwd(), patchText);
			} catch {
				return [];
			}
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
			return paths.map(p => (/^[/\\]/.test(p) ? p : `${cwd}/${p}`));
		}
		default:
			return [];
	}
}

/** Snapshot every file the named tool will mutate. */
export function snapshotMutationTargets(
	name: string,
	args: Record<string, unknown>,
	cwd = process.cwd(),
): void {
	for (const path of mutationTargetPaths(name, args, cwd)) {
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
