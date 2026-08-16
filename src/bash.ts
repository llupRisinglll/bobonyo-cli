/**
 * Async bash execution with nanocoder's auto-background handover.
 *
 * A command that finishes within the foreground budget returns its full
 * output; one that outlives the budget is handed to a background task
 * registry (`bgTasks`), keeps streaming into its output buffer, and appends
 * a completion row to the transcript when it exits.
 */

import {createSignal} from 'solid-js';
import {appendMessage} from './state';

export interface BackgroundTask {
	id: string;
	command: string;
	output: string[];
	running: boolean;
	exitCode: number | null;
	startedAt: number;
	completedAt?: number;
}

/** nanocoder's foreground budget (source/utils/streaming-bash-tool.tsx). */
export const AUTO_BACKGROUND_MS = 15_000;

/**
 * Bash output capture caps (parity: opencode's `MAX_LINES` 2000 / `MAX_BYTES`
 * 50 KB). The COLLECTED output keeps its TAIL — results/errors live at the
 * end — and a single unbroken line (e.g. `grep` on a minified one-line file)
 * is truncated to the char cap too, so it can never flood the transcript or
 * the model context.
 */
export const MAX_BASH_OUTPUT_LINES = 2000;
export const MAX_BASH_OUTPUT_CHARS = 50_000;

/**
 * Keep the tail of collected output lines within the capture caps. Pure and
 * unit-tested: caps by line count first, then by total characters walking
 * from the end (a huge single line is sliced to the char cap).
 */
export function capOutputTail(
	lines: string[],
	maxLines = MAX_BASH_OUTPUT_LINES,
	maxChars = MAX_BASH_OUTPUT_CHARS,
): {lines: string[]; truncated: boolean} {
	const byLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
	let truncated = lines.length > maxLines;
	const capped: string[] = [];
	let chars = 0;
	for (let i = byLines.length - 1; i >= 0; i--) {
		const line = byLines[i]!;
		const size = line.length + (capped.length > 0 ? 1 : 0);
		if (chars + size > maxChars) {
			const keep = maxChars - chars;
			if (keep > 0) {
				const piece = line.slice(-keep);
				capped.unshift(piece.length < line.length ? `…${piece}` : piece);
			}
			truncated = true;
			break;
		}
		chars += size;
		capped.unshift(line);
	}
	return {lines: capped, truncated};
}

export const [bgTasks, setBgTasks] = createSignal<BackgroundTask[]>([]);

let taskSeq = 0;
function nextTaskId(): string {
	taskSeq += 1;
	return `bg_${Date.now().toString(36)}_${taskSeq}`;
}

export function activeBgCount(): number {
	return bgTasks().filter(task => task.running).length;
}

/**
 * Drop a leading echoed-command line from captured bash output.
 *
 * A shell can echo the typed command back into the captured stream
 * (PTY-backed execution, shell wrappers, `set -v`-style configs): for
 * `cd /tmp/bobonyo-link && echo hi` the first captured line can be
 * `$ cd /tmp/bobonyo-link && echo hi` (or `cd /tmp/bobonyo-link && echo hi`,
 * possibly with a trailing `\r` from PTY line endings). The tool row
 * ALREADY renders the command as its box header, so the echo would show the
 * command twice — the "entry appears twice while running" bug. Stripping it
 * at CAPTURE keeps the live stream, the settled result, the provider
 * context AND the persisted session clean (display-level stripping in
 * formatBashEntry additionally heals already-saved sessions).
 *
 * Only a LEADING line is stripped, and only when it is the command itself
 * (optionally `$ ` / `❯ ` prefixed): a real output line that merely
 * CONTAINS the command text later in the stream is never touched. Pure,
 * unit-tested.
 */
export function stripEchoedCommand(lines: string[], command: string): string[] {
	const cmd = command.trim();
	if (!cmd) return lines;
	const normalized = (line: string) => line.replace(/\r$/, '').trim();
	const out = [...lines];
	while (out.length > 0) {
		const first = normalized(out[0] ?? '');
		if (first === cmd || first === `$ ${cmd}` || first === `❯ ${cmd}`) {
			out.shift();
			continue;
		}
		break;
	}
	return out;
}

export interface BashTurnResult {
	content: string;
	task?: BackgroundTask;
}

export async function runBash(
	command: string,
	onProgress?: (output: string) => void,
): Promise<BashTurnResult> {
	const task: BackgroundTask = {
		id: nextTaskId(),
		command,
		output: [],
		running: true,
		exitCode: null,
		startedAt: Date.now(),
	};

	const proc = Bun.spawn(['bash', '-c', command], {
		cwd: process.cwd(),
		stdout: 'pipe',
		stderr: 'pipe',
	});

	let truncated = false;
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, {stream: true});
			for (const line of chunk.split('\n')) {
				if (line) task.output.push(line);
			}
			// Strip a leading echoed-command line (the shell printed the
			// typed command back): the tool box already renders the command
			// as its header, so the echo duplicates the command inside the
			// box — the "entry shows twice" artifact. Done per pump tick so
			// the STREAMED (live) output is clean too, not just the final
			// result.
			task.output = stripEchoedCommand(task.output, command);
			const capped = capOutputTail(task.output);
			if (capped.truncated) truncated = true;
			task.output = capped.lines;
			onProgress?.(task.output.join('\n'));
		}
	};

	const finished = (async () => {
		await Promise.all([
			proc.exited,
			pump(proc.stdout as ReadableStream<Uint8Array>),
			pump(proc.stderr as ReadableStream<Uint8Array>),
		]);
		task.running = false;
		task.exitCode = proc.exitCode ?? 0;
		task.completedAt = Date.now();
		if (truncated) {
			task.output = [
				`… [output truncated: kept the last ${MAX_BASH_OUTPUT_LINES} lines / ${MAX_BASH_OUTPUT_CHARS} chars]`,
				...task.output,
			];
		}
		setBgTasks(prev => [...prev]);
	})();

	// nanocoder disables auto-background for a leading `sleep`.
	const disallowAutoBackground = /^\s*sleep(?:\s|$)/.test(command);
	const budget = disallowAutoBackground
		? null
		: new Promise<null>(resolve => {
				const timeout = setTimeout(() => resolve(null), AUTO_BACKGROUND_MS);
				timeout.unref();
			});

	const outcome = budget
		? await Promise.race([
				finished.then(() => 'done' as const),
				budget.then(() => 'background' as const),
			])
		: 'done';

	if (outcome === 'background') {
		setBgTasks(prev => [...prev, task]);
		void finished
			.then(() => {
				const scriptLines = command
					.split('\n')
					.map(line => line.trimEnd())
					.filter(line => line !== '');
				appendMessage({
					role: 'assistant',
					// Tool-style completion row (parity: nanocoder's
					// BackgroundTaskCompleted): `✦ Background task completed ·
					// exit N` header, the script under a `  └   ` container with
					// the SAME wrap/expand +N footer the tool rows use.
					content:
						`Background task completed · exit ${task.exitCode ?? '?'}\n` +
						scriptLines.join('\n'),
					kind: 'info',
				});
			})
			.catch(() => {});
		return {
			content:
				`Command exceeded the ${AUTO_BACKGROUND_MS / 1000}-second foreground budget ` +
				`and is still running as background task ${task.id}. ` +
				'A completion row appears in the chat when it exits (status line shows `bg: N` while running).',
			task,
		};
	}

	await finished;
	const output = task.output.join('\n');
	return {
		content: `EXIT_CODE: ${task.exitCode ?? '?'}\n${output}`.trim(),
		task,
	};
}
