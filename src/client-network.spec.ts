import {afterEach, beforeEach, expect, test} from 'bun:test';
import {
	streamChat,
	setFallbackEndpoints,
	enforceDisabledTools,
	responsesToolBlocks,
} from './client';
import {assertGraphToolExecution} from './graph-context';
import {activeEndpoint, setActiveEndpoint, retryingAttempt} from './state';

const socketError = () =>
	Object.assign(new Error('The socket connection was closed unexpectedly.'), {
		code: 'ECONNRESET',
	});
const realFetch = globalThis.fetch;
let original: ReturnType<typeof activeEndpoint>;
beforeEach(() => {
	original = activeEndpoint();
	setActiveEndpoint({
		id: 'network-test',
		name: 'Network Test',
		baseUrl: 'http://127.0.0.1:1',
		apiKey: 'test',
		model: 'test',
		models: ['test'],
		contextWindow: 128000,
	});
});
afterEach(() => {
	globalThis.fetch = realFetch;
	setActiveEndpoint(original);
	setFallbackEndpoints([]);
});
const success = () =>
	new Response(
		'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		{headers: {'content-type': 'text/event-stream'}},
	);
const handlers = () => {
	const text: string[] = [];
	return {
		text,
		onText: (delta: string) => text.push(delta),
		onReasoning: () => {},
	};
};
test.each(['openai', 'responses', 'anthropic'])(
	'tool-free recovery disables all tools on %s wire despite provider overrides',
	async sdkProvider => {
		setActiveEndpoint({
			...activeEndpoint(),
			sdkProvider,
			providerOptions: {
				tools: [{type: 'web_search'}],
				tool_choice: 'required',
				functions: [{name: 'write_tasks'}],
				function_call: {name: 'write_tasks'},
				parallel_tool_calls: true,
			},
		});
		let body: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(null, {status: 200});
		}) as typeof fetch;
		await streamChat(
			[{role: 'user', content: 'own completion evidence'}],
			handlers(),
			undefined,
			[{name: 'write_tasks'}],
			undefined,
			undefined,
			undefined,
			undefined,
			{disableTools: true},
		);
		expect(body.tools).toEqual([]);
		expect(body.tool_choice).toEqual(
			sdkProvider === 'anthropic' ? {type: 'none'} : 'none',
		);
		expect(body.functions).toBeUndefined();
		expect(body.function_call).toBeUndefined();
		expect(body.parallel_tool_calls).toBeUndefined();
	},
);
test('tool-free recovery removes implicitly enabled Codex native search', () => {
	const body: Record<string, unknown> = {tools: responsesToolBlocks([], true)};
	expect(body.tools).toEqual([{type: 'web_search'}]);
	enforceDisabledTools(body, {disableTools: true});
	expect(body.tools).toEqual([]);
	expect(body.tool_choice).toBe('none');
});
test('tool-free boundary survives provider fallback', async () => {
	setFallbackEndpoints([
		{
			id: 'fallback',
			baseUrl: 'http://127.0.0.1:2',
			apiKey: 'test',
			model: 'test',
			sdkProvider: 'responses',
			providerOptions: {tools: [{type: 'web_search'}]},
		},
	]);
	const bodies: Record<string, unknown>[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return bodies.length === 1
			? new Response('failed', {status: 400})
			: new Response(null, {status: 200});
	}) as unknown as typeof fetch;
	await streamChat(
		[{role: 'user', content: 'own evidence'}],
		handlers(),
		undefined,
		[{name: 'write_tasks'}],
		undefined,
		undefined,
		undefined,
		undefined,
		{disableTools: true},
	);
	expect(bodies).toHaveLength(2);
	for (const body of bodies) {
		expect(body.tools).toEqual([]);
		expect(body.tool_choice).toBe('none');
	}
});
test('unsolicited native search events are rejected by the recovery handler', async () => {
	setActiveEndpoint({...activeEndpoint(), sdkProvider: 'responses'});
	const event = {
		type: 'response.output_item.done',
		item: {type: 'web_search_call', action: {query: 'unauthorized'}},
	};
	globalThis.fetch = (async () =>
		new Response(
			`data: ${JSON.stringify(event)}\n\n`,
		)) as unknown as typeof fetch;
	let presented = false;
	await expect(
		streamChat(
			[{role: 'user', content: 'own evidence'}],
			{
				...handlers(),
				onWebSearch: action => {
					assertGraphToolExecution({evidenceOnly: true}, [action]);
					presented = true;
				},
			},
			undefined,
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			{disableTools: true},
		),
	).rejects.toThrow('no tools were executed');
	expect(presented).toBe(false);
});
test('a provider ignoring the empty catalog cannot execute its hallucinated checklist call', async () => {
	const event = {
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: 'bad',
							function: {name: 'write_tasks', arguments: '{}'},
						},
					],
				},
				finish_reason: 'tool_calls',
			},
		],
	};
	globalThis.fetch = (async () =>
		new Response(
			`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
		)) as unknown as typeof fetch;
	const result = await streamChat(
		[{role: 'user', content: 'own evidence'}],
		handlers(),
		undefined,
		[],
		undefined,
		undefined,
		undefined,
		undefined,
		{disableTools: true},
	);
	expect(result.toolCalls).toHaveLength(1);
	let executed = false;
	expect(() => {
		assertGraphToolExecution({evidenceOnly: true}, result.toolCalls);
		executed = true;
	}).toThrow('no tools were executed');
	expect(executed).toBe(false);
});

test.each(['code', 'message-only'] as const)(
	'socket close (%s) before output retries the same request and delivers output once',
	async kind => {
		const bodies: string[] = [];
		globalThis.fetch = (async (
			_url: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			bodies.push(String(init?.body));
			if (bodies.length === 1)
				throw kind === 'code'
					? socketError()
					: new Error(
							'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
						);
			return success();
		}) as unknown as typeof fetch;
		const output = handlers();
		const result = await streamChat([{role: 'user', content: 'hello'}], output);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toBe(bodies[1]);
		expect(result.text).toBe('recovered');
		expect(output.text).toEqual(['recovered']);
		expect(retryingAttempt()).toBe(0);
	},
);

test('repeated socket failures stop after two retries with actionable error', async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		throw socketError();
	}) as unknown as typeof fetch;
	await expect(
		streamChat([{role: 'user', content: 'hello'}], handlers()),
	).rejects.toThrow('after 2 retries');
	expect(calls).toBe(3);
	expect(retryingAttempt()).toBe(0);
});

test.each(['text', 'reasoning'] as const)(
	'socket failure after %s does not replay or fall back',
	async kind => {
		let calls = 0;
		setFallbackEndpoints([
			{
				id: 'fallback',
				baseUrl: 'http://127.0.0.1:2',
				apiKey: 'test',
				model: 'test',
			},
		]);
		globalThis.fetch = (async () => {
			calls++;
			const delta =
				kind === 'text' ? {content: 'partial'} : {reasoning_content: 'partial'};
			let reads = 0;
			return {
				ok: true,
				body: {
					getReader: () => ({
						read: async () => {
							if (reads++ === 0)
								return {
									done: false,
									value: new TextEncoder().encode(
										`data: ${JSON.stringify({choices: [{delta}]})}\n\n`,
									),
								};
							throw socketError();
						},
						cancel: async () => {},
					}),
				},
			};
		}) as unknown as typeof fetch;
		await expect(
			streamChat([{role: 'user', content: 'hello'}], handlers()),
		).rejects.toThrow('partial output');
		expect(calls).toBe(1);
	},
);

test('abort during socket retry backoff prevents a second request', async () => {
	let calls = 0;
	const controller = new AbortController();
	globalThis.fetch = (async () => {
		calls++;
		setTimeout(() => controller.abort(), 20);
		throw socketError();
	}) as unknown as typeof fetch;
	await expect(
		streamChat(
			[{role: 'user', content: 'hello'}],
			handlers(),
			controller.signal,
		),
	).rejects.toMatchObject({name: 'AbortError'});
	expect(calls).toBe(1);
	expect(retryingAttempt()).toBe(0);
});

test('unrelated errors are not classified as retryable network failures', async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		throw new Error('invalid provider configuration');
	}) as unknown as typeof fetch;
	await expect(
		streamChat([{role: 'user', content: 'hello'}], handlers()),
	).rejects.toThrow('invalid provider configuration');
	expect(calls).toBe(1);
});

test.each(['text', 'reasoning', 'search'] as const)(
	'Responses socket failure after %s does not replay the request',
	async kind => {
		setActiveEndpoint({...activeEndpoint(), sdkProvider: 'responses'});
		let calls = 0;
		const event =
			kind === 'search'
				? {
						type: 'response.output_item.done',
						item: {
							type: 'web_search_call',
							action: {type: 'search', query: 'test'},
						},
					}
				: {
						type:
							kind === 'text'
								? 'response.output_text.delta'
								: 'response.reasoning_summary_text.delta',
						delta: 'partial',
					};
		globalThis.fetch = (async () => {
			calls++;
			let reads = 0;
			return {
				ok: true,
				body: {
					getReader: () => ({
						read: async () => {
							if (reads++ === 0)
								return {
									done: false,
									value: new TextEncoder().encode(
										`data: ${JSON.stringify(event)}\n\n`,
									),
								};
							throw socketError();
						},
						cancel: async () => {},
					}),
				},
			};
		}) as unknown as typeof fetch;
		await expect(
			streamChat([{role: 'user', content: 'hello'}], handlers()),
		).rejects.toThrow('partial output');
		expect(calls).toBe(1);
	},
);
