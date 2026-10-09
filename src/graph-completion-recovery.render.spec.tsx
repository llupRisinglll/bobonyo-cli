import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {mkdtempSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from './app';
import {enqueueTaskNotification} from './background-notification';
import type {SessionData} from './session';
import {
	busy,
	context,
	messages,
	sessionId,
	tasks,
	clearMessages,
	setBusy,
	setInput,
	setMode,
	setPendingQueue,
	setPendingTrust,
	setStartupLoading,
	setTasks,
} from './state';

const selected = process.env.BOBONYO_GRAPH_RECOVERY_TEST;
for (const scenario of ['native calls', 'tool-shaped text']) {
	if (!selected) {
		test(`isolated App graph recovery: ${scenario}`, async () => {
			const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
				env: {...process.env, BOBONYO_GRAPH_RECOVERY_TEST: scenario},
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
			expect(code).toBe(0);
		}, 15000);
		continue;
	}
	if (selected !== scenario) continue;
	test(`App rejects ${scenario} for a missing completion owner without changing foreground`, async () => {
		const directory = mkdtempSync(join(tmpdir(), 'bobonyo-graph-recovery-'));
		process.env.BOBONYO_CONFIG_DIR = directory;
		process.env.BOBONYO_DATA_DIR = directory;
		process.env.NANOCODER_DATA_DIR = directory;
		delete process.env.NANOCODER_RESUME;
		const marker = join(directory, 'unauthorized-tool-executed');
		const requests: Array<{
			messages: Array<{role: string; content: string}>;
			tools?: unknown[];
			tool_choice?: unknown;
		}> = [];
		let releaseForeground!: () => void;
		const foregroundHeld = new Promise<void>(resolve => {
			releaseForeground = resolve;
		});
		let releaseCompletion!: () => void;
		const completionHeld = new Promise<void>(resolve => {
			releaseCompletion = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests.push(await request.json());
				if (requests.length === 1) {
					await foregroundHeld;
					return new Response(
						'data: {"choices":[{"delta":{"content":"foreground answer remains private"}}]}\n\ndata: [DONE]\n\n',
					);
				}
				await completionHeld;
				const calls = [
					{
						name: 'write_tasks',
						arguments: {
							title: 'unauthorized',
							tasks: [{id: 'bad', title: 'bad', status: 'completed'}],
						},
					},
					{
						name: 'task_create',
						arguments: {title: 'unauthorized created task'},
					},
					{name: 'execute_bash', arguments: {command: `touch ${marker}`}},
				];
				const delta =
					scenario === 'native calls'
						? {
								tool_calls: calls.map((call, index) => ({
									index,
									id: `forbidden-${index}`,
									type: 'function',
									function: {
										name: call.name,
										arguments: JSON.stringify(call.arguments),
									},
								})),
							}
						: {
								content: `<function=write_tasks>${JSON.stringify(calls[0]!.arguments)}</function>`,
							};
				return new Response(
					`data: ${JSON.stringify({choices: [{delta, finish_reason: 'tool_calls'}]})}\n\ndata: [DONE]\n\n`,
				);
			},
		});
		process.env.MOCK_URL = server.url.toString();
		clearMessages();
		setBusy(false);
		setStartupLoading([]);
		setPendingTrust(null);
		setMode('auto-accept');
		const ui = await testRender(() => <App />, {
			width: 100,
			height: 35,
			kittyKeyboard: true,
		});
		const waitFor = async (predicate: () => boolean) => {
			for (let i = 0; i < 300 && !predicate(); i++) {
				await Bun.sleep(10);
				await ui.flush();
			}
			if (!predicate())
				throw new Error(
					JSON.stringify({
						requests: requests.length,
						busy: busy(),
						messages: messages(),
						screen: ui
							.captureSpans()
							.lines.map(line => line.spans.map(span => span.text).join('')),
					}),
				);
		};
		try {
			await ui.flush();
			await waitFor(
				() =>
					!ui
						.captureSpans()
						.lines.flatMap(line => line.spans.map(span => span.text))
						.join('')
						.includes('Loading skills'),
			);
			setInput('private foreground request');
			ui.mockInput.pressEnter();
			await waitFor(() => requests.length === 1);
			const foregroundChecklist = [
				{
					id: 'foreground-task',
					title: 'private foreground checklist',
					status: 'in_progress' as const,
				},
			];
			setTasks(foregroundChecklist);
			const graphId = `session:${sessionId()}:work:missing-legacy-owner`;
			setPendingQueue(
				enqueueTaskNotification([], {
					kind: 'agent',
					id: 'legacy-worker',
					status: 'completed',
					output: 'isolated worker evidence',
					owner: 'user',
					graphId,
				}),
			);
			releaseForeground();
			await waitFor(() => requests.length === 2);
			const foregroundContext = structuredClone(context());
			const file = join(directory, 'sessions', `${sessionId()}.json`);
			const readSaved = () =>
				JSON.parse(readFileSync(file, 'utf8')) as SessionData;
			const during = readSaved();
			const foregroundGraph = during.graphContexts!.latestGraphId!;
			const foregroundSnapshot = structuredClone(
				during.graphContexts!.graphs[foregroundGraph],
			);
			expect(foregroundContext).toContainEqual({
				role: 'assistant',
				content: 'foreground answer remains private',
			});
			expect(requests[0]!.tools!.length).toBeGreaterThan(0);
			expect(requests[1]!.tools).toEqual([]);
			expect(requests[1]!.tool_choice).toBe('none');
			const recoveryInput = requests[1]!.messages.filter(
				message => message.role !== 'system',
			);
			expect(recoveryInput).toHaveLength(1);
			expect(JSON.stringify(recoveryInput)).toContain(
				'isolated worker evidence',
			);
			expect(JSON.stringify(recoveryInput)).not.toContain('private foreground');
			releaseCompletion();
			await waitFor(
				() =>
					!busy() &&
					messages().some(message =>
						message.content.includes('no tools were executed'),
					),
			);
			const saved = readSaved();
			expect(context()).toEqual(foregroundContext);
			expect(tasks()).toEqual(foregroundChecklist);
			expect(saved.context).toEqual(foregroundContext);
			expect(saved.tasks).toEqual(foregroundChecklist);
			expect(saved.graphContexts!.latestGraphId).toBe(foregroundGraph);
			expect(saved.graphContexts!.graphs[foregroundGraph]).toEqual(
				foregroundSnapshot,
			);
			const isolated = saved.graphContexts!.graphs[graphId]!;
			expect(isolated.evidenceOnly).toBe(true);
			expect(isolated.checklist).toEqual([]);
			expect(JSON.stringify(isolated.history)).toContain(
				'isolated worker evidence',
			);
			expect(JSON.stringify(isolated.history)).not.toContain(
				'private foreground',
			);
			expect(
				isolated.history.some(
					message => message.role === 'tool' || message.tool_calls?.length,
				),
			).toBe(false);
			expect(
				messages().filter(message => message.toolId?.startsWith('forbidden-')),
			).toEqual([]);
			expect(existsSync(marker)).toBe(false);
			expect(requests).toHaveLength(2);
		} finally {
			releaseForeground();
			releaseCompletion();
			ui.renderer.destroy();
			server.stop(true);
			rmSync(directory, {recursive: true, force: true});
		}
	}, 10000);
}
