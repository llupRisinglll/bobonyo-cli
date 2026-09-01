import {buildSandboxCommand} from './sandbox';
import {loadSettings} from './settings';
import {
	capBackgroundTasks,
	capOutputTail,
	setBgTasks,
	stripTerminalControl,
} from './bash';

export interface PersistentProcess {
	id: string;
	command: string;
	output: string[];
	running: boolean;
	exitCode: number | null;
	proc: ReturnType<typeof Bun.spawn>;
	stdin: Bun.FileSink;
	owner?: 'user' | 'goal' | 'loop';
	onComplete?: (process: PersistentProcess) => void;
}

const processes = new Map<string, PersistentProcess>();
let sequence = 0;

export function listPersistentProcesses(): PersistentProcess[] {
	return [...processes.values()];
}

export function startPersistentProcess(
	command: string,
	cwd: string,
	owner: PersistentProcess['owner'] = 'user',
	onComplete?: (process: PersistentProcess) => void,
): PersistentProcess {
	const sandbox = buildSandboxCommand(
		command,
		cwd,
		loadSettings().sandbox ?? {mode: 'auto', network: true, writablePaths: []},
	);
	if (sandbox.argv.length === 0) throw new Error(`REFUSED: ${sandbox.reason}`);
	const proc = Bun.spawn(sandbox.argv, {
		cwd,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: {...process.env, TERM: 'dumb', NO_COLOR: '1'},
		detached: process.platform !== 'win32',
	});
	const row: PersistentProcess = {
		id: `proc_${Date.now().toString(36)}_${++sequence}`,
		command,
		output: [],
		running: true,
		exitCode: null,
		proc,
		stdin: proc.stdin as Bun.FileSink,
		owner,
		onComplete,
	};
	processes.set(row.id, row);
	setBgTasks(prev =>
		capBackgroundTasks([
			...prev,
			{
				id: row.id,
				command,
				output: row.output,
				running: true,
				exitCode: null,
				startedAt: Date.now(),
				owner,
				blocksCompletion: false,
				cancel: () => {
					void stopPersistentProcess(row.id);
				},
			},
		]),
	);
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		for (;;) {
			const {done, value: chunk} = await reader.read();
			if (done) break;
			const text = stripTerminalControl(new TextDecoder().decode(chunk));
			row.output.push(...text.split('\n').filter(Boolean));
			row.output = capOutputTail(row.output).lines;
			setBgTasks(prev =>
				capBackgroundTasks(
					prev.map(task =>
						task.id === row.id ? {...task, output: [...row.output]} : task,
					),
				),
			);
		}
	};
	void Promise.all([
		pump(proc.stdout as ReadableStream<Uint8Array>),
		pump(proc.stderr as ReadableStream<Uint8Array>),
		proc.exited,
	]).then(() => {
		row.running = false;
		row.exitCode = proc.exitCode ?? 0;
		setBgTasks(prev =>
			capBackgroundTasks(
				prev.map(task =>
					task.id === row.id
						? {
								...task,
								output: [...row.output],
								running: false,
								exitCode: row.exitCode,
								completedAt: Date.now(),
							}
						: task,
				),
			),
		);
		row.onComplete?.(row);
	});
	return row;
}

export function writePersistentProcess(id: string, input: string): string {
	const row = processes.get(id);
	if (!row) return `Error: process ${id} not found.`;
	if (!row.running) return `Error: process ${id} is not running.`;
	row.stdin.write(input);
	row.stdin.flush();
	return `Wrote ${input.length} chars to ${id}.`;
}

export function stopPersistentProcess(id: string): string {
	const row = processes.get(id);
	if (!row) return `Error: process ${id} not found.`;
	if (!row.running) return `Process ${id} already exited with ${row.exitCode}.`;
	try {
		if (process.platform !== 'win32') process.kill(-row.proc.pid, 'SIGTERM');
		else row.proc.kill('SIGTERM');
	} catch {
		row.proc.kill('SIGTERM');
	}
	return `Stopped ${id}.`;
}

export function persistentProcessStatus(id?: string): string {
	const rows = id
		? [processes.get(id)].filter(Boolean)
		: listPersistentProcesses();
	if (rows.length === 0)
		return id ? `Error: process ${id} not found.` : 'No persistent processes.';
	return rows
		.map(row =>
			`${row!.id} · ${row!.running ? 'running' : `exit ${row!.exitCode}`} · ${row!.command}\n${row!.output.slice(-20).join('\n')}`.trim(),
		)
		.join('\n\n');
}
