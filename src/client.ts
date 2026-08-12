/**
 * OpenAI-compatible streaming chat client, talks to the same keyword-driven
 * mock provider as the nanocoder e2e suite (tools/mock-provider/server.mjs).
 * Parses text deltas, reasoning deltas, and tool-call deltas from the SSE.
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {activeEndpoint, sessionId, setRetryingAttempt} from './state';
import {resolveRulesFile} from './rules-file';
import {toolDescription} from './tools';

/** nanocoder's retry budgets (source/constants.ts + rate-limit.ts). */
export const MAX_RATE_LIMIT_RETRIES = 3;
export const MAX_STREAM_STALL_RETRIES = 2;
/** nanocoder's runaway-stream bounds (source/constants.ts). */
export const MAX_STREAM_OUTPUT_CHARS = 1_000_000;
export const MAX_STREAM_DURATION_MS = 600_000;

/**
 * B23: runaway-stream guard. A provider that streams forever (or floods
 * unbounded output) is aborted at the client instead of wedging the turn.
 * Mirrors nanocoder's `StreamRunawayError` (source/ai-sdk-client/error-
 * handling/stream-runaway-error.ts).
 */
export class StreamRunawayError extends Error {
	kind: 'duration' | 'output';
	constructor(kind: 'duration' | 'output', detail: string) {
		super(
			kind === 'duration'
				? `Stream exceeded the ${detail} duration budget, aborted.`
				: `Stream exceeded the ${detail} output-character budget, aborted.`,
		);
		this.name = 'StreamRunawayError';
		this.kind = kind;
	}
}

export interface StreamGuard {
	maxOutputChars?: number;
	maxDurationMs?: number;
}

/**
 * Stable system block sent as the first message of every request. It must be
 * byte-identical turn-to-turn within a session so the cache-head stays warm
 * (the mock logs it and the cachehead parity scenario asserts stability).
 */
const SYSTEM_PROMPT =
	'You are BoboNyo, a terminal coding agent. Be concise. Verify your work. ' +
	'Be blunt and a little snobbish, never sycophantic: honesty matters more than pleasing the user, ' +
	'so call out weak ideas directly instead of going along with them. ' +
	'Use tools for anything stateful (files, shell, git, web). ' +
	'When reporting numbers, progress, or long-running work (background tasks, ' +
	'builds, e2e suites, CI), prefer the visualize tool for charts/status ' +
	'cards and list_background_tasks for an overview — do NOT dump raw output ' +
	'or call monitor repeatedly. When a chart is rendered, do NOT repeat the ' +
	'same data as a table or list afterwards; the chart is the answer.';
const NANO_SYSTEM_PROMPT =
	'You are BoboNyo, a terminal coding agent. Be concise. ' +
	'Be blunt and a little snobbish, never sycophantic: honesty matters more than pleasing the user. ' +
	'Use tools for anything stateful (files, shell, git, web).';

/**
 * B1: volatile system-info block (cwd, date, AGENTS.md). SESSION-STABLE in
 * practice (cwd fixed, date changes once a day, AGENTS.md rarely edited), so
 * it does not bust per-turn prefix caches; the ANTHROPIC path puts the
 * `cache_control` breakpoint on the STABLE block only, so the volatile tail
 * never invalidates the cached prefix.
 */
function buildVolatileSystemInfo(): string {
	const dateStr = new Date().toISOString().split('T')[0]!;
	const cwd = process.cwd();
	let agents = '';
	// Nearest AGENTS.md walking UP from the cwd (cwd wins), the same
	// resolution `/status` reports — the model always runs under the rules
	// file the status surface shows.
	const agentsPath = resolveRulesFile(cwd);
	try {
		if (agentsPath) {
			agents = `\n\nAGENTS.md:\n${readFileSync(agentsPath, 'utf8')}`;
		}
	} catch {
		// unreadable AGENTS.md, omit it
	}
	return (
		`## SYSTEM INFORMATION\n` +
		`Current Working Directory: ${cwd}\n` +
		`Current Date: ${dateStr}${agents}`
	);
}

/**
 * D7: nano profile gets a slim prompt, identity + task approach, without the
 * full behavioral guidance (parity: nanocoder's `constraints-nano` drops
 * coding-practices/constraints sections). The profile must not change
 * mid-session, so the cache head stays stable.
 */
export function buildSystemPrompt(toolProfile?: string): string {
	const {stable, volatile} = buildSystemParts(toolProfile);
	return volatile ? `${stable}\n\n${volatile}` : stable;
}

export function buildSystemParts(toolProfile?: string): {
	stable: string;
	volatile: string;
} {
	const stable =
		toolProfile === 'nano' ? NANO_SYSTEM_PROMPT : SYSTEM_PROMPT;
	return {stable, volatile: buildVolatileSystemInfo()};
}

export class ProviderError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'ProviderError';
		this.status = status;
	}
}

/** Mirrors nanocoder's stream-stall detector (mock stallMessage shape). */
function isStreamStallMessage(message: string): boolean {
	return /Stream produced no non-ping SSE event within \d+ms/.test(message);
}

export interface ChatMessageLike {
	role: string;
	content: string;
	tool_call_id?: string;
	tool_calls?: Array<{id: string; name: string; arguments: string}>;
}

export interface MockToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	rawArguments: string;
}

export interface TurnResult {
	text: string;
	reasoning: string;
	toolCalls: MockToolCall[];
	finishReason: string;
	usage?: Record<string, unknown>;
}

export interface StreamHandlers {
	onText: (delta: string) => void;
	onReasoning: (delta: string) => void;
}

export interface ToolCatalogEntry {
	name: string;
	description?: string;
}

/**
 * OpenAI-contract `tools` array for the chat/completions body, the catalog
 * the provider uses to emit native tool_calls. Exporting it lets the harness
 * parity be unit-tested (the body MUST carry the tools, or real providers
 * fall back to text-shaped tool calls).
 *
 * CACHE INVARIANT: the tool definitions are part of the cache head
 * (parity: codex `prompt_tools_are_consistent_across_requests`, nanocoder's
 * tool-filter cache notes). Names are SORTED here so the serialized head is
 * byte-identical regardless of registration order (built-ins, custom tools,
 * MCP server connect order) — a per-turn change to the tool array busts the
 * ENTIRE prefix cache, not just the tail.
 */
export function openAIToolBlocks(
	tools: ToolCatalogEntry[],
): Array<Record<string, unknown>> {
	return [...tools]
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				// REAL descriptions from the registry so the model knows what
				// each tool does (the catalog is also the cache head, so the
				// strings are stable per build — never timestamps/volatile
				// content).
				description:
					tool.description ??
					toolDescription(tool.name),
				parameters: {type: 'object', properties: {}},
			},
		}));
}

/**
 * Build the OpenAI-contract request body. EXTRACTED from the fetch path so
 * the cache invariants can be unit-tested: the system prompt and tools are
 * stable per session, the message history is append-only (each new turn's
 * body has the previous turn's messages as a strict PREFIX), and the body
 * always carries the tool catalog (harness parity, without it providers
 * can't emit native tool calls).
 */
export function buildOpenAIRequestBody(
	messages: ChatMessageLike[],
	tools: ToolCatalogEntry[],
	endpoint: {
		id: string;
		model: string;
		promptCacheKey?: boolean;
		providerOptions?: Record<string, unknown>;
	},
	toolProfile?: string,
	sessionIdValue = sessionId(),
): Record<string, unknown> {
	const toolBlocks = openAIToolBlocks(tools);
	const body: Record<string, unknown> = {
		model: endpoint.model,
		stream: true,
		messages: [
			{role: 'system', content: buildSystemPrompt(toolProfile)},
			...messages.map(({role, content, tool_call_id, tool_calls}) => ({
				role,
				content,
				...(tool_call_id ? {tool_call_id} : {}),
				...(tool_calls
					? {
							// Standard OpenAI assistant tool_calls shape,
							// strict providers (Xiaomi mimo) REJECT the
							// flattened {id,name,arguments} form with
							// "missing field `type`".
							tool_calls: tool_calls.map(call => ({
								id: call.id,
								type: 'function',
								function: {
									name: call.name,
									arguments: call.arguments,
								},
							})),
						}
					: {}),
			})),
		],
		...(toolBlocks.length > 0 ? {tools: toolBlocks} : {}),
	};
	if (endpoint.promptCacheKey) {
		body[`${endpoint.id.split('.')[0]}`] = {
			prompt_cache_key: sessionIdValue,
		};
	}
	if (endpoint.providerOptions) {
		Object.assign(body, endpoint.providerOptions);
	}
	return body;
}

export interface EndpointOverride {
	id: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	sdkProvider?: string;
	providerOptions?: Record<string, unknown>;
	promptCacheKey?: boolean;
}

/** E2: fallback providers tried in order when the active one fails. */
let fallbackEndpoints: EndpointOverride[] = [];

export function setFallbackEndpoints(endpoints: EndpointOverride[]): void {
	fallbackEndpoints = endpoints;
}

export async function streamChat(
	messages: ChatMessageLike[],
	handlers: StreamHandlers,
	signal?: AbortSignal,
	tools: ToolCatalogEntry[] = [],
	streamGuard?: StreamGuard,
	toolProfile?: string,
): Promise<TurnResult> {
	const candidates: Array<EndpointOverride | undefined> = [
		undefined,
		...fallbackEndpoints,
	];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return await streamOnceWithRetries(
				messages,
				handlers,
				signal,
				tools,
				candidate,
				streamGuard,
				toolProfile,
			);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') throw error;
			// B23: the runaway guard aborts the TURN, never retry another
			// provider on a client-side stream bound.
			if (error instanceof StreamRunawayError) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

async function streamOnceWithRetries(
	messages: ChatMessageLike[],
	handlers: StreamHandlers,
	signal?: AbortSignal,
	tools: ToolCatalogEntry[] = [],
	endpointOverride?: EndpointOverride,
	streamGuard?: StreamGuard,
	toolProfile?: string,
): Promise<TurnResult> {
	const attempts = {rate: 0, stall: 0};
	for (;;) {
		try {
			const result = await streamOnce(
				messages,
				handlers,
				signal,
				tools,
				endpointOverride,
				streamGuard,
				toolProfile,
			);
			setRetryingAttempt(0);
			return result;
		} catch (error) {
			if (
				error instanceof ProviderError &&
				error.status === 429 &&
				attempts.rate < MAX_RATE_LIMIT_RETRIES
			) {
				attempts.rate += 1;
				setRetryingAttempt(attempts.rate);
				await sleep(400 * attempts.rate);
				continue;
			}
			if (
				error instanceof ProviderError &&
				isStreamStallMessage(error.message) &&
				attempts.stall < MAX_STREAM_STALL_RETRIES
			) {
				attempts.stall += 1;
				setRetryingAttempt(attempts.stall);
				await sleep(400 * attempts.stall);
				continue;
			}
			throw error;
		}
	}
}

async function streamOnce(
	messages: ChatMessageLike[],
	handlers: StreamHandlers,
	signal?: AbortSignal,
	tools: ToolCatalogEntry[] = [],
	endpointOverride?: EndpointOverride,
	streamGuard?: StreamGuard,
	toolProfile?: string,
): Promise<TurnResult> {
	const endpoint = endpointOverride ?? activeEndpoint();
	if (endpoint.sdkProvider === 'anthropic') {
		return anthropicStreamOnce(
			messages,
			handlers,
			signal,
			tools,
			endpoint,
			toolProfile,
		);
	}
	const body = buildOpenAIRequestBody(
		messages,
		tools,
		endpoint,
		toolProfile,
	);
	const response = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(endpoint.apiKey
				? {authorization: `Bearer ${endpoint.apiKey}`}
				: {}),
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		let message = '';
		try {
			const body = (await response.json()) as {error?: {message?: string}};
			message = body.error?.message ?? '';
		} catch {
			// keep the status
		}
		throw new ProviderError(
			response.status,
			classifyHttpError(response.status, message),
		);
	}

	if (!response.body) {
		return {text: '', reasoning: '', toolCalls: [], finishReason: 'stop'};
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let reasoning = '';
	let finishReason = 'stop';
	let usage: Record<string, unknown> | undefined;
	const toolCalls = new Map<
		number,
		{id: string; name: string; arguments: string}
	>();
	// B23: runaway-stream bounds, resolved once per request.
	const guard = {
		maxOutputChars:
			streamGuard?.maxOutputChars ?? MAX_STREAM_OUTPUT_CHARS,
		maxDurationMs: streamGuard?.maxDurationMs ?? MAX_STREAM_DURATION_MS,
	};
	const streamStartedAt = Date.now();

	while (true) {
		const {done, value} = await reader.read();
		if (done) break;
		const elapsed = Date.now() - streamStartedAt;
		if (elapsed > guard.maxDurationMs) {
			throw new StreamRunawayError(
				'duration',
				`${Math.round(elapsed / 1000)}s`,
			);
		}
		buffer += decoder.decode(value, {stream: true});
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) continue;
			const payload = trimmed.slice(5).trim();
			if (payload === '[DONE]') continue;
			let chunk: {
				error?: {message?: string; type?: string};
				choices?: Array<{
					delta?: {
						content?: string;
						reasoning_content?: string;
						reasoning?: string;
						thinking?: string;
						tool_calls?: Array<{
							index: number;
							id?: string;
							function?: {name?: string; arguments?: string};
						}>;
					};
					finish_reason?: string | null;
				}>;
				usage?: Record<string, unknown>;
			};
			try {
				chunk = JSON.parse(payload);
			} catch {
				// Malformed SSE frame, skip it and keep streaming.
				continue;
			}
			if (chunk.error) {
				// Mid-stream death: the provider injected an error frame
				// (mock `midstreamError` rule), surface it like any other
				// stream failure instead of committing the partial text.
				throw new Error(chunk.error.message ?? 'mid-stream failure');
			}
			const choice = chunk.choices?.[0];
			const delta = choice?.delta;
			if (delta?.content) {
				// B6: strip `<think>…</think>` tags unconditionally (GLM/Kimi/
				// Qwen leak reasoning into content).
				const cleaned = stripThinkTags(delta.content);
				text += cleaned;
				if (text.length > guard.maxOutputChars) {
					throw new StreamRunawayError(
						'output',
						`${Math.round(text.length / 1000)}k`,
					);
				}
				handlers.onText(cleaned);
			}
			// Reasoning arrives under different field names depending on the
			// provider (DeepSeek/Qwen `reasoning_content`, OpenAI `reasoning`,
			// some Claude-compatible `thinking`). Treat all of them as the
			// Thinking stream.
			const reasonDelta =
				delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
			if (reasonDelta) {
				reasoning += reasonDelta;
				handlers.onReasoning(reasonDelta);
			}
			if (delta?.tool_calls) {
				for (const call of delta.tool_calls) {
					const current = toolCalls.get(call.index) ?? {
						id: call.id ?? '',
						name: call.function?.name ?? '',
						arguments: '',
					};
					if (call.id) current.id = call.id;
					if (call.function?.name) current.name = call.function.name;
					if (call.function?.arguments) {
						current.arguments += call.function.arguments;
					}
					toolCalls.set(call.index, current);
				}
			}
			if (choice?.finish_reason) finishReason = choice.finish_reason;
			if (chunk.usage) usage = chunk.usage;
		}
	}

	// B6: XML/JSON tool-call fallback, when the provider streams tool calls
	// as TEXT (no native tool_calls), parse them and strip the ghost echo.
	const parsed = toolCalls.size === 0 ? parseToolCalls(text) : null;
	if (parsed && parsed.success && parsed.toolCalls.length > 0) {
		for (const call of parsed.toolCalls) {
			toolCalls.set(toolCalls.size, call);
		}
		text = parsed.cleanText;
	}
	// B6: strip any `<think>` blocks that crossed delta boundaries.
	text = stripThinkTags(text);

	return {
		text,
		reasoning,
		toolCalls: [...toolCalls.values()].map(call => ({
			id: call.id,
			name: call.name,
			rawArguments: call.arguments,
			arguments: parseArguments(call.arguments),
		})),
		finishReason,
		usage,
	};
}

/** Remove `<think>…</think>` blocks from streamed content (B6). */
export function stripThinkTags(content: string): string {
	return content.replace(/<think>[\s\S]*?<\/think>/g, '');
}

/**
 * Cheap guard: does this text LOOK like it contains a (possibly malformed)
 * tool call? Runs before the heavier recovery so ordinary prose answers
 * never pay the parse/retry cost (parity: nanocoder's looksLikeToolCallText).
 */
export function looksLikeToolCallText(text: string): boolean {
	return /<tool_call|<function=|<\|tool|```tool_call|"(tool|name)"\s*:\s*"[^"]+"[\s\S]*"(arguments|parameters)"\s*:/i.test(
		text,
	);
}

export interface ToolCallParseResult {
	success: boolean;
	toolCalls: Array<{id: string; name: string; arguments: string}>;
	cleanText: string;
	error?: string;
	examples?: string;
}

/** Format-guidance snippet for the self-correction feedback (parity). */
const TOOL_CALL_FORMAT_GUIDANCE =
	'Tool calls must use the exact format: <tool_calls><invoke name="ToolName"><parameter name="argName">value</parameter></invoke></tool_calls>. Arguments must be an object with the correct parameter names.';

/** Llama 3.x `<function=name>{json}</function>` tool-call dialect. */
function parseFunctionTagToolCalls(content: string): {
	toolCalls: Array<{id: string; name: string; arguments: string}>;
	cleanText: string;
} {
	const toolCalls: Array<{id: string; name: string; arguments: string}> = [];
	const matched: Array<[number, number]> = [];
	const pattern = /<function=([A-Za-z0-9_:-]+)>([\s\S]*?)<\/function>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		const name = match[1] ?? '';
		const body = (match[2] ?? '').trim();
		if (!name) continue;
		let args: Record<string, unknown>;
		try {
			const parsed = JSON.parse(body);
			if (
				parsed === null ||
				typeof parsed !== 'object' ||
				Array.isArray(parsed)
			) {
				continue;
			}
			args = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		toolCalls.push({
			id: `call_fn_${toolCalls.length}`,
			name,
			arguments: JSON.stringify(args),
		});
		matched.push([match.index, match.index + match[0].length]);
	}
	if (toolCalls.length === 0) return {toolCalls, cleanText: content};
	let cleanText = content;
	for (const [start, end] of matched.reverse()) {
		cleanText = cleanText.slice(0, start) + cleanText.slice(end);
	}
	return {toolCalls, cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim()};
}

/** JSON-shaped tool calls (`{"name":…, "arguments":…}` fenced or inline). */
function parseJSONToolCalls(content: string): {
	toolCalls: Array<{id: string; name: string; arguments: string}>;
	cleanText: string;
} {
	const toolCalls: Array<{id: string; name: string; arguments: string}> = [];
	const matched: Array<[number, number]> = [];
	const fencePattern =
		/```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
	let fenceMatch: RegExpExecArray | null;
	while ((fenceMatch = fencePattern.exec(content)) !== null) {
		const call = tryParseJSONToolCall(fenceMatch[1] ?? '');
		if (call) {
			toolCalls.push(call);
			matched.push([
				fenceMatch.index,
				fenceMatch.index + fenceMatch[0].length,
			]);
		}
	}
	const inlinePattern =
		/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
	let inlineMatch: RegExpExecArray | null;
	while ((inlineMatch = inlinePattern.exec(content)) !== null) {
		const start = inlineMatch.index;
		if (matched.some(([s, e]) => start >= s && start < e)) continue;
		const call = tryParseJSONToolCall(inlineMatch[0]);
		if (call) {
			toolCalls.push(call);
			matched.push([start, start + inlineMatch[0].length]);
		}
	}
	if (toolCalls.length === 0) return {toolCalls, cleanText: content};
	let cleanText = content;
	for (const [start, end] of matched.reverse()) {
		cleanText = cleanText.slice(0, start) + cleanText.slice(end);
	}
	return {toolCalls, cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim()};
}

function tryParseJSONToolCall(
	raw: string,
): {id: string; name: string; arguments: string} | null {
	try {
		const parsed = JSON.parse(raw) as {
			name?: unknown;
			arguments?: unknown;
		};
		if (
			typeof parsed.name !== 'string' ||
			!parsed.name ||
			parsed.arguments === null ||
			typeof parsed.arguments !== 'object' ||
			Array.isArray(parsed.arguments)
		) {
			return null;
		}
		return {
			id: `call_json_${Math.random().toString(36).slice(2, 8)}`,
			name: parsed.name,
			arguments: JSON.stringify(parsed.arguments),
		};
	} catch {
		return null;
	}
}

const MALFORMED_JSON_PATTERNS: Array<{regex: RegExp; error: string}> = [
	{
		regex:
			/(?:^|\n)\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*"[^"]*"\s*\}/,
		error: 'Invalid tool call: "arguments" must be an object, not a string',
	},
	{
		regex: /(?:^|\n)\s*\{\s*"name"\s*:\s*"[^"]+"\s*,?\s*\}/,
		error: 'Incomplete tool call: missing "arguments" field',
	},
	{
		regex: /(?:^|\n)\s*\{\s*"arguments"\s*:\s*\{[^}]*\}\s*\}/,
		error: 'Incomplete tool call: missing "name" field',
	},
];

/**
 * Layered tool-call recovery parser (parity: nanocoder's tool-parser): XML
 * dialects → Llama `<function=…>` tags → JSON-shaped calls → malformed
 * detection. Returns success:false with a human-readable error + format
 * guidance so the turn loop can feed it back to the model for self-correction.
 */
export function parseToolCalls(content: string): ToolCallParseResult {
	const stripped = stripThinkTags(content);
	// 1. XML dialects (tool_calls / antml:function_calls).
	const xml = parseXmlToolCalls(stripped);
	if (xml && xml.calls.length > 0) {
		return {success: true, toolCalls: xml.calls, cleanText: xml.cleanText};
	}
	// 2. Llama function tags.
	const fn = parseFunctionTagToolCalls(stripped);
	if (fn.toolCalls.length > 0) {
		return {success: true, toolCalls: fn.toolCalls, cleanText: fn.cleanText};
	}
	// 3. JSON tool-call objects.
	const json = parseJSONToolCalls(stripped);
	if (json.toolCalls.length > 0) {
		return {success: true, toolCalls: json.toolCalls, cleanText: json.cleanText};
	}
	// 4. Malformed XML / JSON detection → self-correction feedback.
	if (/<tool_calls|<invoke|<antml:|<function=/i.test(stripped)) {
		return {
			success: false,
			toolCalls: [],
			cleanText: stripped,
			error:
				'Malformed tool call: the model emitted tool-call markup that could not be parsed.',
			examples: TOOL_CALL_FORMAT_GUIDANCE,
		};
	}
	for (const {regex, error} of MALFORMED_JSON_PATTERNS) {
		if (regex.test(stripped)) {
			return {
				success: false,
				toolCalls: [],
				cleanText: stripped,
				error,
				examples: TOOL_CALL_FORMAT_GUIDANCE,
			};
		}
	}
	return {success: true, toolCalls: [], cleanText: stripped};
}

/**
 * Anthropic /v1/messages streaming path (E3 + B24): ≤4 `cache_control`
 * breakpoints in the invalidation order tools → system → latest user, and
 * tool calls arrive as `tool_use` blocks with `input_json_delta` args.
 */
async function anthropicStreamOnce(
	messages: ChatMessageLike[],
	handlers: StreamHandlers,
	signal?: AbortSignal,
	tools: ToolCatalogEntry[] = [],
	endpointOverride?: EndpointOverride,
	toolProfile?: string,
): Promise<TurnResult> {
	const endpoint = endpointOverride ?? activeEndpoint();
	const {system, anthropicMessages} = buildAnthropicMessages(
		messages,
		toolProfile,
	);
	const toolBlocks = tools.map(tool => ({
		name: tool.name,
		description: tool.description ?? '',
		input_schema: {type: 'object', properties: {}},
		cache_control: {type: 'ephemeral' as const},
	}));
	const response = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': endpoint.apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: endpoint.model,
			max_tokens: 8192,
			stream: true,
			system,
			...(toolBlocks.length > 0 ? {tools: toolBlocks} : {}),
			messages: anthropicMessages,
		}),
		signal,
	});

	if (!response.ok) {
		let message = '';
		try {
			const body = (await response.json()) as {error?: {message?: string}};
			message = body.error?.message ?? '';
		} catch {
			// keep the status
		}
		throw new ProviderError(
			response.status,
			classifyHttpError(response.status, message),
		);
	}
	if (!response.body) {
		return {text: '', reasoning: '', toolCalls: [], finishReason: 'stop'};
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let reasoning = '';
	let finishReason = 'stop';
	let usage: Record<string, unknown> | undefined;
	const toolCalls = new Map<
		number,
		{id: string; name: string; arguments: string}
	>();
	let eventName = '';

	while (true) {
		const {done, value} = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, {stream: true});
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith('event:')) {
				eventName = trimmed.slice(6).trim();
				continue;
			}
			if (!trimmed.startsWith('data:')) continue;
			const payload = trimmed.slice(5).trim();
			if (payload === '[DONE]') continue;
			let chunk: {
				type?: string;
				error?: {message?: string};
				message?: {usage?: Record<string, unknown>};
				index?: number;
				content_block?: {
					type?: string;
					id?: string;
					name?: string;
				};
				delta?: {
					type?: string;
					text?: string;
					partial_json?: string;
					stop_reason?: string | null;
				};
				usage?: Record<string, unknown>;
			};
			try {
				chunk = JSON.parse(payload);
			} catch {
				continue;
			}
			if (eventName === 'error' || chunk.type === 'error' || chunk.error) {
				throw new Error(chunk.error?.message ?? 'anthropic stream error');
			}
			switch (chunk.type) {
				case 'message_start':
					usage = chunk.message?.usage ?? usage;
					break;
				case 'content_block_start':
					if (chunk.content_block?.type === 'tool_use') {
						toolCalls.set(chunk.index ?? 0, {
							id: chunk.content_block.id ?? '',
							name: chunk.content_block.name ?? '',
							arguments: '',
						});
					}
					break;
				case 'content_block_delta':
					if (chunk.delta?.type === 'text_delta' && chunk.delta.text) {
						text += chunk.delta.text;
						handlers.onText(chunk.delta.text);
					}
					if (chunk.delta?.type === 'input_json_delta' && chunk.delta.partial_json) {
						const call = toolCalls.get(chunk.index ?? 0);
						if (call) call.arguments += chunk.delta.partial_json;
					}
					break;
				case 'message_delta':
					if (chunk.delta?.stop_reason) finishReason = chunk.delta.stop_reason;
					if (chunk.usage) usage = chunk.usage;
					break;
				default:
					break;
			}
		}
	}

	return {
		text,
		reasoning,
		toolCalls: [...toolCalls.values()].map(call => ({
			id: call.id,
			name: call.name,
			rawArguments: call.arguments,
			arguments: parseArguments(call.arguments),
		})),
		finishReason,
		usage,
	};
}

/**
 * Convert the app's OpenAI-shaped history to Anthropic message blocks, with
 * cache_control breakpoints on system + the latest user message (B24).
 */
function buildAnthropicMessages(
	messages: ChatMessageLike[],
	toolProfile?: string,
): {
	system: unknown[];
	anthropicMessages: unknown[];
} {
	// B1/B24: breakpoint on the STABLE block only; the volatile tail (cwd,
	// date, AGENTS.md) is excluded so per-session changes never invalidate it.
	const {stable, volatile} = buildSystemParts(toolProfile);
	const system = [
		{
			type: 'text',
			text: stable,
			cache_control: {type: 'ephemeral'},
		},
		...(volatile ? [{type: 'text' as const, text: volatile}] : []),
	];
	const out: Array<{role: string; content: unknown}> = [];
	for (const message of messages) {
		if (message.role === 'user') {
			out.push({role: 'user', content: message.content});
		} else if (message.role === 'assistant') {
			const content: unknown[] = [];
			if (message.content) content.push({type: 'text', text: message.content});
			for (const call of message.tool_calls ?? []) {
				let input: unknown = {};
				try {
					input = JSON.parse(call.arguments || '{}');
				} catch {
					input = {};
				}
				content.push({
					type: 'tool_use',
					id: call.id,
					name: call.name,
					input,
				});
			}
			out.push({role: 'assistant', content});
		} else if (message.role === 'tool') {
			const last = out[out.length - 1];
			if (
				last?.role === 'user' &&
				Array.isArray(last.content) &&
				last.content.some(
					(block: {type?: string}) =>
						typeof block === 'object' && block !== null && block.type === 'tool_result',
				)
			) {
				(last.content as Array<Record<string, unknown>>).push({
					type: 'tool_result',
					tool_use_id: message.tool_call_id,
					content: message.content,
				});
			} else {
				out.push({
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: message.tool_call_id,
							content: message.content,
						},
					],
				});
			}
		}
	}
	// Latest user message gets the final cache breakpoint (B24 order).
	for (let i = out.length - 1; i >= 0; i--) {
		const message = out[i];
		if (message?.role === 'user' && typeof message.content === 'string') {
			message.content = [
				{type: 'text', text: message.content, cache_control: {type: 'ephemeral'}},
			];
			break;
		}
	}
	return {system, anthropicMessages: out};
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseArguments(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {_malformed: raw};
	}
}

/**
 * Parse Anthropic-style XML function calls streamed as plain text
 * (parity: nanocoder's XML fallback path in doc 02 B6). Returns the calls
 * plus the text with the XML block stripped (ghost-echo strip).
 */
export function parseXmlToolCalls(text: string): {
	calls: Array<{id: string; name: string; arguments: string}>;
	cleanText: string;
} | null {
	// Accept BOTH Anthropic's `<antml:function_calls>` and the plain
	// `<tool_calls>` dialect (openai-compatible providers / Codex-style XML).
	const block =
		/<(?:tool_calls|antml:function_calls)>([\s\S]*?)<\/(?:tool_calls|antml:function_calls)>/.exec(
			text,
		);
	if (!block) return null;
	const calls: Array<{id: string; name: string; arguments: string}> = [];
	const invokeRe =
		/<(?:invoke|antml:invoke) name="([^"]+)">([\s\S]*?)<\/(?:invoke|antml:invoke)>/g;
	let invoke: RegExpExecArray | null;
	let index = 0;
	while ((invoke = invokeRe.exec(block[1] ?? ''))) {
		const name = invoke[1] ?? '';
		const body = invoke[2] ?? '';
		const args: Record<string, string> = {};
		// Named parameters: `<parameter name="command">`.
		const paramRe =
			/<(?:parameter|antml:parameter) name="([^"]+)">([\s\S]*?)<\/(?:parameter|antml:parameter)>/g;
		let param: RegExpExecArray | null;
		while ((param = paramRe.exec(body))) {
			args[param[1] ?? ''] = (param[2] ?? '').trim();
		}
		// POSITIONAL parameters: `<parameter string="0">`, the attribute
		// value is the argument INDEX; map it through the tool's declared
		// argument order (fallback `arg0`, `arg1`, …).
		const positionalRe =
			/<(?:parameter|antml:parameter) string="(\d+)">([\s\S]*?)<\/(?:parameter|antml:parameter)>/g;
		let pos: RegExpExecArray | null;
		const order = TOOL_POSITIONAL_ARGS[canonicalXmlTool(name)] ?? [];
		while ((pos = positionalRe.exec(body))) {
			const at = Number(pos[1] ?? 0);
			const key = order[at] ?? `arg${at}`;
			args[key] = (pos[2] ?? '').trim();
		}
		calls.push({
			id: `call_xml_${index++}`,
			name,
			arguments: JSON.stringify(args),
		});
	}
	if (calls.length === 0) return null;
	return {
		calls,
		cleanText: text.replace(block[0], '').trim(),
	};
}

/** claude-code display aliases → canonical tool names (for arg ordering). */
const XML_TOOL_ALIASES: Record<string, string> = {
	bash: 'execute_bash',
	read: 'read_file',
	write: 'write_file',
	edit: 'string_replace',
	find: 'find_files',
	grep: 'search_file_contents',
	ls: 'list_directory',
	websearch: 'web_search',
	webfetch: 'fetch_url',
	tasks: 'write_tasks',
};

function canonicalXmlTool(name: string): string {
	return XML_TOOL_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
}

/** Declared argument order for positional XML parameters. */
const TOOL_POSITIONAL_ARGS: Record<string, string[]> = {
	execute_bash: ['command'],
	read_file: ['path'],
	write_file: ['path', 'content'],
	string_replace: ['path', 'old_string', 'new_string'],
	diff_edit: ['path', 'diff'],
	git_status: ['cwd'],
	git_log: ['cwd'],
	git_diff: ['cwd'],
	file_op: ['op', 'path', 'target'],
	find_files: ['pattern', 'path'],
	list_directory: ['path'],
	search_file_contents: ['pattern', 'path'],
	web_search: ['query'],
	fetch_url: ['url'],
	skill: ['name', 'path'],
	check_skill: ['name', 'path'],
	monitor: ['task_id'],
};

/**
 * Mirror nanocoder's error-parser status mapping so the rendered messages match
 * the reference implementation (and the e2e assertions).
 */
function classifyHttpError(status: number, message: string): string {
	switch (status) {
		case 400:
			return `Bad request: ${message}`.trim();
		case 401:
			return 'Authentication failed: Invalid API key or credentials';
		case 403:
			return 'Access forbidden: Check your API permissions';
		case 404:
			return 'Model not found: The requested model may not exist or is unavailable';
		case 429:
			return `Rate limit exceeded: ${message || 'Too many requests. Please wait and try again'}`;
		case 500:
		case 502:
		case 503:
			return `Server error: ${message || 'unknown'}`;
		default:
			return `Request failed (${status}): ${message || 'unknown'}`;
	}
}
