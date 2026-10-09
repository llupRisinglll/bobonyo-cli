import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from './app';
import {registerTool} from './tools';
import {
	busy,
	clearMessages,
	context,
	messages,
	steeringInbox,
	setActiveEndpoint,
	setBusy,
	setInput,
	setMode,
	setPendingTrust,
	setStartupLoading,
	startupLoading,
	pendingQuestion,
} from './state';

class FakeSocket {
	static current: FakeSocket;
	static sent: any[] = [];
	listeners = new Map<string, Set<(event: any) => void>>();
	constructor() {
		FakeSocket.current = this;
		queueMicrotask(() => this.emit('open', {}));
	}
	addEventListener(type: string, listener: (event: any) => void) {
		const entries = this.listeners.get(type) ?? new Set();
		entries.add(listener);
		this.listeners.set(type, entries);
	}
	removeEventListener(type: string, listener: (event: any) => void) {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string, event: any) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	event(event: any) {
		this.emit('message', {data: JSON.stringify(event)});
	}
	send(data: string) {
		FakeSocket.sent.push(JSON.parse(data));
		if (FakeSocket.sent.length === 1) {
			queueMicrotask(() =>
				this.event({
					type: 'response.created',
					response: {id: 'r1'},
				}),
			);
		}
	}
	close() {}
}

if (!process.env.BOBONYO_NATIVE_RENDER_TEST) {
	for (const scenario of [
		'tools',
		'ordinary',
		'disconnect',
		'discard',
		'tool disconnect',
		'parallel disconnect',
		'parallel rejecting disconnect',
	]) {
		test('isolated App native delivery and tools', async () => {
			const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
				env: {...process.env, BOBONYO_NATIVE_RENDER_TEST: scenario},
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code) throw new Error(`${stdout}\n${stderr}`);
			expect(code).toBe(0);
		}, 20000);
	}
} else {
	test('real App submits while stream is held and uses existing tool pipeline', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'bobonyo-native-'));
		process.env.BOBONYO_CONFIG_DIR = directory;
		process.env.BOBONYO_DATA_DIR = directory;
		process.env.NANOCODER_DATA_DIR = directory;
		process.env.BOBONYO_NATIVE_STEERING = process.env
			.BOBONYO_NATIVE_NEGATIVE_CONTROL
			? '0'
			: '1';
		delete process.env.NANOCODER_RESUME;
		const server = Bun.serve({port: 0, fetch: () => new Response('')});
		process.env.MOCK_URL = server.url.toString();
		const original = globalThis.WebSocket;
		globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
		clearMessages();
		setBusy(false);
		setStartupLoading([]);
		setPendingTrust(null);
		setMode('auto-accept');
		let effects = 0;
		let releaseFirst!: () => void;
		const heldTool = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		registerTool('native_race_mutation', {
			readOnly: process.env.BOBONYO_NATIVE_RENDER_TEST!.startsWith('parallel'),
			description:
				'Controlled sequential mutation for native disconnect regression',
			parameters: {type: 'object', properties: {}},
			execute: async (_args, ctx) => {
				effects++;
				if (effects === 3) {
					await new Promise<void>((_resolve, reject) => {
						ctx.signal!.addEventListener(
							'abort',
							() => reject(new DOMException('Cancelled sibling', 'AbortError')),
							{once: true},
						);
					});
				}
				if (effects === 1) await heldTool;
				return 'settled-first-effect';
			},
		});
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
				console.error(
					ui
						.captureSpans()
						.lines.map(line => line.spans.map(span => span.text).join(''))
						.join('\n'),
					messages(),
					steeringInbox(),
				);
			expect(predicate()).toBe(true);
		};
		const send = async (value: string) => {
			setInput(value);
			ui.mockInput.pressEnter();
			await ui.flush();
		};
		try {
			await ui.flush();
			await waitFor(() => startupLoading().length === 0);
			await Bun.sleep(100);
			await waitFor(
				() =>
					!ui
						.captureSpans()
						.lines.flatMap(line => line.spans.map(span => span.text))
						.join('')
						.includes('Loading skills'),
			);
			setActiveEndpoint({
				id: 'native-test',
				name: 'Native test',
				contextWindow: 128000,
				baseUrl: 'https://api.openai.com',
				apiKey: 'test',
				model: 'gpt-6.1-sol',
				models: ['gpt-6.1-sol'],
				sdkProvider: 'responses',
			});
			await send('initial request');
			await waitFor(() => FakeSocket.sent.length === 1);
			await send('change direction immediately');
			await waitFor(() =>
				FakeSocket.sent.some(event => event.type === 'response.steer'),
			);
			expect(busy()).toBe(true);
			expect(steeringInbox()).toHaveLength(1);
			const socket = FakeSocket.current;
			socket.event({
				type: 'response.steer.accepted',
				steer: {id: 's1', previous_response_id: 'r1'},
			});
			expect(steeringInbox()).toHaveLength(1);
			expect(
				context().filter(message =>
					message.content.includes('change direction immediately'),
				),
			).toHaveLength(0);
			if (
				[
					'tool disconnect',
					'parallel disconnect',
					'parallel rejecting disconnect',
				].includes(process.env.BOBONYO_NATIVE_RENDER_TEST!)
			) {
				const parallel =
					process.env.BOBONYO_NATIVE_RENDER_TEST!.startsWith('parallel');
				const rejecting =
					process.env.BOBONYO_NATIVE_RENDER_TEST ===
					'parallel rejecting disconnect';
				socket.event({
					type: 'response.completed',
					response: {
						id: 'r1',
						output: [
							{
								type: 'function_call',
								call_id: 'c1',
								name: 'native_race_mutation',
								arguments: '{}',
							},
							{
								type: 'function_call',
								call_id: 'c2',
								name: 'native_race_mutation',
								arguments: '{}',
							},
							...(rejecting
								? [
										{
											type: 'function_call',
											call_id: 'c3',
											name: 'native_race_mutation',
											arguments: '{}',
										},
									]
								: []),
						],
					},
				});
				await waitFor(() => effects === (rejecting ? 3 : parallel ? 2 : 1));
				socket.emit('close', {});
				if (rejecting) {
					await Bun.sleep(30);
					await ui.flush();
				}
				expect(busy()).toBe(true);
				releaseFirst();
				await waitFor(() => !busy());
				expect(effects).toBe(rejecting ? 3 : parallel ? 2 : 1);
				expect(
					context().some(message =>
						message.tool_calls?.some(call => call.id === 'c3'),
					),
				).toBe(false);
				expect(
					context().filter(
						message => message.role === 'tool' && message.tool_call_id === 'c1',
					),
				).toHaveLength(1);
				expect(
					context().some(message =>
						message.tool_calls?.some(call => call.id === 'c2'),
					),
				).toBe(parallel);
				if (parallel) {
					for (const id of ['c1', 'c2']) {
						expect(
							context().filter(
								message =>
									message.role === 'tool' && message.tool_call_id === id,
							),
						).toEqual([
							{role: 'tool', content: 'settled-first-effect', tool_call_id: id},
						]);
					}
				}
				expect(
					FakeSocket.sent.filter(event => event.type === 'response.create'),
				).toHaveLength(1);
				return;
			}
			if (
				['disconnect', 'discard'].includes(
					process.env.BOBONYO_NATIVE_RENDER_TEST!,
				)
			) {
				socket.emit('close', {});
				await waitFor(() => !busy());
				expect(steeringInbox()[0]?.nativeOwnership).toBe('uncertain');
				await waitFor(
					() => pendingQuestion()?.header === 'Retained native direction',
				);
				expect(pendingQuestion()!.question).toContain('may already have acted');
				ui.mockInput.pressEnter();
				await ui.flush();
				expect(steeringInbox()).toHaveLength(1);
				await send('/retry');
				await waitFor(
					() => pendingQuestion()?.header === 'Retained native direction',
				);
				expect(FakeSocket.sent).toHaveLength(2);
				ui.mockInput.pressArrow('down');
				if (process.env.BOBONYO_NATIVE_RENDER_TEST === 'discard')
					ui.mockInput.pressArrow('down');
				ui.mockInput.pressEnter();
				await ui.flush();
				if (process.env.BOBONYO_NATIVE_RENDER_TEST === 'discard') {
					await waitFor(() => steeringInbox().length === 0);
					expect(
						messages().find(
							message => message.content === 'change direction immediately',
						)?.steeringStatus,
					).toBe('discarded');
					await send('new direction after discard');
				}
				await waitFor(
					() =>
						FakeSocket.sent.filter(event => event.type === 'response.create')
							.length === 2,
				);
				const retryRequest = FakeSocket.sent.at(-1);
				expect(JSON.stringify(retryRequest.input)).toContain(
					process.env.BOBONYO_NATIVE_RENDER_TEST === 'discard'
						? 'new direction after discard'
						: 'change direction immediately',
				);
				if (process.env.BOBONYO_NATIVE_RENDER_TEST === 'discard')
					expect(JSON.stringify(retryRequest.input)).not.toContain(
						'change direction immediately',
					);
				FakeSocket.current.event({
					type: 'response.created',
					response: {id: 'retry'},
				});
				FakeSocket.current.event({
					type: 'response.output_text.delta',
					delta: 'Recovered.',
				});
				FakeSocket.current.event({
					type: 'response.completed',
					response: {id: 'retry', output: []},
				});
				await waitFor(() => !busy());
				expect(
					FakeSocket.sent.filter(event => event.type === 'response.steer'),
				).toHaveLength(1);
				return;
			}
			socket.event({
				type: 'response.output_text.delta',
				delta: 'I will inspect this once.',
			});
			if (process.env.BOBONYO_NATIVE_RENDER_TEST === 'tools') {
				socket.event({
					type: 'response.completed',
					response: {
						id: 'r1',
						output: [
							{
								type: 'function_call',
								call_id: 'c1',
								name: 'execute_bash',
								arguments: '{"command":"printf native-tool-result"}',
							},
						],
					},
				});
				await waitFor(
					() =>
						FakeSocket.sent.filter(event => event.type === 'response.create')
							.length === 2,
				);
				const continuation = FakeSocket.sent.at(-1);
				expect(continuation.previous_response_id).toBe('r1');
				expect(continuation.input).toHaveLength(1);
				expect(continuation.input[0].output).toContain('native-tool-result');
			} else {
				socket.event({
					type: 'response.incomplete',
					response: {
						id: 'r1',
						output: [],
						incomplete_details: {reason: 'steered'},
					},
				});
			}
			socket.event({
				type: 'response.created',
				response: {id: 'r2', previous_response_id: 'r1'},
			});
			expect(steeringInbox()).toHaveLength(0);
			socket.event({
				type: 'response.output_text.delta',
				delta: 'Updated final answer.',
			});
			socket.event({
				type: 'response.completed',
				response: {id: 'r2', output: []},
			});
			await waitFor(() => !busy());
			expect(
				FakeSocket.sent.filter(event => event.type === 'response.steer'),
			).toHaveLength(1);
			expect(
				FakeSocket.sent.filter(event => event.type === 'response.create'),
			).toHaveLength(
				process.env.BOBONYO_NATIVE_RENDER_TEST === 'tools' ? 2 : 1,
			);
			expect(
				context().filter(message =>
					message.content.includes('I will inspect this once.'),
				),
			).toHaveLength(1);
			expect(
				context().filter(message =>
					message.content.includes('Updated final answer.'),
				),
			).toHaveLength(1);
			expect(
				messages().filter(
					message => message.content === 'change direction immediately',
				),
			).toHaveLength(1);
			expect(
				context().filter(message =>
					message.content.includes('change direction immediately'),
				),
			).toHaveLength(1);
		} finally {
			releaseFirst();
			ui.renderer.destroy();
			globalThis.WebSocket = original;
			server.stop(true);
			rmSync(directory, {recursive: true, force: true});
		}
	}, 15000);
}
