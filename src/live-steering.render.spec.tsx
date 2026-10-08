import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from './app';
import {
	busy,
	messages,
	sessionId,
	steeringInbox,
	setInput,
	clearMessages,
	setBusy,
	setStartupLoading,
	setPendingTrust,
	setMode,
	context,
	setPendingQueue,
	setActiveAgentRuns,
} from './state';

const selected = process.env.BOBONYO_STEERING_TEST;
for (const scenario of [
	'burst',
	'escape',
	'switch',
	'preparation',
	'preparation escape',
	'preparation switch',
	'attachment',
	'tool batch',
	'resume',
	'finalization',
	'hook rejection',
	'scheduling barrier',
	'unknown slash',
	'preparation after-turn',
	'preparation immediate resume',
	'preparation retry',
	'failed retry',
	'tool retry',
]) {
	if (!selected) {
		test(`isolated live steering: ${scenario}`, async () => {
			const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
				env: {...process.env, BOBONYO_STEERING_TEST: scenario},
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
	test(`App accepts immediately and delivers safely: ${scenario}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), 'bobonyo-steering-'));
		process.env.BOBONYO_CONFIG_DIR = directory;
		process.env.BOBONYO_DATA_DIR = directory;
		process.env.NANOCODER_DATA_DIR = directory;
		delete process.env.NANOCODER_RESUME;
		let releaseHook!: () => void;
		const heldHook = new Promise<void>(resolve => {
			releaseHook = resolve;
		});
		let hookEntered = false;
		let hookCalls = 0;
		let initialPromptHooks = 0;
		const hookServer = Bun.serve({
			port: 0,
			async fetch(request) {
				const payload = (await request.json()) as {
					prompt?: string;
					hook_event_name: string;
				};
				hookCalls++;
				if (
					payload.hook_event_name === 'UserPromptSubmit' &&
					payload.prompt === 'initial request'
				) {
					initialPromptHooks++;
					if (scenario === 'failed retry' && initialPromptHooks > 1) {
						return Response.json({
							decision: 'block',
							reason: 'continuation must not resubmit the prompt',
						});
					}
				}
				if (
					payload.hook_event_name === 'UserPromptSubmit' &&
					payload.prompt === 'initial request' &&
					scenario.startsWith('preparation')
				) {
					hookEntered = true;
					await heldHook;
				}
				if (
					payload.hook_event_name === 'PreToolUse' &&
					(scenario === 'tool batch' || scenario === 'tool retry') &&
					!hookEntered
				) {
					hookEntered = true;
					await heldHook;
				}
				if (
					payload.hook_event_name === 'Stop' &&
					scenario === 'finalization' &&
					!hookEntered
				) {
					hookEntered = true;
					await heldHook;
				}
				if (
					scenario === 'hook rejection' &&
					payload.prompt === 'same direction'
				) {
					return Response.json({
						decision: 'block',
						reason: 'controlled preparation rejection',
					});
				}
				return Response.json({});
			},
		});
		writeFileSync(
			join(directory, 'hooks.json'),
			JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{hooks: [{type: 'http', url: hookServer.url.toString()}]},
					],
					PreToolUse: [
						{hooks: [{type: 'http', url: hookServer.url.toString()}]},
					],
					Stop: [{hooks: [{type: 'http', url: hookServer.url.toString()}]}],
				},
			}),
		);
		const requests: Array<{messages: Array<{role: string; content: string}>}> =
			[];
		let release!: () => void;
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests.push(await request.json());
				if (requests.length === 1 && !scenario.startsWith('preparation'))
					await held;
				if (requests.length === 1 && scenario === 'failed retry') {
					return new Response('controlled provider failure', {status: 403});
				}
				if (requests.length === 2 && scenario === 'tool retry') {
					return new Response('controlled post-tool failure', {status: 403});
				}
				if (
					requests.length === 1 &&
					(scenario === 'tool batch' || scenario === 'tool retry')
				) {
					const tool_calls = [
						{
							index: 0,
							id: 'steering_tool_1',
							type: 'function',
							function: {
								name: 'execute_bash',
								arguments: JSON.stringify({command: 'printf first-tool'}),
							},
						},
						{
							index: 1,
							id: 'steering_tool_2',
							type: 'function',
							function: {
								name: 'execute_bash',
								arguments: JSON.stringify({command: 'printf second-tool'}),
							},
						},
					];
					return new Response(
						'data: ' +
							JSON.stringify({choices: [{delta: {tool_calls}}]}) +
							'\n\ndata: [DONE]\n\n',
						{headers: {'Content-Type': 'text/event-stream'}},
					);
				}
				return new Response(
					'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n',
					{
						headers: {'Content-Type': 'text/event-stream'},
					},
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
			for (let i = 0; i < 200 && !predicate(); i++) {
				await Bun.sleep(10);
				await ui.flush();
			}
			expect(predicate()).toBe(true);
		};
		const send = async (value: string) => {
			setInput(value);
			ui.mockInput.pressEnter();
			await ui.flush();
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
			await send('initial request');
			if (scenario.startsWith('preparation')) {
				await waitFor(() => hookEntered);
				expect(requests).toHaveLength(0);
				expect(
					messages().filter(message => message.content === 'initial request'),
				).toHaveLength(1);
				await send('during preparation');
				expect(steeringInbox()).toHaveLength(2);
				if (scenario !== 'preparation') {
					ui.mockInput.pressEscape();
					await ui.flush();
				}
				if (scenario === 'preparation switch') {
					await send('/clear');
					await send('new session');
				}
				if (scenario === 'preparation immediate resume') {
					await send('resume before old preparation settles');
				}
				if (scenario === 'preparation retry') {
					await send('/retry');
					expect(steeringInbox()).toHaveLength(2);
					expect(
						messages().filter(message => message.content === 'initial request'),
					).toHaveLength(1);
				}
				releaseHook();
				if (
					scenario === 'preparation escape' ||
					scenario === 'preparation after-turn'
				) {
					await Bun.sleep(100);
					await ui.flush();
					expect(requests).toHaveLength(0);
					expect(steeringInbox()).toHaveLength(2);
					if (scenario === 'preparation after-turn') {
						await send('/loop @after-turn lifecycle probe');
					}
					await send('resume direction');
				}
				await waitFor(
					() => requests.length > 0 && !busy() && steeringInbox().length === 0,
				);
				const latest = requests.at(-1)!.messages;
				if (scenario === 'preparation after-turn') {
					await waitFor(() =>
						requests.some(request =>
							JSON.stringify(request).includes('lifecycle probe'),
						),
					);
					await send('/loop clear');
				}
				if (scenario === 'preparation switch') {
					expect(JSON.stringify(latest)).not.toContain('during preparation');
					expect(JSON.stringify(latest)).not.toContain('initial request');
				} else {
					expect(
						latest.filter(message =>
							message.content.includes('during preparation'),
						),
					).toHaveLength(1);
					expect(
						latest.filter(message =>
							message.content.includes('initial request'),
						),
					).toHaveLength(1);
					expect(
						messages().filter(
							message => message.content === 'during preparation',
						),
					).toHaveLength(1);
				}
				return;
			}
			await waitFor(() => requests.length === 1);
			const owner = sessionId();
			if (scenario === 'failed retry') {
				await send('later accepted direction');
				release();
				await waitFor(() => !busy());
				expect(steeringInbox()).toHaveLength(1);
				await send('/retry');
				await waitFor(() => requests.length === 2 && !busy());
				expect(initialPromptHooks).toBe(1);
				const next = requests[1]!.messages;
				expect(
					next.filter(message => message.content.includes('initial request')),
				).toHaveLength(1);
				expect(
					next.filter(message =>
						message.content.includes('later accepted direction'),
					),
				).toHaveLength(1);
				expect(
					next.findIndex(message =>
						message.content.includes('initial request'),
					),
				).toBeLessThan(
					next.findIndex(message =>
						message.content.includes('later accepted direction'),
					),
				);
				expect(
					messages().filter(message => message.content === 'initial request'),
				).toHaveLength(1);
				expect(
					messages().filter(
						message => message.content === 'later accepted direction',
					),
				).toHaveLength(1);
				expect(steeringInbox()).toEqual([]);
				return;
			}
			if (scenario === 'unknown slash') {
				await send('/workspace/missing-file.ts inspect this path');
				expect(
					messages().filter(
						message =>
							message.content ===
							'/workspace/missing-file.ts inspect this path',
					),
				).toHaveLength(1);
				await Bun.sleep(50);
				expect(requests).toHaveLength(1);
				expect(steeringInbox()).toHaveLength(1);
				release();
				await waitFor(() => requests.length === 2 && !busy());
				expect(
					requests[1]!.messages.filter(message =>
						message.content.includes(
							'/workspace/missing-file.ts inspect this path',
						),
					),
				).toHaveLength(1);
				expect(
					messages().filter(
						message =>
							message.content ===
							'/workspace/missing-file.ts inspect this path',
					),
				).toHaveLength(1);
				return;
			}
			if (scenario === 'scheduling barrier') {
				setActiveAgentRuns([
					{
						id: 'unrelated-agent',
						graphId: 'unrelated-running-graph',
						name: 'general',
						description: 'unrelated work',
						output: '',
						transcript: [],
						streaming: '',
						history: [],
						status: 'running',
					},
				]);
				setPendingQueue([
					{
						value: 'unrelated autonomous completion',
						source: 'task',
						graphId: 'unrelated-running-graph',
						owner: 'user',
					},
				]);
			}
			if (scenario === 'attachment') {
				const image = join(directory, 'temporary.png');
				writeFileSync(
					image,
					Buffer.from(
						'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
						'base64',
					),
				);
				await ui.mockInput.pasteBracketedText(image);
				await ui.flush();
				ui.mockInput.pressEnter();
				await ui.flush();
				expect(steeringInbox()).toHaveLength(1);
				const accepted = messages().find(message =>
					message.content.includes('[Image #1]'),
				)!;
				const savedImage = accepted.attachments?.['1'];
				expect(savedImage).toBeDefined();
				expect(savedImage).not.toBe(image);
				expect(existsSync(savedImage!)).toBe(true);
				rmSync(image);
				release();
				await waitFor(() => requests.length === 2 && !busy());
				expect(JSON.stringify(requests[1])).toContain(savedImage!);
				expect(
					messages().filter(
						message => message.steeringId === accepted.steeringId,
					),
				).toHaveLength(1);
				return;
			}
			if (scenario === 'tool batch' || scenario === 'tool retry') {
				release();
				await waitFor(() => hookEntered);
				await send('during tool batch');
				expect(requests).toHaveLength(1);
				expect(
					messages().filter(message => message.content === 'during tool batch'),
				).toHaveLength(1);
				releaseHook();
				await waitFor(() => requests.length === 2 && !busy());
				if (scenario === 'tool retry') {
					await send('/retry');
					await waitFor(() => requests.length === 3 && !busy());
					expect(
						messages().filter(
							message => message.content === 'during tool batch',
						),
					).toHaveLength(1);
					expect(
						requests[2]!.messages.filter(message =>
							message.content.includes('during tool batch'),
						),
					).toHaveLength(1);
				}
				const next = requests.at(-1)!.messages;
				expect(next.filter(message => message.role === 'tool')).toHaveLength(2);
				expect(
					next.findIndex(message =>
						message.content.includes('during tool batch'),
					),
				).toBeGreaterThan(
					next.findLastIndex(message => message.role === 'tool'),
				);
				expect(
					messages().filter(message => message.toolId === 'steering_tool_1'),
				).toHaveLength(1);
				expect(
					messages().filter(message => message.toolId === 'steering_tool_2'),
				).toHaveLength(1);
				expect(JSON.stringify(next)).toContain('first-tool');
				expect(JSON.stringify(next)).toContain('second-tool');
				return;
			}
			if (scenario === 'finalization') {
				release();
				await waitFor(() => hookEntered);
				await send('late finalization direction');
				expect(
					messages().filter(
						message => message.content === 'late finalization direction',
					),
				).toHaveLength(1);
				releaseHook();
				await waitFor(() => requests.length === 2 && !busy());
				expect(
					requests[1]!.messages.filter(message =>
						message.content.includes('late finalization direction'),
					),
				).toHaveLength(1);
				expect(steeringInbox()).toEqual([]);
				return;
			}
			await send('same direction');
			await send('/queue same direction');
			expect(
				messages().filter(
					message =>
						message.role === 'user' && message.content === 'same direction',
				),
			).toHaveLength(2);
			expect(steeringInbox()).toHaveLength(2);
			const saved = JSON.parse(
				readFileSync(join(directory, 'sessions', `${owner}.json`), 'utf8'),
			);
			expect(saved.steeringInbox).toHaveLength(2);
			expect(
				saved.messages.filter(
					(message: {content: string}) => message.content === 'same direction',
				),
			).toHaveLength(2);
			if (scenario === 'hook rejection') {
				release();
				await waitFor(() => !busy());
				await Bun.sleep(100);
				expect(requests).toHaveLength(2);
				expect(steeringInbox()).toHaveLength(2);
				expect(JSON.stringify(context())).not.toContain('same direction');
				expect(hookCalls).toBeLessThan(10);
			} else if (scenario === 'escape' || scenario === 'resume') {
				ui.mockInput.pressEscape();
				await ui.flush();
				release();
				await waitFor(() => !busy());
				await Bun.sleep(50);
				expect(requests).toHaveLength(1);
				expect(steeringInbox()).toHaveLength(2);
				if (scenario === 'resume') {
					await send('/clear');
					await send(`/resume ${owner}`);
					await waitFor(() => sessionId() === owner);
					expect(steeringInbox()).toHaveLength(2);
					expect(
						messages().filter(message => message.content === 'same direction'),
					).toHaveLength(2);
					await Bun.sleep(50);
					expect(requests).toHaveLength(1);
				}
				await send('resume direction');
				await waitFor(() => requests.length >= 2 && !busy());
				expect(steeringInbox()).toEqual([]);
				expect(
					requests
						.at(-1)!
						.messages.filter(message =>
							message.content.includes('same direction'),
						),
				).toHaveLength(2);
				expect(
					messages().filter(message => message.content === 'same direction'),
				).toHaveLength(2);
			} else if (scenario === 'switch') {
				ui.mockInput.pressEscape();
				release();
				await waitFor(() => !busy());
				await send('/clear');
				await waitFor(() => sessionId() !== owner);
				expect(steeringInbox()).toEqual([]);
				await send('new session');
				await waitFor(() => requests.length >= 2 && !busy());
				expect(JSON.stringify(requests.at(-1))).not.toContain('same direction');
			} else {
				release();
				await waitFor(() => requests.length === 2 && !busy());
				expect(
					requests[0]!.messages.filter(message =>
						message.content.includes('same direction'),
					),
				).toHaveLength(0);
				expect(
					requests[1]!.messages.filter(message =>
						message.content.includes('same direction'),
					),
				).toHaveLength(2);
				if (scenario === 'scheduling barrier') {
					expect(requests).toHaveLength(2);
					setPendingQueue([]);
					setActiveAgentRuns([]);
				}
				expect(steeringInbox()).toEqual([]);
				expect(
					messages().filter(
						message =>
							message.role === 'user' && message.content === 'same direction',
					),
				).toHaveLength(2);
			}
		} finally {
			release();
			releaseHook();
			ui.renderer.destroy();
			server.stop(true);
			hookServer.stop(true);
			rmSync(directory, {recursive: true, force: true});
		}
	}, 10000);
}
