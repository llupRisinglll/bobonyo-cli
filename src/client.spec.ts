import {describe, expect, test} from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
	buildResponsesInput,
	buildSystemPrompt,
	looksLikeToolCallText,
	openAIToolBlocks,
	parseToolCalls,
	parseXmlToolCalls,
	responsesToolBlocks,
	sanitizeToolCallIds,
	streamChat,
} from './client';
import {appendMemory} from './memory';
import {setActiveEndpoint} from './state';

test('system prompt injects persistent memory, compaction prompt can omit Caveman', () => {
	const originalConfig = process.env.BOBONYO_CONFIG_DIR;
	const originalCwd = process.cwd();
	const root = mkdtempSync(join(tmpdir(), 'bobonyo-client-memory-'));
	try {
		process.env.BOBONYO_CONFIG_DIR = join(root, 'config');
		process.chdir(root);
		appendMemory('Never commit unless explicitly asked.', 'user');
		const normal = buildSystemPrompt();
		const compact = buildSystemPrompt(undefined, {disableCaveman: true});
		expect(normal).toContain('Never commit unless explicitly asked.');
		expect(normal).toContain('CAVEMAN MODE');
		expect(compact).toContain('Never commit unless explicitly asked.');
		expect(compact).not.toContain('CAVEMAN MODE');
	} finally {
		process.chdir(originalCwd);
		if (originalConfig === undefined) delete process.env.BOBONYO_CONFIG_DIR;
		else process.env.BOBONYO_CONFIG_DIR = originalConfig;
		rmSync(root, {recursive: true, force: true});
	}
});

describe('sanitizeToolCallIds (auto-recovery for malformed tool history)', () => {
	test('well-formed sequences pass through unchanged', () => {
		const messages = [
			{role: 'user', content: 'run it'},
			{
				role: 'assistant',
				content: '',
				tool_calls: [{id: 'call_1', name: 'execute_bash', arguments: '{}'}],
			},
			{role: 'tool', content: 'done', tool_call_id: 'call_1'},
			{role: 'assistant', content: 'ok'},
		];
		expect(sanitizeToolCallIds(messages)).toEqual(messages);
	});

	test('an empty tool_call_id is matched to the next pending declaration', () => {
		const sanitized = sanitizeToolCallIds([
			{
				role: 'assistant',
				content: '',
				tool_calls: [{id: 'call_1', name: 'execute_bash', arguments: '{}'}],
			},
			{role: 'tool', content: 'done', tool_call_id: ''},
		]);
		expect(sanitized).toEqual([
			{
				role: 'assistant',
				content: '',
				tool_calls: [{id: 'call_1', name: 'execute_bash', arguments: '{}'}],
			},
			{role: 'tool', content: 'done', tool_call_id: 'call_1'},
		]);
	});

	test('an orphan tool message with no declaration is dropped', () => {
		expect(
			sanitizeToolCallIds([
				{role: 'user', content: 'hi'},
				{role: 'tool', content: 'orphan'},
			]),
		).toEqual([{role: 'user', content: 'hi'}]);
	});

	test('empty tool_calls ids are synthesized and the result matches', () => {
		const sanitized = sanitizeToolCallIds([
			{
				role: 'assistant',
				content: '',
				tool_calls: [{id: '', name: 'execute_bash', arguments: '{}'}],
			},
			{role: 'tool', content: 'out'},
		]);
		expect(sanitized[0]!.tool_calls?.[0]!.id).toBe('call-0');
		expect(sanitized[1]).toMatchObject({tool_call_id: 'call-0'});
	});

	test('a degenerate tool_calls block and its results are dropped', () => {
		// Exact shape the migrated legacy session carried: assistant
		// tool_calls with an EMPTY id and name, followed by an orphan tool
		// result — the provider rejected it with "missing field
		// tool_call_id".
		expect(
			sanitizeToolCallIds([
				{role: 'user', content: 'summary'},
				{
					role: 'assistant',
					content: '',
					tool_calls: [{id: '', name: '', arguments: '{}'}],
				},
				{role: 'tool', content: '✦ Bash(...)'},
				{role: 'assistant', content: 'The real reply.'},
			]),
		).toEqual([
			{role: 'user', content: 'summary'},
			{role: 'assistant', content: 'The real reply.'},
		]);
	});

	test('an undeclared tool result id is dropped too', () => {
		expect(
			sanitizeToolCallIds([
				{role: 'tool', content: 'stale', tool_call_id: 'call_gone'},
				{role: 'assistant', content: 'ok'},
			]),
		).toEqual([{role: 'assistant', content: 'ok'}]);
	});
	test('a tool declaration without persisted output is dropped', () => {
		expect(
			sanitizeToolCallIds([
				{
					role: 'assistant',
					content: 'starting',
					tool_calls: [
						{id: 'call_done', name: 'execute_bash', arguments: '{}'},
						{id: 'call_missing', name: 'process_start', arguments: '{}'},
					],
				},
				{role: 'tool', content: 'done', tool_call_id: 'call_done'},
			]),
		).toEqual([
			{
				role: 'assistant',
				content: 'starting',
				tool_calls: [{id: 'call_done', name: 'execute_bash', arguments: '{}'}],
			},
			{role: 'tool', content: 'done', tool_call_id: 'call_done'},
		]);
	});
});

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
			).rejects.toThrow(/Stream produced no non-ping SSE event within 30ms/);
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
		const parsed = parseToolCalls('{"name":"Bash","arguments":"ls -la"}');
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
		expect(looksLikeToolCallText('{"name":"Bash","arguments":{}}')).toBe(true);
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
		expect(responsesToolBlocks([{name: 'aa_tool'}], false)[0]?.strict).toBe(
			false,
		);
		const codex = responsesToolBlocks(
			[{name: 'web_search'}, {name: 'bash'}],
			true,
		);
		expect(codex).toEqual([
			{
				type: 'function',
				name: 'bash',
				description: '',
				parameters: {type: 'object', properties: {}},
				strict: null,
			},
			{type: 'web_search'},
		]);
		const standard = responsesToolBlocks([{name: 'web_search'}], false);
		expect(standard[0]?.type).toBe('function');
	});

	test('streams text, reasoning, tool calls and usage from response.* events', async () => {
		const sse = [
			'event: response.output_item.added',
			'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}',
			'',
			'event: response.reasoning_summary_text.delta',
			'data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"think step 1"}',
			'',
			'event: response.output_item.added',
			'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Bash","arguments":""}}',
			'',
			'event: response.function_call_arguments.delta',
			'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"command\\":\\"ls\\"}"}',
			'',
			'event: response.output_text.delta',
			'data: {"type":"response.output_text.delta","output_index":2,"delta":"Done"}',
			'',
			'event: response.output_item.done',
			'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}',
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
		let capturedBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			body: stream,
		})) as unknown as typeof fetch;
		globalThis.fetch = (async (_url: unknown, init: unknown) => {
			capturedBody = JSON.parse((init as {body: string}).body) as Record<
				string,
				unknown
			>;
			return {ok: true, status: 200, body: stream};
		}) as unknown as typeof fetch;
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
					onReasoningStart: () => seen.push('reasoning:start'),
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
			expect(seen).toEqual([
				'reasoning:start',
				'reasoning:think step 1',
				'text:Done',
			]);
			expect(capturedBody?.reasoning).toEqual({summary: 'auto'});
			expect(capturedBody?.include).toEqual(['reasoning.encrypted_content']);
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
		let captured:
			{url: string; headers: Record<string, string>; body: unknown} | undefined;
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
				effort: 'high',
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
			expect((captured?.body as {reasoning?: unknown}).reasoning).toEqual({
				effort: 'high',
				summary: 'auto',
			});
			expect((captured?.body as {include?: string[]}).include).toEqual([
				'reasoning.encrypted_content',
			]);
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

describe('Anthropic reasoning stream', () => {
	test('thinking block starts phase before first thinking delta', async () => {
		const sse = [
			'event: message_start',
			'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
			'',
			'event: content_block_start',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"check facts"}}',
			'',
			'event: content_block_start',
			'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
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
				id: 'anthropic-test',
				name: 'Anthropic Test',
				baseUrl: 'https://api.anthropic.com',
				apiKey: 'test',
				model: 'claude-opus-test',
				models: ['claude-opus-test'],
				contextWindow: 200_000,
				sdkProvider: 'anthropic',
				effort: 'high',
			});
			const seen: string[] = [];
			const result = await streamChat(
				[{role: 'user', content: 'hi'}],
				{
					onText: delta => seen.push(`text:${delta}`),
					onReasoning: delta => seen.push(`reasoning:${delta}`),
					onReasoningStart: () => seen.push('reasoning:start'),
				},
				undefined,
				[],
				{stallTimeoutMs: 2000},
			);
			expect(result.reasoning).toBe('check facts');
			expect(result.text).toBe('Done');
			expect(seen).toEqual([
				'reasoning:start',
				'reasoning:check facts',
				'text:Done',
			]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

test('buildResponsesInput serializes Codex images as input_image blocks', () => {
	const path = `${import.meta.dir}/.test-native-image.png`;
	writeFileSync(path, Buffer.from([1, 2, 3]));
	const input = buildResponsesInput([
		{role: 'user', content: 'inspect [Image #1]', images: [path]},
	]) as Array<{content?: Array<Record<string, unknown>>}>;
	expect(input[0]?.content).toEqual([
		{type: 'input_text', text: 'inspect [Image #1]'},
		{
			type: 'input_image',
			image_url: 'data:image/png;base64,AQID',
			detail: 'high',
		},
	]);
	unlinkSync(path);
});
