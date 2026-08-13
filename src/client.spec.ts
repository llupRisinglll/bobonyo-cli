import {describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	buildResponsesInput,
	looksLikeToolCallText,
	openAIToolBlocks,
	parseToolCalls,
	parseXmlToolCalls,
	responsesToolBlocks,
	streamChat,
} from './client';
import {setActiveEndpoint} from './state';

describe('parseXmlToolCalls', () => {
	test('parses the plain <tool_calls>/<invoke> dialect with named params', () => {
		const parsed = parseXmlToolCalls(
			'Sure, here you go.\n<tool_calls>\n<invoke name="WebSearch">\n<parameter name="query">who is Ada Lovelace</parameter>\n</invoke>\n</tool_calls>',
		);
		expect(parsed).not.toBeNull();
		expect(parsed!.calls.length).toBe(1);
		expect(parsed!.calls[0]!.name).toBe('WebSearch');
		expect(JSON.parse(parsed!.calls[0]!.arguments)).toEqual({
			query: 'who is Ada Lovelace',
		});
		expect(parsed!.cleanText).toBe('Sure, here you go.');
	});

	test('parses POSITIONAL <parameter string="N"> args via the arg order', () => {
		const parsed = parseXmlToolCalls(
			'<tool_calls>\n<invoke name="Bash">\n<parameter string="0">sleep 5 && echo "hello world"</parameter>\n</invoke>\n</tool_calls>',
		);
		expect(parsed).not.toBeNull();
		expect(parsed!.calls[0]!.name).toBe('Bash');
		expect(JSON.parse(parsed!.calls[0]!.arguments)).toEqual({
			command: 'sleep 5 && echo "hello world"',
		});
	});

	test('still parses the antml dialect', () => {
		const parsed = parseXmlToolCalls(
			'<antml:function_calls><antml:invoke name="Read"><antml:parameter name="path">README.md</antml:parameter></antml:invoke></antml:function_calls>',
		);
		expect(parsed).not.toBeNull();
		expect(parsed!.calls[0]!.name).toBe('Read');
		expect(JSON.parse(parsed!.calls[0]!.arguments)).toEqual({
			path: 'README.md',
		});
	});

	test('returns null when no tool-call block exists', () => {
		expect(parseXmlToolCalls('just a normal reply')).toBeNull();
	});
});

describe('stream stall guard (silent provider must not hang)', () => {
	test('a silent provider is surfaced as a stall error instead of hanging forever', async () => {
		setActiveEndpoint({
			id: 'stall-test',
			name: 'Stall Test',
			baseUrl: 'http://127.0.0.1:1',
			apiKey: 'x',
			model: 'm',
			models: ['m'],
			contextWindow: 128_000,
		});
		const realFetch = globalThis.fetch;
		// The provider opened the connection, sent nothing, and never
		// closes — the stucked-pane scenario. `reader.read()` would block
		// forever without the stall guard.
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			body: {
				getReader: () => ({
					read: () => new Promise<never>(() => {}),
					cancel: async () => {},
					releaseLock: () => {},
				}),
			},
		})) as unknown as typeof fetch;
		try {
			const started = Date.now();
			await expect(
				streamChat(
					[{role: 'user', content: 'hi'}],
					{onText: () => {}, onReasoning: () => {}},
					undefined,
					[],
					// 30ms no-data timeout so the test finishes fast; the
					// retry path (MAX_STREAM_STALL_RETRIES) runs too.
					{stallTimeoutMs: 30},
				),
			).rejects.toThrow(
				/Stream produced no non-ping SSE event within 30ms/,
			);
			// 3 attempts × 30ms + retry backoff ≈ 1.3s — far from the old
			// indefinite hang (the stucked pane sat at "Working…" for 6+ min).
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe('harness parity, tools in the OpenAI request', () => {
	test('openAIToolBlocks builds the standard function catalog', () => {
		const blocks = openAIToolBlocks([
			{name: 'execute_bash', description: 'Run a shell command'},
			{name: 'read_file'},
		]);
		expect(blocks).toEqual([
			{
				type: 'function',
				function: {
					name: 'execute_bash',
					description: 'Run a shell command',
					parameters: {type: 'object', properties: {}},
				},
			},
			{
				type: 'function',
				function: {
					name: 'read_file',
					description: '',
					parameters: {type: 'object', properties: {}},
				},
			},
		]);
	});
});

describe('parseToolCalls (recovery parser)', () => {
	test('recovers Llama <function=name>{json}</function> calls', () => {
		const parsed = parseToolCalls(
			'Let me check.\n<function=web_search>{"query":"ink TUI"}</function>',
		);
		expect(parsed.success).toBe(true);
		expect(parsed.toolCalls.length).toBe(1);
		expect(parsed.toolCalls[0]!.name).toBe('web_search');
		expect(JSON.parse(parsed.toolCalls[0]!.arguments)).toEqual({
			query: 'ink TUI',
		});
		expect(parsed.cleanText).toBe('Let me check.');
	});

	test('recovers JSON-shaped tool calls (fenced)', () => {
		const parsed = parseToolCalls(
			'```json\n{"name":"read_file","arguments":{"path":"README.md"}}\n```',
		);
		expect(parsed.success).toBe(true);
		expect(parsed.toolCalls[0]!.name).toBe('read_file');
		expect(JSON.parse(parsed.toolCalls[0]!.arguments)).toEqual({
			path: 'README.md',
		});
	});

	test('flags malformed XML with error + format guidance', () => {
		const parsed = parseToolCalls(
			'<tool_calls><invoke name="Bash"><parameter name="command">ls',
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Malformed tool call');
		expect(parsed.examples).toContain('<tool_calls>');
	});

	test('flags malformed JSON ("arguments" as a string)', () => {
		const parsed = parseToolCalls(
			'{"name":"Bash","arguments":"ls -la"}',
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('must be an object');
	});

	test('plain prose parses as a clean text-only turn', () => {
		const parsed = parseToolCalls('Just a normal reply.');
		expect(parsed.success).toBe(true);
		expect(parsed.toolCalls.length).toBe(0);
		expect(parsed.cleanText).toBe('Just a normal reply.');
	});

	test('looksLikeToolCallText guards the recovery trigger', () => {
		expect(looksLikeToolCallText('Use <tool_calls> now')).toBe(true);
		expect(looksLikeToolCallText('{"name":"Bash","arguments":{}}')).toBe(
			true,
		);
		expect(looksLikeToolCallText('Just prose here')).toBe(false);
	});
});

describe('Responses wire (Codex / OpenAI responses)', () => {
	test('buildResponsesInput converts chat history to input items', () => {
		expect(
			buildResponsesInput([
				{role: 'user', content: 'hello'},
				{
					role: 'assistant',
					content: 'on it',
					tool_calls: [
						{id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}'},
					],
				},
				{role: 'tool', tool_call_id: 'call_1', content: 'ok'},
				{role: 'user', content: 'thanks'},
			]),
		).toEqual([
			{role: 'user', content: [{type: 'input_text', text: 'hello'}]},
			{
				role: 'assistant',
				content: [{type: 'output_text', text: 'on it'}],
			},
			{
				type: 'function_call',
				call_id: 'call_1',
				name: 'Bash',
				arguments: '{"command":"ls"}',
			},
			{
				type: 'function_call_output',
				call_id: 'call_1',
				output: 'ok',
			},
			{role: 'user', content: [{type: 'input_text', text: 'thanks'}]},
		]);
	});

	test('responsesToolBlocks keeps the sorted cache head + codex strict null', () => {
		const blocks = responsesToolBlocks(
			[{name: 'zz_tool'}, {name: 'aa_tool', description: 'first'}],
			true,
		);
		expect(blocks.map(block => block.name)).toEqual(['aa_tool', 'zz_tool']);
		expect(blocks[0]).toMatchObject({
			type: 'function',
			name: 'aa_tool',
			description: 'first',
			strict: null,
		});
		// Standard API mode uses strict: false (never null).
		expect(
			responsesToolBlocks([{name: 'aa_tool'}], false)[0]?.strict,
		).toBe(false);
	});

	test('streams text, reasoning, tool calls and usage from response.* events', async () => {
		const sse = [
			'event: response.output_item.added',
			'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Bash","arguments":""}}',
			'',
			'event: response.function_call_arguments.delta',
			'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"command\\":\\"ls\\"}"}',
			'',
			'event: response.output_text.delta',
			'data: {"type":"response.output_text.delta","output_index":1,"delta":"Done"}',
			'',
			'event: response.reasoning_summary_text.delta',
			'data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"think step 1"}',
			'',
			'event: response.output_item.done',
			'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}',
			'',
			'event: response.completed',
			'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
			'',
		].join('\n');
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			body: stream,
		})) as unknown as typeof fetch;
		try {
			setActiveEndpoint({
				id: 'responses-test',
				name: 'Responses Test',
				baseUrl: 'https://api.openai.com',
				apiKey: 'sk-test',
				model: 'gpt-5.5-codex',
				models: ['gpt-5.5-codex'],
				contextWindow: 400_000,
				sdkProvider: 'responses',
			});
			const seen: string[] = [];
			const result = await streamChat(
				[{role: 'user', content: 'hi'}],
				{
					onText: delta => seen.push(`text:${delta}`),
					onReasoning: delta => seen.push(`reasoning:${delta}`),
				},
				undefined,
				[],
				{stallTimeoutMs: 2000},
			);
			expect(result.text).toBe('Done');
			expect(result.reasoning).toBe('think step 1');
			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0]).toMatchObject({
				id: 'call_1',
				name: 'Bash',
			});
			expect(result.toolCalls[0]!.arguments).toEqual({command: 'ls'});
			expect(result.finishReason).toBe('stop');
			expect(result.usage).toMatchObject({input_tokens: 10});
			expect(seen).toEqual(['text:Done', 'reasoning:think step 1']);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test('codexAccount sends the codex backend URL + ChatGPT auth headers', async () => {
		process.env.CODEX_HOME = `${import.meta.dir}/.test-temp-codex-auth`;
		mkdirSync(process.env.CODEX_HOME, {recursive: true});
		writeFileSync(
			join(process.env.CODEX_HOME, 'auth.json'),
			JSON.stringify({
				tokens: {
					access_token: 'tok_1',
					account_id: 'acc_1',
				},
			}),
		);
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n',
					),
				);
				controller.close();
			},
		});
		const realFetch = globalThis.fetch;
		let captured: {url: string; headers: Record<string, string>; body: unknown} | undefined;
		globalThis.fetch = (async (url: unknown, init: unknown) => {
			captured = {
				url: String(url),
				headers: (init as {headers: Record<string, string>}).headers,
				body: JSON.parse((init as {body: string}).body),
			};
			return {ok: true, status: 200, body: stream};
		}) as unknown as typeof fetch;
		try {
			setActiveEndpoint({
				id: 'codex',
				name: 'Codex',
				baseUrl: 'https://chatgpt.com/backend-api/codex',
				apiKey: '',
				model: 'gpt-5.5-codex',
				models: ['gpt-5.5-codex'],
				contextWindow: 400_000,
				sdkProvider: 'responses',
				codexAccount: true,
			});
			await streamChat(
				[{role: 'user', content: 'hi'}],
				{onText: () => {}, onReasoning: () => {}},
				undefined,
				[{name: 'Bash'}],
				{stallTimeoutMs: 2000},
			);
			expect(captured?.url).toBe(
				'https://chatgpt.com/backend-api/codex/responses',
			);
			expect(captured?.headers.authorization).toBe('Bearer tok_1');
			expect(captured?.headers['chatgpt-account-id']).toBe('acc_1');
			expect(
				(captured?.body as {prompt_cache_key?: string}).prompt_cache_key,
			).toBeTruthy();
			expect(
				(captured?.body as {instructions?: string}).instructions,
			).toContain('BoboNyo');
		} finally {
			globalThis.fetch = realFetch;
			rmSync(process.env.CODEX_HOME, {recursive: true, force: true});
			delete process.env.CODEX_HOME;
		}
	});

	test('codexAccount without a codex login fails fast with a clear error', async () => {
		process.env.CODEX_HOME = `${import.meta.dir}/.test-temp-codex-noauth`;
		mkdirSync(process.env.CODEX_HOME, {recursive: true});
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error('fetch must not be called without auth');
		}) as unknown as typeof fetch;
		try {
			setActiveEndpoint({
				id: 'codex',
				name: 'Codex',
				baseUrl: 'https://chatgpt.com/backend-api/codex',
				apiKey: '',
				model: 'gpt-5.5-codex',
				models: ['gpt-5.5-codex'],
				contextWindow: 400_000,
				sdkProvider: 'responses',
				codexAccount: true,
			});
			await expect(
				streamChat(
					[{role: 'user', content: 'hi'}],
					{onText: () => {}, onReasoning: () => {}},
					undefined,
					[],
					{stallTimeoutMs: 2000},
				),
			).rejects.toThrow(/codex login/);
		} finally {
			globalThis.fetch = realFetch;
			rmSync(process.env.CODEX_HOME, {recursive: true, force: true});
			delete process.env.CODEX_HOME;
		}
	});
});
