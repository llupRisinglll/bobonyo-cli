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

export const [bgTasks, setBgTasks] = createSignal<BackgroundTask[]>([]);

let taskSeq = 0;
function nextTaskId(): string {
	taskSeq += 1;
	return `bg_${Date.now().toString(36)}_${taskSeq}`;
}

export function activeBgCount(): number {
	return bgTasks().filter(task => task.running).length;
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
		void finished.then(() => {
			const scriptLines = command
				.split('\n')
				.map(line => line.trimEnd())
				.filter(line => line !== '');
			const scriptBlock = scriptLines
				.map(line => `  └ ${line}`)
				.join('\n');
			appendMessage({
				role: 'assistant',
				// C8: expandable completion row, the script preview collapses
				// to the first lines with a `+N lines (ctrl + t …)` footer;
				// history.tsx expands it with the same toggle as tool rows.
				content:
					`Background task completed · exit ${task.exitCode ?? '?'}\n` +
					scriptBlock,
				kind: 'info',
			});
		}).catch(() => {});
		return {
			content:
				`Command exceeded the ${AUTO_BACKGROUND_MS / 1000}-second foreground budget ` +
				`and is still running as background task ${task.id}. ` +
				'Use monitor to read output, check status, or stop it.',
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
