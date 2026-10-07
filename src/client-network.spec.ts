import {afterEach, beforeEach, expect, test} from 'bun:test';
import {streamChat, setFallbackEndpoints} from './client';
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
