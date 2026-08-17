/**
 * OpenAI-compatible streaming chat client, talks to the same keyword-driven
 * mock provider as the nanocoder e2e suite (tools/mock-provider/server.mjs).
 * Parses text deltas, reasoning deltas, and tool-call deltas from the SSE.
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	activeEndpoint,
	cavemanMode,
	sessionId,
	setRetryingAttempt,
} from './state';
import {resolveRulesFile} from './rules-file';
import {builtinCavemanSkill, loadSkills} from './custom';
import {readCodexAuth} from './codex-auth';
import {loadSettings} from './settings';
import {
	formatOpenCodeLimitMessage,
	parseOpenCodeLimitError,
} from './opencode-limit';
import {resolveSystemPrompt, type SystemPromptStyle} from './system-prompt';

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
	/** Max ms with NO bytes from the provider before the stream is treated
	 *  as stalled (default 60s). Guards the read loop, not just the
	 *  between-read duration check — a silent provider would otherwise hang
	 *  the turn on a blocked `reader.read()` forever. */
	stallTimeoutMs?: number;
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
	'Before each tool call, FIRST write one short line of text (in the same ' +
	'message) explaining what you are about to do and why — never fire a ' +
	'tool with no accompanying text. Explain once per batch of related ' +
	'calls; skip the text only when this exact call continues the goal you ' +
	'already explained in the previous message. ' +
	'When you run `git commit`, use exactly ONE `-m` with a single-line ' +
	'subject and NEVER add AI-attribution lines (Co-authored-by:, Generated ' +
	'by:, or any credit to an LLM). When you run `gh pr create`, never ' +
	'credit an LLM in the title or body.';
const NANO_SYSTEM_PROMPT =
	'You are BoboNyo, a terminal coding agent. Be concise. ' +
	'Be blunt and a little snobbish, never sycophantic: honesty matters more than pleasing the user. ' +
	'Use tools for anything stateful (files, shell, git, web). ' +
	'Before each tool call, FIRST write one short line of text (same ' +
	'message) saying what you are about to do and why; never fire a tool ' +
	'with no text unless it continues the goal you already explained. ' +
	'Keep `git commit` messages to ONE single-line `-m` with no AI ' +
	'attribution, and never credit an LLM in `gh pr create`.';

/**
 * B1: volatile system-info block (cwd, AGENTS.md, skills). SESSION-STABLE in
 * practice (cwd fixed by the resume restore, AGENTS.md/skills rarely edited),
 * so it does not bust per-turn prefix caches; the ANTHROPIC path puts the
 * `cache_control` breakpoint on the STABLE block only, so the volatile tail
 * never invalidates the cached prefix. The CURRENT DATE deliberately does
 * NOT live here — it rides the provider user-message tail (codex parity) so
 * a day change never busts the head.
 */
function buildVolatileSystemInfo(): string {
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
	// F6: the model must know skills EXIST and how to invoke them — the
	// `skill`/`check_skill` tool descriptions cover the calling convention,
	// this block lists the loadable names. Same per-session stability class
	// as AGENTS.md (skills rarely change mid-session).
	const skills = loadSkills();
	const skillsBlock =
		skills.length > 0
			? `\n\n## AVAILABLE SKILLS\n` +
				skills
					.map(
						skill =>
							`- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`,
					)
					.join('\n') +
				`\nUse the skill tool to load a skill's instructions before acting on its domain.`
			: '';
	return (
		`## SYSTEM INFORMATION\n` +
		`Current Working Directory: ${cwd}\n` +
		`${agents}${skillsBlock}`
	);
}

/**
 * Current-date fragment appended to the PROVIDER user message (codex
 * parity: codex delivers the time as a per-turn user-message fragment that
 * is persisted in the rollout). The date must NOT live in the cached system
 * head — a day change (or a next-day resume) would bust the ENTIRE prefix
 * cache. Appending it to the user message keeps the head byte-stable while
 * the dated message is stored in the provider context, so a resumed
 * conversation reproduces the exact prefix.
 */
export function currentDateFragment(date = new Date()): string {
	return `\n\nCurrent date: ${date.toISOString().slice(0, 10)}`;
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
	const defaultBase =
		toolProfile === 'nano' ? NANO_SYSTEM_PROMPT : SYSTEM_PROMPT;
	// System-prompt STYLE (Settings → Behavior → System prompt): default /
	// opencode / claudecode / codex / custom (SYSTEM.md). A style change is
	// a legitimate head change, never a per-turn one.
	const style = (loadSettings().systemPrompt ?? 'default') as SystemPromptStyle;
	const base = resolveSystemPrompt(style, defaultBase);
	// Built-in caveman mode (Settings → Behavior → Caveman mode). The
	// instructions are part of the STABLE block so the cache head stays
	// byte-identical per session; toggling the setting is a legitimate head
	// change (same class as switching tool profile), never a per-turn one.
	const caveman = cavemanMode() ? builtinCavemanSkill() : null;
	const stable = caveman
		? `${base}\n\n## CAVEMAN MODE\n${caveman.body.trim()}`
		: base;
	return {stable, volatile: buildVolatileSystemInfo()};
}

export class ProviderError extends Error {
	status: number;
	/** Raw provider response body (e.g. opencode-go GoUsageLimitError). */
	body?: string;
	/** Raw provider response headers (e.g. `retry-after`). */
	headers?: Headers;
	constructor(
		status: number,
		message: string,
		body?: string,
		headers?: Headers,
	) {
		super(message);
		this.name = 'ProviderError';
		this.status = status;
		this.body = body;
		this.headers = headers;
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

/**
 * Auto-recovery for malformed tool-message sequences (legacy nanocoder
 * conversions, /undo rebuilds, resumed sessions): assistant `tool_calls`
 * with empty ids get synthesized `call-N` ids, and tool results with a
 * missing/empty `tool_call_id` are matched to the NEXT pending tool-call
 * declaration in order. A tool result with no declaration to match — or a
 * whole degenerate `tool_calls` block whose calls are all unnamed — is
 * DROPPED: sending it would 400 the request (`missing field
 * tool_call_id`). A no-op on well-formed input, pure, unit-tested.
 */
export function sanitizeToolCallIds(
	messages: ChatMessageLike[],
): ChatMessageLike[] {
	const out: ChatMessageLike[] = [];
	let pending: string[] = [];
	let callSeq = 0;
	let skipResults = false;
	for (const message of messages) {
		if (message.role === 'assistant' && message.tool_calls?.length) {
			const calls = message.tool_calls
				.map(call => ({
					id: call.id || `call-${callSeq++}`,
					name: call.name,
					arguments: call.arguments,
				}))
				.filter(call => Boolean(call.name.trim()));
			if (calls.length === 0) {
				// Degenerate block (e.g. legacy conversion lost the call
				// metadata): its results below are orphans — drop them all.
				pending = [];
				skipResults = true;
				continue;
			}
			skipResults = false;
			pending.push(...calls.map(call => call.id));
			out.push({...message, tool_calls: calls});
			continue;
		}
		if (message.role === 'tool') {
			if (skipResults) continue;
			const id = (message.tool_call_id ?? '').trim();
			if (id) {
				const declared = pending.includes(id);
				pending = pending.filter(next => next !== id);
				if (declared) out.push(message);
				// Undeclared id = orphan (its declaration was dropped or
				// compacted away) — sending it 400s, so drop it.
				continue;
			}
			// No id: match the next pending declaration, else drop.
			const matched = pending.shift();
			if (matched) out.push({...message, tool_call_id: matched});
			continue;
		}
		skipResults = false;
		out.push(message);
	}
	return out;
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
	/** OpenAI function schema; `{type: 'object', properties: {}}` by default. */
	parameters?: Record<string, unknown>;
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
				description: tool.description ?? '',
				parameters: tool.parameters ?? {type: 'object', properties: {}},
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
	/** Responses wire against the ChatGPT Codex backend (codex login). */
	codexAccount?: boolean;
	providerOptions?: Record<string, unknown>;
	promptCacheKey?: boolean;
}

/**
 * Anthropic tool blocks. HARD protocol rule: at most FOUR `cache_control`
 * breakpoints per request (invalidation order tools → system → latest
 * user). A breakpoint on the LAST tool caches the entire tool list, so
 * per-tool breakpoints (~27 with the full catalog) make real
 * Anthropic-compatible endpoints reject the request and bobonyo silently
 * falls back to a different model. Pure, unit-tested.
 */
export function anthropicToolBlocks(
	tools: ToolCatalogEntry[],
): Array<Record<string, unknown>> {
	return tools.map((tool, index) => ({
		name: tool.name,
		description: tool.description ?? '',
		input_schema: tool.parameters ?? {type: 'object', properties: {}},
		...(index === tools.length - 1
			? {cache_control: {type: 'ephemeral' as const}}
			: {}),
	}));
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
	/** Called when the ACTIVE provider failed and a fallback answered. */
	onFallback?: (endpoint: EndpointOverride) => void,
	/** Optional model override for isolated subagents; same provider/key. */
	modelOverride?: string,
): Promise<TurnResult> {
	const active = activeEndpoint();
	const candidates: Array<EndpointOverride | undefined> = [
		modelOverride && modelOverride !== active.model
			? {...active, model: modelOverride}
			: undefined,
		...fallbackEndpoints,
	];
	let lastError: unknown;
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		try {
			const result = await streamOnceWithRetries(
				messages,
				handlers,
				signal,
				tools,
				candidate,
				streamGuard,
				toolProfile,
			);
			if (index > 0 && onFallback && candidate) {
				onFallback(candidate);
			}
			return result;
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
			// opencode-go subscription limits (GoUsageLimitError /
			// FreeUsageLimitError) do NOT retry — they reset in hours/days,
			// not seconds. Surface the limit message immediately.
			if (
				error instanceof ProviderError &&
				parseOpenCodeLimitError(error.body, error.headers)
			) {
				throw error;
			}
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
	// Auto-recovery: legacy/undo/resume conversations can carry tool
	// messages without a matching `tool_call_id` (or tool_calls with empty
	// ids) — providers reject the body with "missing field tool_call_id".
	// Sanitize EVERY outgoing request so a bad history never 400s the turn.
	messages = sanitizeToolCallIds(messages);
	if (endpoint.sdkProvider === 'anthropic') {
		return anthropicStreamOnce(
			messages,
			handlers,
			signal,
			tools,
			endpoint,
			toolProfile,
			streamGuard,
		);
	}
	if (endpoint.sdkProvider === 'responses') {
		return responsesStreamOnce(
			messages,
			handlers,
			signal,
			tools,
			endpoint,
			toolProfile,
			streamGuard,
		);
	}
	const body = buildOpenAIRequestBody(messages, tools, endpoint, toolProfile);
	const response = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(endpoint.apiKey ? {authorization: `Bearer ${endpoint.apiKey}`} : {}),
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		throw await providerHttpError(response);
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
		maxOutputChars: streamGuard?.maxOutputChars ?? MAX_STREAM_OUTPUT_CHARS,
		maxDurationMs: streamGuard?.maxDurationMs ?? MAX_STREAM_DURATION_MS,
		stallTimeoutMs: streamGuard?.stallTimeoutMs ?? 60_000,
	};
	const streamStartedAt = Date.now();
	// See createStallGuard: a silent provider must not hang the turn.
	const stallGuard = createStallGuard(guard.stallTimeoutMs, () =>
		reader.cancel(),
	);

	while (true) {
		const {done, value} = await stallGuard.race(reader.read());
		stallGuard.clear();
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
	const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
	let fenceMatch: RegExpExecArray | null;
	while ((fenceMatch = fencePattern.exec(content)) !== null) {
		const call = tryParseJSONToolCall(fenceMatch[1] ?? '');
		if (call) {
			toolCalls.push(call);
			matched.push([fenceMatch.index, fenceMatch.index + fenceMatch[0].length]);
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
		return {
			success: true,
			toolCalls: json.toolCalls,
			cleanText: json.cleanText,
		};
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
	streamGuard?: StreamGuard,
): Promise<TurnResult> {
	const endpoint = endpointOverride ?? activeEndpoint();
	const {system, anthropicMessages} = buildAnthropicMessages(
		messages,
		toolProfile,
	);
	const toolBlocks = anthropicToolBlocks(tools);
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
		throw await providerHttpError(response);
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
	// Same silent-provider guard as the OpenAI loop: a blocked read must not
	// hang the turn forever.
	const stallGuard = createStallGuard(
		streamGuard?.stallTimeoutMs ?? 60_000,
		() => reader.cancel(),
	);

	while (true) {
		const {done, value} = await stallGuard.race(reader.read());
		stallGuard.clear();
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
					if (
						chunk.delta?.type === 'input_json_delta' &&
						chunk.delta.partial_json
					) {
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
 * Responses-API tool blocks (OpenAI `/v1/responses` AND the ChatGPT Codex
 * backend). The tool list is part of the cache head, so names are SORTED
 * exactly like `openAIToolBlocks` — a per-turn tool-set change busts the
 * prefix cache.
 */
export function responsesToolBlocks(
	tools: ToolCatalogEntry[],
	codexAccount = false,
): Array<Record<string, unknown>> {
	return [...tools]
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map(tool => ({
			type: 'function',
			name: tool.name,
			description: tool.description ?? '',
			parameters: tool.parameters ?? {type: 'object', properties: {}},
			// The ChatGPT Codex backend expects `strict: null` (reference:
			// the codex CLI request body); the standard API takes a boolean.
			strict: codexAccount ? null : false,
		}));
}

/**
 * Convert the app's OpenAI-shaped history to the Responses-API `input`
 * array. System → `instructions` (never in `input`), user/assistant text →
 * content items, assistant tool calls → `function_call` items, tool results
 * → `function_call_output` items. ORDER MATTERS: each function_call must
 * precede its matching function_call_output (the model pairs them by
 * call_id).
 */
export function buildResponsesInput(messages: ChatMessageLike[]): unknown[] {
	const input: unknown[] = [];
	for (const message of messages) {
		if (message.role === 'user') {
			input.push({
				role: 'user',
				content: [{type: 'input_text', text: message.content}],
			});
		} else if (message.role === 'assistant') {
			if (message.content) {
				input.push({
					role: 'assistant',
					content: [{type: 'output_text', text: message.content}],
				});
			}
			for (const call of message.tool_calls ?? []) {
				input.push({
					type: 'function_call',
					call_id: call.id,
					name: call.name,
					arguments: call.arguments,
				});
			}
		} else if (message.role === 'tool') {
			input.push({
				type: 'function_call_output',
				call_id: message.tool_call_id ?? '',
				output: message.content,
			});
		}
	}
	return input;
}

/**
 * Resolve the bearer + account id for a Responses-wire endpoint. The
 * ChatGPT Codex backend authenticates with the OAuth access token stored by
 * `codex login` (`~/.codex/auth.json`) and needs the `chatgpt-account-id`
 * header; the standard OpenAI API authenticates with the configured key.
 */
function resolveResponsesAuth(endpoint: {
	apiKey: string;
	codexAccount?: boolean;
}): {bearer: string; accountId?: string} {
	if (endpoint.codexAccount) {
		const auth = readCodexAuth();
		if (!auth.accessToken) {
			throw new ProviderError(
				401,
				'No Codex ChatGPT login found. Run `codex login` or reconnect with an API key.',
			);
		}
		return {bearer: auth.accessToken, accountId: auth.accountId};
	}
	return {bearer: endpoint.apiKey};
}

/**
 * Responses-API streaming path (E3-style wire family + Codex). Handles the
 * semantic SSE events: `response.output_item.added/done` (function_call
 * items), `response.output_text.delta`, `response.content_part.delta`,
 * `response.reasoning_summary_text.delta`, function-argument deltas (both
 * the standard `response.function_call_arguments.delta` and the ChatGPT
 * backend's `response.custom_tool_call_input.delta`) and
 * `response.completed` (usage + terminal status).
 */
async function responsesStreamOnce(
	messages: ChatMessageLike[],
	handlers: StreamHandlers,
	signal?: AbortSignal,
	tools: ToolCatalogEntry[] = [],
	endpointOverride?: EndpointOverride,
	toolProfile?: string,
	streamGuard?: StreamGuard,
): Promise<TurnResult> {
	const endpoint = endpointOverride ?? activeEndpoint();
	const {stable, volatile} = buildSystemParts(toolProfile);
	const instructions = volatile ? `${stable}\n\n${volatile}` : stable;
	const {bearer, accountId} = resolveResponsesAuth(endpoint);
	const body: Record<string, unknown> = {
		model: endpoint.model,
		store: false,
		stream: true,
		instructions,
		input: buildResponsesInput(messages),
		tools: responsesToolBlocks(tools, Boolean(endpoint.codexAccount)),
		text: {verbosity: 'low'},
	};
	if (endpoint.codexAccount) {
		// Session affinity for the ChatGPT Codex backend: the request body
		// carries the persisted session id so the provider can keep a warm
		// prefix across turns (same contract as prompt_cache_key).
		body.prompt_cache_key = sessionId().slice(0, 64);
	} else if (endpoint.promptCacheKey) {
		body.prompt_cache_key = sessionId();
	}
	if (endpoint.providerOptions) {
		Object.assign(body, endpoint.providerOptions);
	}
	const base = endpoint.baseUrl.replace(/\/+$/, '');
	const url = endpoint.codexAccount
		? `${base}/responses`
		: `${base}/v1/responses`;
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'text/event-stream',
			...(bearer ? {authorization: `Bearer ${bearer}`} : {}),
			...(endpoint.codexAccount && accountId
				? {'chatgpt-account-id': accountId}
				: {}),
			...(endpoint.codexAccount
				? {
						'OpenAI-Beta': 'responses=experimental',
						originator: 'bobonyo',
						'session-id': sessionId(),
					}
				: {}),
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		throw await providerHttpError(response);
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
	const guard = {
		maxOutputChars: streamGuard?.maxOutputChars ?? MAX_STREAM_OUTPUT_CHARS,
		maxDurationMs: streamGuard?.maxDurationMs ?? MAX_STREAM_DURATION_MS,
		stallTimeoutMs: streamGuard?.stallTimeoutMs ?? 60_000,
	};
	const streamStartedAt = Date.now();
	const stallGuard = createStallGuard(guard.stallTimeoutMs, () =>
		reader.cancel(),
	);
	let eventName = '';

	interface ResponseChunk {
		type?: string;
		error?: {message?: string};
		delta?: unknown;
		text?: string;
		output_index?: number;
		item?: {
			type?: string;
			id?: string;
			call_id?: string;
			name?: string;
			arguments?: string;
		};
		response?: {
			status?: string;
			error?: {message?: string};
			usage?: Record<string, unknown>;
			incomplete_details?: {reason?: string};
		};
	}

	while (true) {
		const {done, value} = await stallGuard.race(reader.read());
		stallGuard.clear();
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
			if (trimmed.startsWith('event:')) {
				eventName = trimmed.slice(6).trim();
				continue;
			}
			if (!trimmed.startsWith('data:')) continue;
			const payload = trimmed.slice(5).trim();
			if (!payload || payload === '[DONE]') continue;
			let chunk: ResponseChunk;
			try {
				chunk = JSON.parse(payload) as ResponseChunk;
			} catch {
				continue;
			}
			const type = chunk.type ?? eventName;
			if (type === 'error' || chunk.error) {
				throw new Error(chunk.error?.message ?? 'responses stream error');
			}
			switch (type) {
				case 'response.output_item.added': {
					const item = chunk.item;
					if (item?.type === 'function_call') {
						toolCalls.set(chunk.output_index ?? toolCalls.size, {
							id: item.call_id ?? item.id ?? '',
							name: item.name ?? '',
							arguments: item.arguments ?? '',
						});
					}
					break;
				}
				case 'response.output_text.delta': {
					const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
					if (delta) {
						text += delta;
						if (text.length > guard.maxOutputChars) {
							throw new StreamRunawayError(
								'output',
								`${Math.round(text.length / 1000)}k`,
							);
						}
						handlers.onText(delta);
					}
					break;
				}
				case 'response.content_part.delta': {
					const part =
						typeof chunk.delta === 'string'
							? chunk.delta
							: ((chunk.delta as {text?: string} | undefined)?.text ?? '');
					if (part) {
						text += part;
						if (text.length > guard.maxOutputChars) {
							throw new StreamRunawayError(
								'output',
								`${Math.round(text.length / 1000)}k`,
							);
						}
						handlers.onText(part);
					}
					break;
				}
				case 'response.reasoning_summary_text.delta': {
					if (typeof chunk.delta === 'string' && chunk.delta) {
						reasoning += chunk.delta;
						handlers.onReasoning(chunk.delta);
					}
					break;
				}
				case 'response.function_call_arguments.delta':
				case 'response.custom_tool_call_input.delta': {
					if (typeof chunk.delta === 'string' && chunk.delta) {
						const index = chunk.output_index ?? toolCalls.size - 1;
						const call = toolCalls.get(index);
						if (call) call.arguments += chunk.delta;
					}
					break;
				}
				case 'response.output_item.done': {
					const item = chunk.item;
					if (item?.type === 'function_call') {
						const index = chunk.output_index ?? toolCalls.size - 1;
						const existing = toolCalls.get(index);
						if (existing) {
							if (item.name) existing.name = item.name;
							if (item.call_id) existing.id = item.call_id;
							if (item.arguments) {
								existing.arguments = item.arguments;
							}
						} else {
							toolCalls.set(index, {
								id: item.call_id ?? item.id ?? '',
								name: item.name ?? '',
								arguments: item.arguments ?? '',
							});
						}
					}
					break;
				}
				case 'response.completed': {
					const response = chunk.response;
					if (response?.status) {
						finishReason =
							response.status === 'completed' ? 'stop' : response.status;
					}
					if (response?.usage) usage = response.usage;
					break;
				}
				case 'response.incomplete': {
					const reason =
						chunk.response?.incomplete_details?.reason ?? 'unknown';
					throw new Error(`Incomplete response returned, reason: ${reason}`);
				}
				case 'response.failed': {
					throw new Error(chunk.response?.error?.message ?? 'response failed');
				}
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
export function buildAnthropicMessages(
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
						typeof block === 'object' &&
						block !== null &&
						block.type === 'tool_result',
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
				{
					type: 'text',
					text: message.content,
					cache_control: {type: 'ephemeral'},
				},
			];
			break;
		}
	}
	return {system, anthropicMessages: out};
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Client-side STALL guard for a stream reader. The provider can go SILENT
 * (no bytes, no close); a plain `await reader.read()` would then block the
 * turn forever — the duration guard only runs BETWEEN reads, so it never
 * fires. Every read races a no-data timeout; on timeout the connection is
 * released and a ProviderError with the stall-message shape is thrown, so
 * streamOnceWithRetries retries (and eventually surfaces) instead of
 * hanging at "Working…".
 */
function createStallGuard(
	timeoutMs: number,
	release: () => Promise<void>,
): {
	race<T>(promise: Promise<T>): Promise<T>;
	clear(): void;
} {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const clear = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
	return {
		clear,
		race<T>(promise: Promise<T>): Promise<T> {
			clear();
			return Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						clear();
						void release().catch(() => {});
						reject(
							new ProviderError(
								500,
								`Stream produced no non-ping SSE event within ${timeoutMs}ms`,
							),
						);
					}, timeoutMs);
				}),
			]);
		},
	};
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

/**
 * Build the ProviderError for a failed HTTP response. The raw body + headers
 * ride along so opencode-go limit errors (GoUsageLimitError metadata,
 * `retry-after`) can be surfaced with opencode parity — the message itself
 * is the limit message when one is detected.
 */
async function providerHttpError(response: Response): Promise<ProviderError> {
	let message = '';
	let bodyText = '';
	try {
		bodyText = await response.text();
		const body = JSON.parse(bodyText) as {error?: {message?: string}};
		message = body.error?.message ?? '';
	} catch {
		// keep the status; the raw text is still captured for limit parsing
	}
	const limit = parseOpenCodeLimitError(bodyText, response.headers);
	if (limit) {
		message = formatOpenCodeLimitMessage(limit);
	} else {
		message = classifyHttpError(response.status, message);
	}
	return new ProviderError(
		response.status,
		message,
		bodyText,
		response.headers,
	);
}
