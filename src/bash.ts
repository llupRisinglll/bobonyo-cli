/**
 * Async foreground bash execution. Background work is intentional: callers
 * use `process_start`; `execute_bash` always remains foreground.
 */

import {createSignal} from 'solid-js';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {checkBashRemovalSafety} from './bash-removal-guard';
import {loadSettings} from './settings';
import {buildSandboxCommand} from './sandbox';
import {projectRoot} from './project-paths';

export interface BackgroundTask {
	id: string;
	command: string;
	output: string[];
	running: boolean;
	exitCode: number | null;
	startedAt: number;
	completedAt?: number;
	claimed?: boolean;
	completion?: Promise<void>;
	cancel?: () => void;
	owner?: 'user' | 'goal' | 'loop';
	/** Service processes remain monitorable but must not block turn completion. */
	blocksCompletion?: boolean;
}

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
export const MAX_COMPLETED_BACKGROUND_TASKS = 20;

/** Keep every running task plus only the newest completed task summaries. */
export function capBackgroundTasks(
	tasks: BackgroundTask[],
	maxCompleted = MAX_COMPLETED_BACKGROUND_TASKS,
): BackgroundTask[] {
	const running = tasks.filter(task => task.running);
	const completed = tasks
		.filter(task => !task.running)
		.sort(
			(a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt),
		)
		.slice(0, Math.max(0, maxCompleted));
	return [...running, ...completed].sort((a, b) => a.startedAt - b.startedAt);
}

/** Remove terminal control sequences before subprocess text reaches OpenTUI. */
export function stripTerminalControl(text: string): string {
	return text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
		.replace(
			/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
			'',
		)
		.replace(/\u001b./gs, '')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u009b]/g, '')
		.replace(/\r/g, '');
}

let taskSeq = 0;
function nextTaskId(): string {
	taskSeq += 1;
	return `bg_${Date.now().toString(36)}_${taskSeq}`;
}

export function activeBgCount(): number {
	return bgTasks().filter(task => task.running).length;
}

/** Background work which must finish before turn/goal completion. */
export function activeBlockingBgCount(): number {
	return bgTasks().filter(
		task => task.running && task.blocksCompletion !== false,
	).length;
}

/** Cancel every running Bash task owned by this Bobonyo process. */
export function cancelRunningBackgroundTasks(
	owner?: BackgroundTask['owner'],
): number {
	const running = bgTasks().filter(
		task => task.running && (!owner || task.owner === owner),
	);
	for (const task of running) task.cancel?.();
	return running.length;
}

/**
 * Drop a leading echoed-command line (or run of lines) from captured bash
 * output.
 *
 * A shell can echo the typed command back into the captured stream
 * (PTY-backed execution, shell wrappers, `set -v`-style configs): for
 * `cd /tmp/bobonyo-link && echo hi` the first captured line can be
 * `$ cd /tmp/bobonyo-link && echo hi` (or `cd /tmp/bobonyo-link && echo hi`,
 * possibly with a trailing `\r` from PTY line endings). A MULTI-LINE
 * command echoes as MULTIPLE captured lines — the shell prints every line
 * of the typed command, so `git add a.ts\n&& git commit -m "…"` leaks as
 * `$ git add a.ts`, `> && git commit -m "…"`, … The tool row ALREADY
 * renders the command as its box header, so the echo would show the command
 * twice — the "entry appears twice while running" bug. Stripping it at
 * CAPTURE keeps the live stream, the settled result, the provider context
 * AND the persisted session clean (display-level stripping in
 * formatBashEntry additionally heals already-saved sessions).
 *
 * Only a LEADING run of lines is stripped, and only when it is the command
 * itself (every command line, optionally `$ ` / `❯ ` / `> ` prefixed and
 * CR-suffixed): a real output line that merely CONTAINS command text later
 * in the stream is never touched, and a partial match is never stripped.
 * Pure, unit-tested.
 */
export function stripEchoedCommand(lines: string[], command: string): string[] {
	// Compare WHITESPACE-COLLAPSED text: the echo can differ from the raw
	// command in three ways and still be the same command — (1) a
	// MULTI-LINE command echoes as one captured line per command line, (2)
	// a LONG single-line command's echo can split across stream reads (the
	// pump pushes read-fragments as separate lines), (3) PTY line endings.
	const collapsed = collapseText(command);
	if (!collapsed) return lines;
	const out = [...lines];
	// The echo can appear more than once (stdout AND stderr both echoed).
	let matched = true;
	while (matched) {
		matched = false;
		let consumed = 0;
		let acc = '';
		let firstHadPrompt = false;
		for (const line of out) {
			const normalized = line.replace(/\r$/, '').trim();
			const prompt = /^(\$|❯|>)\s*/.exec(normalized);
			const bare = prompt ? normalized.slice(prompt[0].length) : normalized;
			if (!bare) {
				consumed += 1;
				continue;
			}
			if (prompt && consumed === 0) firstHadPrompt = true;
			const piece = collapseText(bare);
			const next = acc ? `${acc} ${piece}` : piece;
			// The accumulated echo must stay a PREFIX of the command.
			if (!collapsed.startsWith(next)) break;
			acc = next;
			consumed += 1;
			if (acc === collapsed) break;
		}
		// Strip when the accumulated echo IS the whole command, or when the
		// echo started with a prompt (`$ ` / `❯ ` / `> `) and is a real
		// prefix — a prompt-marked fragment is an echo, not real output
		// (the echo can be truncated across stream ticks).
		if (
			consumed > 0 &&
			(acc === collapsed || (firstHadPrompt && acc.length >= 2))
		) {
			out.splice(0, consumed);
			matched = true;
		}
	}
	return out;
}

/** Collapse every run of whitespace (incl. newlines) to ONE space. */
function collapseText(text: string): string {
	return text.trim().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Prevent `pgrep/pkill -f 'literal'` from matching its own shell command.
 * Bracketing one literal character keeps regex meaning for target processes
 * (`node` -> `[n]ode`) while the wrapper command contains `[n]ode`, not
 * `node`. Existing bracket-safe patterns remain untouched.
 */
export function avoidProcessMatcherSelfMatch(command: string): string {
	return command.replace(
		/\b(pgrep|pkill)(\s+[^;&|\n]*?(?:-f|-[A-Za-z]*f[A-Za-z]*))\s+(['"])([^'"\n]+)\3/g,
		(full, tool: string, flags: string, quote: string, pattern: string) => {
			if (/\[[^\]]+\]/.test(pattern)) return full;
			const at = pattern.search(/[A-Za-z0-9]/);
			if (at < 0) return full;
			const char = pattern[at] ?? '';
			const safe = `${pattern.slice(0, at)}[${char}]${pattern.slice(at + 1)}`;
			return `${tool}${flags} ${quote}${safe}${quote}`;
		},
	);
}

/** Remove only a redundant leading `cd <current workspace>` prefix. */
export function normalizeBashCommand(command: string, cwd: string): string {
	const match =
		/^\s*cd\s+(?:--\s+)?(?:(['"])(.*?)\1|(\S+))\s*(?:(&&|;)([\s\S]*))?\s*$/.exec(
			command,
		);
	if (!match) return command;
	const target = match[2] ?? match[3];
	if (!target) return command;
	let resolvedTarget: string;
	try {
		resolvedTarget = resolve(cwd, target);
	} catch {
		return command;
	}
	if (resolvedTarget !== resolve(cwd)) return command;
	const rest = match[5]?.trim() ?? '';
	return rest || ':';
}

/** Sandboxed commands may only move harness cwd within project workspace. */
export function sandboxedCwd(
	candidate: string | undefined,
	cwd: string,
	active: boolean,
	workspaceRoot = projectRoot(cwd),
): string | undefined {
	if (!candidate || !active) return candidate;
	const root = resolve(workspaceRoot);
	const target = resolve(candidate);
	const rel = relative(root, target);
	return rel === '' ||
		(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
		? target
		: undefined;
}

export interface BashTurnResult {
	content: string;
	task?: BackgroundTask;
	cwd?: string;
}

export async function runBash(
	command: string,
	onProgress?: (output: string) => void,
	signal?: AbortSignal,
	cwd = process.cwd(),
	onCwdChange?: (cwd: string) => void,
	owner: BackgroundTask['owner'] = 'user',
	workspaceRoot = projectRoot(cwd),
	extraWritablePaths: string[] = [],
): Promise<BashTurnResult> {
	command = avoidProcessMatcherSelfMatch(command);
	// Non-negotiable containment gate. Approval mode never overrides this:
	// shell deletion may touch literal targets strictly below workspace only.
	const removalSafety = checkBashRemovalSafety(
		command,
		cwd,
		extraWritablePaths,
	);
	if (!removalSafety.allowed) {
		return {
			content: `REFUSED dangerous deletion: ${removalSafety.reason}. Use delete_file for an explicit in-workspace file.`,
			cwd,
		};
	}
	const task: BackgroundTask = {
		id: nextTaskId(),
		command,
		output: [],
		running: true,
		exitCode: null,
		startedAt: Date.now(),
		owner,
	};

	const cwdMarker = '__BOBONYО_CWD__';
	let finalCwd: string | undefined;
	// Run command in one shell, then probe that shell's final PWD. A new
	// process per tool call cannot retain `cd` by itself.
	const wrappedCommand = `${command}\n__bobonyo_status=$?\nprintf '\n${cwdMarker}%s\n' "$PWD"\nexit $__bobonyo_status`;
	let stdoutRemainder = '';
	const consumeStdout = (text: string) => {
		stdoutRemainder += text;
		const lines = stdoutRemainder.split('\n');
		stdoutRemainder = lines.pop() ?? '';
		for (const line of lines) {
			if (line.startsWith(cwdMarker)) {
				finalCwd = line.slice(cwdMarker.length).trim();
			} else if (line) {
				task.output.push(line);
			}
		}
	};
	const sandboxSettings = loadSettings().sandbox ?? {
		mode: 'auto' as const,
		network: true,
		writablePaths: [],
	};
	const sandbox = buildSandboxCommand(
		wrappedCommand,
		cwd,
		{
			...sandboxSettings,
			writablePaths: [
				...new Set([...sandboxSettings.writablePaths, ...extraWritablePaths]),
			],
		},
		undefined,
		workspaceRoot,
	);
	if (sandbox.argv.length === 0) {
		return {content: `REFUSED: ${sandbox.reason}`, cwd};
	}
	const proc = Bun.spawn(sandbox.argv, {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			TERM: 'dumb',
			NO_COLOR: '1',
			FORCE_COLOR: '0',
			CLICOLOR: '0',
			CLICOLOR_FORCE: '0',
		},
		// Separate process group: Esc must kill bash AND descendants (gh/npm/
		// test runners), not leave a grandchild holding stdout pipes open.
		detached: process.platform !== 'win32',
	});

	// ABORT SIGNAL: when the user presses Esc (the turn's AbortController
	// fires), kill the spawned process immediately so the tool loop
	// unwinds instead of waiting for the process to finish naturally.
	let abortReject: ((error: DOMException) => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		abortReject = reject;
	});
	const killProcessTree = () => {
		try {
			if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGTERM');
			else proc.kill('SIGTERM');
		} catch {
			try {
				proc.kill('SIGTERM');
			} catch {}
		}
		// Some CLIs trap TERM. Esc is cancellation, not a polite shutdown
		// request: force the whole group after a tiny grace period.
		const timer = setTimeout(() => {
			try {
				if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL');
				else proc.kill('SIGKILL');
			} catch {}
		}, 100);
		timer.unref();
		abortReject?.(new DOMException('Aborted', 'AbortError'));
	};
	task.cancel = killProcessTree;
	if (signal) {
		if (signal.aborted) killProcessTree();
		else signal.addEventListener('abort', killProcessTree, {once: true});
	}

	let truncated = false;
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			const chunk = stripTerminalControl(decoder.decode(value, {stream: true}));
			if (stream === proc.stdout) consumeStdout(chunk);
			else {
				for (const line of chunk.split('\n')) if (line) task.output.push(line);
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
		signal?.removeEventListener('abort', killProcessTree);
	})();
	task.completion = finished;

	await Promise.race([finished, aborted]);
	if (stdoutRemainder) consumeStdout('\n');
	const output = task.output.join('\n');
	return {
		content: `EXIT_CODE: ${task.exitCode ?? '?'}\n${output}`.trim(),
		task,
		cwd: sandboxedCwd(finalCwd, cwd, sandbox.active, workspaceRoot),
	};
}

/** Wait for an explicitly created background task. */
export async function waitForBackgroundTask(
	task: BackgroundTask,
	signal?: AbortSignal,
): Promise<string> {
	task.claimed = true;
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
		signal?.addEventListener('abort', onAbort, {once: true});
		(task.completion ?? Promise.resolve())
			.then(resolve, reject)
			.finally(() => signal?.removeEventListener('abort', onAbort));
	});
	return `EXIT_CODE: ${task.exitCode ?? '?'}\n${task.output.join('\n')}`.trim();
}
