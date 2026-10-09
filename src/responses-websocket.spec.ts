import {expect, test} from 'bun:test';
import {streamChat, setFallbackEndpoints} from './client';
import {executeTool, registerTool} from './tools';
import {
	ResponsesWebSocketError,
	streamResponsesWebSocket,
	supportsResponsesSteering,
	type ResponsesSocket,
	type ResponsesSteeringController,
	type ResponsesWebSocketOptions,
} from './responses-websocket';

class FakeSocket implements ResponsesSocket {
	listeners = new Map<string, Set<(event: any) => void>>();
	sent: any[] = [];
	closed = false;
	addEventListener(type: string, listener: (event: any) => void) {
		const entries = this.listeners.get(type) ?? new Set();
		entries.add(listener);
		this.listeners.set(type, entries);
	}
	removeEventListener(type: string, listener: (event: any) => void) {
		this.listeners.get(type)?.delete(listener);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
		this.emit('close');
	}
	emit(type: string, event = {}) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	event(event: any) {
		this.emit('message', {data: JSON.stringify(event)});
	}
	created(id: string) {
		this.event({type: 'response.created', response: {id}});
	}
	terminal(id: string, extra = {}, type = 'response.completed') {
		this.event({type, response: {id, output: [], ...extra}});
	}
	accepted(id: string, previous = 'r1') {
		this.event({
			type: 'response.steer.accepted',
			steer: {id, previous_response_id: previous},
		});
	}
}

function harness(
	extra: Partial<ResponsesWebSocketOptions> = {},
	signal?: AbortSignal,
) {
	const socket = new FakeSocket();
	let controller: ResponsesSteeringController | undefined;
	const result = streamResponsesWebSocket(
		'wss://api.openai.com/v1/responses',
		{authorization: 'Bearer test'},
		{
			model: 'gpt-6-astra',
			stream: true,
			store: false,
			input: 'initial',
			tools: [],
		},
		{onText: () => {}, onReasoning: () => {}},
		{
			enabled: true,
			register: value => {
				controller = value;
			},
			...extra,
			createSocket: () => socket,
		},
		signal,
	);
	return {socket, result, controller: () => controller};
}

const call = {
	type: 'function_call',
	call_id: 'c1',
	name: 'tool',
	arguments: '{}',
};
const output = {type: 'function_call_output', call_id: 'c1', output: 'ok'};

test('capability is official GPT6 Responses only', () => {
	const endpoint = {
		baseUrl: 'https://api.openai.com',
		model: 'gpt-6-astra',
		sdkProvider: 'responses',
	};
	expect(supportsResponsesSteering(endpoint)).toBe(true);
	expect(supportsResponsesSteering({...endpoint, model: 'gpt-6.1-sol'})).toBe(
		true,
	);
	for (const override of [
		{model: 'gpt-5.6'},
		{baseUrl: 'https://proxy.example'},
		{codexAccount: true},
		{sdkProvider: 'openai'},
		{baseUrl: 'http://api.openai.com'},
		{baseUrl: 'https://api.openai.com/custom'},
	]) {
		expect(supportsResponsesSteering({...endpoint, ...override})).toBe(false);
	}
});

test('accepted waits for successor; steered incomplete is normal', async () => {
	const h = harness();
	const c = h.controller()!;
	expect(c.submit('too early')).toBe(false);
	h.socket.emit('open');
	expect(h.socket.sent[0].stream).toBeUndefined();
	h.socket.created('r1');
	c.submit('smaller');
	expect(h.socket.sent[1]).toEqual({
		type: 'response.steer',
		previous_response_id: 'r1',
		input: 'smaller',
	});
	h.socket.accepted('s1');
	expect(c.snapshot()[0]?.status).toBe('accepted');
	h.socket.terminal(
		'r1',
		{
			incomplete_details: {reason: 'steered'},
			usage: {input_tokens: 2},
		},
		'response.incomplete',
	);
	expect(h.socket.closed).toBe(false);
	h.socket.created('r2');
	expect(c.snapshot()[0]?.status).toBe('applied');
	h.socket.event({type: 'response.output_text.delta', delta: 'done'});
	h.socket.terminal('r2', {usage: {input_tokens: 3}});
	expect(await h.result).toMatchObject({
		text: 'done',
		usage: {input_tokens: 5},
		toolCalls: [],
	});
	expect(h.socket.sent).toHaveLength(2);
	expect(h.controller()).toBeUndefined();
	expect(c.submit('late')).toBe(false);
});

test('multiple updates remain ordered across successors and normal completion', async () => {
	const h = harness();
	const c = h.controller()!;
	h.socket.created('r1');
	c.submit('one');
	c.submit('two');
	h.socket.terminal('r1');
	expect(h.socket.closed).toBe(false);
	h.socket.accepted('s1');
	h.socket.accepted('s2');
	h.socket.created('r2');
	expect(c.snapshot().map(s => s.status)).toEqual(['applied', 'applied']);
	c.submit('three');
	expect(h.socket.sent[2].previous_response_id).toBe('r2');
	h.socket.accepted('s3', 'r2');
	h.socket.terminal('r2');
	h.socket.created('r3');
	h.socket.terminal('r3');
	await h.result;
});

test('tool continuation is same socket, no replay or duplicate dispatch', async () => {
	let dispatches = 0;
	let finish!: (input: Array<Record<string, unknown>>) => void;
	const h = harness({
		onRequiredInput: request => {
			dispatches++;
			expect(request.toolCalls.map(call => call.id)).toEqual(['c1']);
			return new Promise(resolve => {
				finish = resolve;
			});
		},
	});
	h.socket.created('r1');
	h.controller()!.submit('update');
	h.socket.accepted('s1');
	h.socket.event({type: 'response.output_item.done', item: call});
	h.socket.terminal('r1', {output: [call]});
	h.socket.event({
		type: 'response.steer.pending',
		steer: {id: 's1', previous_response_id: 'r1'},
		required_input: [{type: 'function_call_output', call_id: 'c1'}],
	});
	expect(dispatches).toBe(1);
	finish([output]);
	await Promise.resolve();
	expect(h.socket.sent[1]).toEqual({
		type: 'response.create',
		model: 'gpt-6-astra',
		store: false,
		tools: [],
		previous_response_id: 'r1',
		input: [output],
	});
	h.socket.created('r2');
	h.socket.terminal('r2');
	expect((await h.result).toolCalls).toEqual([]);
});

test('mismatched tool output cannot continue', async () => {
	const h = harness({
		onRequiredInput: async () => [{...output, call_id: 'wrong'}],
	});
	h.socket.created('r1');
	h.socket.terminal('r1', {output: [call]});
	await expect(h.result).rejects.toThrow('do not match');
	expect(h.socket.sent).toHaveLength(0);
});

test('disconnect retains uncertainty and late tool output sends nothing', async () => {
	let finish!: (input: Array<Record<string, unknown>>) => void;
	const h = harness({
		onRequiredInput: () =>
			new Promise(resolve => {
				finish = resolve;
			}),
	});
	const c = h.controller()!;
	h.socket.created('r1');
	c.submit('update');
	h.socket.accepted('s1');
	h.socket.terminal('r1', {output: [call]});
	h.socket.emit('close');
	expect(c.snapshot()[0]?.status).toBe('uncertain');
	// Failure retains foreground ownership until dispatched tool work unwinds.
	// Resolve that work before awaiting rejection; the opposite order deadlocks.
	finish([output]);
	await expect(h.result).rejects.toBeInstanceOf(ResponsesWebSocketError);
	expect(h.socket.sent).toHaveLength(1);
});

test('abort marks queued ownership uncertain and removes listeners', async () => {
	const abort = new AbortController();
	const h = harness({}, abort.signal);
	const c = h.controller()!;
	h.socket.created('r1');
	c.submit('update');
	abort.abort();
	await expect(h.result).rejects.toHaveProperty('name', 'AbortError');
	expect(c.snapshot()[0]?.status).toBe('uncertain');
	expect(h.socket.listeners.get('message')?.size).toBe(0);
});

test('steer failure is explicit; other submissions remain uncertain', async () => {
	const h = harness();
	const c = h.controller()!;
	h.socket.created('r1');
	c.submit('one');
	c.submit('two');
	h.socket.event({
		type: 'response.steer.failed',
		steer: {id: 's1', previous_response_id: 'r1'},
		error: {message: 'unsupported'},
	});
	await expect(h.result).rejects.toThrow('unsupported');
	expect(c.snapshot().map(s => s.status)).toEqual(['failed', 'uncertain']);
});

test('abort waits for dispatched tool settlement before releasing the turn', async () => {
	const abort = new AbortController();
	let finish!: (input: Array<Record<string, unknown>>) => void;
	let settled = false;
	const h = harness(
		{
			onRequiredInput: () =>
				new Promise(resolve => {
					finish = resolve;
				}),
		},
		abort.signal,
	);
	const observed = h.result.then(
		() => {
			settled = true;
			return undefined;
		},
		error => {
			settled = true;
			return error;
		},
	);
	try {
		h.socket.created('r1');
		h.controller()!.submit('update');
		h.socket.terminal('r1', {output: [call]});
		abort.abort();
		await Bun.sleep(10);
		expect(settled).toBe(false);
		expect(h.controller()).toBeUndefined();
	} finally {
		// Always settle local work before awaiting the outer rejection.
		finish([output]);
		expect(await observed).toHaveProperty('name', 'AbortError');
	}
	expect(h.socket.sent).toHaveLength(1);
}, 2000);

test('malformed native arguments reject instead of executing tool defaults', async () => {
	let effects = 0;
	registerTool('native_malformed_defaults', {
		parameters: {type: 'object', properties: {}},
		execute: async () => {
			effects++;
			return 'executed default';
		},
	});
	let received: Record<string, unknown> | undefined;
	let resultContent = '';
	const h = harness({
		onRequiredInput: async request => {
			received = request.toolCalls[0]!.arguments;
			const result = await executeTool(request.toolCalls[0]!);
			resultContent = result.content;
			return [
				{
					type: 'function_call_output',
					call_id: result.tool_call_id,
					output: result.content,
				},
			];
		},
	});
	try {
		h.socket.created('r1');
		h.socket.terminal('r1', {
			output: [
				{...call, name: 'native_malformed_defaults', arguments: '{broken'},
			],
		});
		await Bun.sleep(10);
		expect(received).toEqual({_malformed: '{broken'});
		expect(effects).toBe(0);
		expect(resultContent).toContain('Error: Invalid tool arguments: {broken');
	} finally {
		h.socket.created('r2');
		h.socket.terminal('r2');
		await h.result;
	}
}, 2000);

test.each([
	{type: 'error', error: {message: 'bad request'}},
	{type: 'response.created', response: {}},
	{type: 'response.output_text.delta', delta: 2},
	{type: 'response.steer.accepted', steer: {}},
	{type: 'response.failed', response: {error: {message: 'failed'}}},
])('malformed/error event fails safely: %j', async event => {
	const h = harness();
	h.socket.event(event);
	await expect(h.result).rejects.toBeInstanceOf(ResponsesWebSocketError);
	expect(h.socket.closed).toBe(true);
});

test('invalid JSON fails safely', async () => {
	const h = harness();
	h.socket.emit('message', {data: '{'});
	await expect(h.result).rejects.toThrow('Malformed');
});

test('successor sequence may reset and late acknowledgement commits only its parent', async () => {
	const h = harness();
	const c = h.controller()!;
	h.socket.event({
		type: 'response.created',
		sequence_number: 10,
		response: {id: 'r1'},
	});
	c.submit('update');
	h.socket.terminal('r1');
	h.socket.event({
		type: 'response.created',
		sequence_number: 0,
		response: {id: 'r2', previous_response_id: 'r1'},
	});
	expect(c.snapshot()[0]?.status).toBe('sent');
	h.socket.accepted('s1');
	expect(c.snapshot()[0]?.successorResponseId).toBe('r2');
	h.socket.terminal('r2');
	await h.result;
});

test('reasoning shares the total output budget', async () => {
	const socket = new FakeSocket();
	const result = streamResponsesWebSocket(
		'wss://api.openai.com/v1/responses',
		{},
		{},
		{
			onText: () => {},
			onReasoning: () => {},
		},
		{enabled: true, register: () => {}, createSocket: () => socket},
		undefined,
		{
			maxOutputChars: 3,
			maxDurationMs: 1000,
			stallTimeoutMs: 1000,
		},
	);
	socket.event({type: 'response.reasoning_summary_text.delta', delta: 'four'});
	await expect(result).rejects.toThrow('output limit');
});

test('approval continuation matches required approval request', async () => {
	const h = harness({
		onRequiredInput: async request => {
			expect(request.requiredInput).toEqual([
				{type: 'mcp_approval_response', approval_request_id: 'a1'},
			]);
			return [
				{
					type: 'mcp_approval_response',
					approval_request_id: 'a1',
					approve: true,
				},
			];
		},
	});
	h.socket.created('r1');
	h.socket.terminal('r1', {output: [{type: 'mcp_approval_request', id: 'a1'}]});
	await Promise.resolve();
	expect(h.socket.sent[0].input[0].approve).toBe(true);
	h.socket.created('r2');
	h.socket.terminal('r2');
	await h.result;
});

test('pre-acceptance failure without steer id maps original input', async () => {
	const h = harness();
	const c = h.controller()!;
	h.socket.created('r1');
	c.submit('one');
	c.submit('two');
	h.socket.event({
		type: 'response.steer.failed',
		steer: {previous_response_id: 'r1', input: 'two'},
	});
	await expect(h.result).rejects.toThrow('steering failed');
	expect(c.snapshot().map(s => s.status)).toEqual(['uncertain', 'failed']);
});

test('client retains SSE for unsupported model and tools without continuation callback', async () => {
	const originalFetch = globalThis.fetch;
	let sockets = 0;
	let requests = 0;
	globalThis.fetch = (async () => {
		requests++;
		return new Response(
			'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
		);
	}) as unknown as typeof fetch;
	try {
		for (const [model, tools] of [
			['gpt-5.6', []],
			['gpt-6-astra', [{name: 'tool'}]],
		] as const) {
			await streamChat(
				[{role: 'user', content: 'test'}],
				{
					onText: () => {},
					onReasoning: () => {},
					responsesWebSocket: {
						enabled: true,
						register: () => {},
						createSocket: () => {
							sockets++;
							return new FakeSocket();
						},
					},
				},
				undefined,
				[...tools],
				undefined,
				undefined,
				undefined,
				{
					id: 'ws-test',
					baseUrl: 'https://api.openai.com',
					apiKey: 'test',
					model,
					sdkProvider: 'responses',
				},
			);
		}
		expect(requests).toBe(2);
		expect(sockets).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('native connection failure never retries or falls back even before text', async () => {
	const socket = new FakeSocket();
	let sockets = 0;
	const originalFetch = globalThis.fetch;
	let fallbackRequests = 0;
	globalThis.fetch = (async () => {
		fallbackRequests++;
		throw new Error('fallback must not run');
	}) as unknown as typeof fetch;
	setFallbackEndpoints([
		{
			id: 'fallback',
			baseUrl: 'https://proxy.example',
			apiKey: '',
			model: 'fallback',
		},
	]);
	try {
		const result = streamChat(
			[{role: 'user', content: 'test'}],
			{
				onText: () => {},
				onReasoning: () => {},
				responsesWebSocket: {
					enabled: true,
					register: () => {},
					createSocket: () => {
						sockets++;
						queueMicrotask(() => socket.emit('close'));
						return socket;
					},
				},
			},
			undefined,
			[],
			undefined,
			undefined,
			undefined,
			{
				id: 'ws-test',
				baseUrl: 'https://api.openai.com',
				apiKey: 'test',
				model: 'gpt-6-astra',
				sdkProvider: 'responses',
			},
		);
		await expect(result).rejects.toBeInstanceOf(ResponsesWebSocketError);
		expect(sockets).toBe(1);
		expect(fallbackRequests).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
		setFallbackEndpoints([]);
	}
});
