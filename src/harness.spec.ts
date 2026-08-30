import {afterEach, describe, expect, test} from 'bun:test';
import {toolCatalog} from './tools';
import {setCavemanMode} from './state';
import {
	anthropicToolBlocks,
	buildAnthropicMessages,
	buildOpenAIRequestBody,
	buildSystemPrompt,
	currentDateFragment,
	type ChatMessageLike,
} from './client';

afterEach(() => {
	setCavemanMode(true);
});

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

	test('the current date lives in a TAIL fragment, never the cached head', () => {
		// codex parity: the time is a per-turn user-message fragment that is
		// persisted in the rollout. If the date sat in the system prompt, a
		// day change (or a next-day resume) would bust the ENTIRE prefix
		// cache — the exact cost this resume work targets.
		expect(buildSystemPrompt('full')).not.toContain('Current Date');
		expect(currentDateFragment(new Date('2026-08-13T00:00:00Z'))).toBe(
			'\n\nCurrent date: 2026-08-13',
		);
	});

	test('custom commands are advertised for model-timed invocation', () => {
		const prompt = buildSystemPrompt('full');
		// Catalog may be empty in isolated tests, but the instruction and tool
		// contract must exist whenever project commands are loaded.
		expect(toolCatalog().some(tool => tool.name === 'command')).toBe(true);
		expect(
			toolCatalog().find(tool => tool.name === 'command')?.description,
		).toMatch(/now or later/);
	});
	test('the Herdr skill is advertised to the model and loadable by exact name', () => {
		const prompt = buildSystemPrompt('full');
		expect(prompt).toMatch(/- herdr \([^\n]+\/skills\/herdr\.md\):/);
		expect(prompt).toContain('Use the skill tool to load a skill');
	});
	test('loaded skills are reused until compaction removes their instructions', () => {
		const prompt = buildSystemPrompt('full');
		expect(prompt).toContain('Do not call the skill tool again');
		expect(prompt).toContain('still present in conversation context');
		expect(prompt).toContain('after context compaction removes');
		const skill = toolCatalog().find(tool => tool.name === 'skill');
		const check = toolCatalog().find(tool => tool.name === 'check_skill');
		expect(skill?.description).toContain(
			'reuse them and do not call this tool again',
		);
		expect(check?.description).toContain('Do not call routinely');
	});
	test('the model proactively delegates suitable work without duplicating it', () => {
		const prompt = buildSystemPrompt('full');
		expect(prompt).toContain('## Delegating work');
		expect(prompt).toMatch(/Use the `agent` tool proactively/);
		expect(prompt).toMatch(/broad codebase exploration/);
		expect(prompt).toMatch(/independent read-only investigations in parallel/);
		expect(prompt).toMatch(/do not delegate tiny tasks/i);
		expect(prompt).toMatch(/Do not duplicate work already assigned/);
		expect(prompt).toMatch(
			/already a delegated subagent.*do not delegate again/i,
		);
	});
	test('caveman instructions are injected into the stable prompt when enabled', () => {
		setCavemanMode(true);
		const prompt = buildSystemPrompt('full');
		expect(prompt).toContain('## CAVEMAN MODE');
		expect(prompt).toContain('respond terse like smart caveman');
	});

	test('caveman instructions are omitted when the mode is disabled', () => {
		setCavemanMode(false);
		const prompt = buildSystemPrompt('full');
		expect(prompt).not.toContain('CAVEMAN MODE');
		expect(prompt).not.toContain('respond terse like smart caveman');
	});

	test('the system prompt mandates a pre-tool text line', () => {
		// The pre-tool BRIEF is a hard UX rule: the model must write one
		// short line before a tool call (rendered above the tool box).
		// Guarding it in the STABLE prompt keeps the rule from silently
		// regressing out of the cache head.
		const prompt = buildSystemPrompt('full');
		expect(prompt).toMatch(/FIRST write one short line/i);
		expect(prompt).toMatch(/never fire a tool with no accompanying text/i);
	});

	test('the request body always carries the tool catalog', () => {
		const body = buildOpenAIRequestBody(
			[{role: 'user', content: 'hi'}],
			[{name: 'execute_bash'}, {name: 'read_file'}],
			{id: 'x', model: 'm'},
		);
		expect(Array.isArray(body.tools)).toBe(true);
		expect(
			(body.tools as Array<{function: {name: string}}>).map(
				t => t.function.name,
			),
		).toEqual(['execute_bash', 'read_file']);
	});

	test('OpenAI request carries selected reasoning effort', () => {
		const body = buildOpenAIRequestBody([{role: 'user', content: 'hi'}], [], {
			id: 'openai',
			model: 'gpt-5.4',
			effort: 'xhigh',
		});
		expect(body.reasoning_effort).toBe('xhigh');
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
			(orderA.tools as Array<{function: {name: string}}>).map(
				t => t.function.name,
			),
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

	test('the skill tools carry descriptions + argument schemas (model can call them)', () => {
		const body = buildOpenAIRequestBody(
			[{role: 'user', content: 'hi'}],
			toolCatalog(),
			{id: 'x', model: 'm'},
		);
		const tools = body.tools as Array<{
			function: {
				name: string;
				description: string;
				parameters: {properties?: Record<string, unknown>};
			};
		}>;
		const skill = tools.find(tool => tool.function.name === 'skill');
		const check = tools.find(tool => tool.function.name === 'check_skill');
		expect(skill?.function.description.length).toBeGreaterThan(0);
		expect(skill?.function.parameters.properties?.name).toBeDefined();
		expect(check?.function.description.length).toBeGreaterThan(0);
		expect(check?.function.parameters.properties?.name).toBeDefined();
	});

	test('execute_bash describes the mandatory pre-tool brief rule', () => {
		// The model must narrate before a bash call (the harness renders the
		// brief above the box). Without this rule in the tool description,
		// bash calls fire bare — no pretool text — and the user has no idea
		// what the command is about to do.
		const body = buildOpenAIRequestBody(
			[{role: 'user', content: 'hi'}],
			toolCatalog(),
			{id: 'x', model: 'm'},
		);
		const tools = body.tools as Array<{
			function: {name: string; description: string};
		}>;
		const bash = tools.find(tool => tool.function.name === 'execute_bash');
		expect(bash).toBeDefined();
		// The PURPOSE stays the lead of the description (what bash is FOR),
		// with the brief rule following it — never the other way around.
		expect(bash?.function.description).toMatch(
			/^Run a shell command in the terminal/,
		);
		expect(bash?.function.description).toMatch(
			/ALWAYS write a one-line PRE-TOOL BRIEF/i,
		);
		expect(bash?.function.description).toMatch(
			/then call it in the same message/i,
		);
		expect(bash?.function.description).toMatch(/MANDATORY/i);
	});

	test('Anthropic tools carry ONE cache_control breakpoint (the 4-cap)', () => {
		const tools = toolCatalog();
		const blocks = anthropicToolBlocks(tools);
		expect(blocks).toHaveLength(tools.length);
		const withBreakpoint = blocks.filter(
			block =>
				(block.cache_control as {type?: string} | undefined)?.type ===
				'ephemeral',
		);
		// A breakpoint on the LAST tool caches the whole tool list.
		expect(withBreakpoint).toHaveLength(1);
		expect(withBreakpoint[0]?.name).toBe(blocks[blocks.length - 1]?.name);
		// Total breakpoints across tools + system + latest user ≤ 4.
		const {system, anthropicMessages} = buildAnthropicMessages(
			[{role: 'user', content: 'hi'}],
			'full',
		);
		const total =
			withBreakpoint.length +
			JSON.stringify(system).split('cache_control').length -
			1 +
			JSON.stringify(anthropicMessages).split('cache_control').length -
			1;
		expect(total).toBeLessThanOrEqual(4);
	});
});

test('review_changes stays in the stable tool catalog without injecting workflow bodies', () => {
	const tool = toolCatalog().find(item => item.name === 'review_changes');
	expect(tool?.description).toContain('review subagents');
	expect(buildSystemPrompt('full')).not.toContain('MANDATORY WORKFLOW GATE');
});
