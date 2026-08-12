import {describe, expect, test} from 'bun:test';
import {
	buildOpenAIRequestBody,
	buildSystemPrompt,
	type ChatMessageLike,
} from './client';

/**
 * Harness recon, the cache invariants that keep OpenAI-compatible providers
 * hitting their prefix cache (codex keeps the conversation state stable; the
 * chat-completions equivalent is an IDENTICAL prefix every request):
 *   1. the system prompt is byte-stable per session,
 *   2. the tools catalog is deterministic and always present,
 *   3. the message history is append-only, every new turn's messages are
 *      the previous turn's messages PLUS new entries (no reordering or
 *      in-place mutation), so the provider's prefix cache hits.
 */
describe('harness cache invariants (OpenAI-compatible)', () => {
	test('the system prompt is byte-stable across calls in a session', () => {
		const a = buildSystemPrompt('full');
		const b = buildSystemPrompt('full');
		expect(b).toBe(a);
	});

	test('the request body always carries the tool catalog', () => {
		const body = buildOpenAIRequestBody(
			[{role: 'user', content: 'hi'}],
			[{name: 'execute_bash'}, {name: 'read_file'}],
			{id: 'x', model: 'm'},
		);
		expect(Array.isArray(body.tools)).toBe(true);
		expect((body.tools as Array<{function: {name: string}}>).map(t => t.function.name))
			.toEqual(['execute_bash', 'read_file']);
	});

	test('the tool head is byte-identical regardless of registration order', () => {
		// CACHE INVARIANT: the tool definitions are the cache head (parity:
		// codex + nanocoder tool-filter). MCP servers connect in nondetermin-
		// istic order, so two instances that register the same tools in a
		// different order MUST serialize the same request prefix — otherwise
		// every turn busts the provider's prefix cache.
		const endpoint = {id: 'x', model: 'm'};
		const messages: ChatMessageLike[] = [{role: 'user', content: 'hi'}];
		const orderA = buildOpenAIRequestBody(
			messages,
			[
				{name: 'zebra_mcp__check'},
				{name: 'execute_bash'},
				{name: 'alpha_mcp__read'},
				{name: 'read_file'},
			],
			endpoint,
		);
		const orderB = buildOpenAIRequestBody(
			messages,
			[
				{name: 'read_file'},
				{name: 'alpha_mcp__read'},
				{name: 'execute_bash'},
				{name: 'zebra_mcp__check'},
			],
			endpoint,
		);
		expect(JSON.stringify(orderA.tools)).toBe(JSON.stringify(orderB.tools));
		expect(
			(orderA.tools as Array<{function: {name: string}}>).map(t => t.function.name),
		).toEqual([
			'alpha_mcp__read',
			'execute_bash',
			'read_file',
			'zebra_mcp__check',
		]);
	});

	test('message history is append-only: turn N is a strict prefix of turn N+1', () => {
		const tools = [{name: 'execute_bash'}];
		const endpoint = {id: 'x', model: 'm'};
		const turn1: ChatMessageLike[] = [{role: 'user', content: 'read the file'}];
		const turn2: ChatMessageLike[] = [
			...turn1,
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{id: 'call_1', name: 'read_file', arguments: '{"path":"a"}'},
				],
			},
			{role: 'tool', content: 'Wrote a', tool_call_id: 'call_1'},
			{role: 'user', content: 'what changed?'},
		];
		const body1 = buildOpenAIRequestBody(turn1, tools, endpoint) as {
			messages: Array<Record<string, unknown>>;
		};
		const body2 = buildOpenAIRequestBody(turn2, tools, endpoint) as {
			messages: Array<Record<string, unknown>>;
		};
		// The system head + turn-1 messages appear byte-identical at the
		// START of turn 2's messages (prefix stability → cache hit).
		expect(JSON.stringify(body2.messages.slice(0, body1.messages.length))).toBe(
			JSON.stringify(body1.messages),
		);
	});

	test('tool_calls round-trip uses the STANDARD OpenAI shape (type/function)', () => {
		const body = buildOpenAIRequestBody(
			[
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'call_1',
							name: 'execute_bash',
							arguments: '{"command":"ls"}',
						},
					],
				},
			],
			[{name: 'execute_bash'}],
			{id: 'x', model: 'm'},
		) as {
			messages: Array<{
				tool_calls?: Array<{
					id: string;
					type: string;
					function: {name: string; arguments: string};
				}>;
			}>;
		};
		// Index 0 is the system message; the assistant tool_calls follow.
		expect(body.messages[1]!.tool_calls).toEqual([
			{
				id: 'call_1',
				type: 'function',
				function: {
					name: 'execute_bash',
					arguments: '{"command":"ls"}',
				},
			},
		]);
	});

	test('prompt-cache key and provider options merge into the body', () => {
		const body = buildOpenAIRequestBody(
			[{role: 'user', content: 'hi'}],
			[],
			{
				id: 'deepseek.primary',
				model: 'm',
				promptCacheKey: true,
				providerOptions: {temperature: 0.2},
			},
			'full',
			'sess_abc',
		);
		expect(body).toMatchObject({
			deepseek: {prompt_cache_key: 'sess_abc'},
			temperature: 0.2,
		});
	});
});
