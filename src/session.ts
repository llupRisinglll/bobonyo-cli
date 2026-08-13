/**
 * Session lifecycle (parity: nanocoder's session-manager + resolve-session).
 *
 * Each conversation is persisted to `~/.local/share/bobonyo/sessions/<id>.json`
 * (legacy `~/.local/share/nanocoder/sessions` is migrated on first run)
 * immediately on creation
 * and after every committed turn, so a crash never loses a conversation.
 * `/resume last|<index>|<id>` resolves and loads a session.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';
import {displayToolName, toolArgsSummary} from './tools';
import type {ChatMessageLike, MockToolCall} from './client';
import type {ChatMessage} from './state';

export interface SessionMeta {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	firstMessage: string;
	/** Working directory the conversation was created in (for /resume's
	 *  current-folder filter; legacy sessions may not carry it). */
	cwd?: string;
	/** Provider + model the conversation ran on. Persisted on every save so
	 *  /resume can restore the ORIGINAL model instead of the most-recently
	 *  used one. Legacy sessions may not carry these. */
	provider?: string;
	model?: string;
}

export interface SessionData extends SessionMeta {
	messages: ChatMessage[];
	context: ChatMessageLike[];
}

/** Normalize a session timestamp to epoch MILLISECONDS. */
function toEpoch(value: unknown): number {
	if (typeof value === 'number') {
		// Seconds (1e9-ish) vs milliseconds (1e12-ish) heuristic, some
		// legacy/nanocoder files store ISO strings or seconds.
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function sessionsDir(): string {
	// Sessions live in the BOBONYO DATA dir (`~/.local/share/bobonyo`),
	// NOT the config dir; the legacy nanocoder sessions are migrated once.
	const base = bobonyoDataDir();
	return join(base, 'sessions');
}

/**
 * The LEGACY nanocoder sessions dir. The one-time full-dir copy in
 * `bobonyo-paths` only runs when the bobonyo data dir did not exist yet —
 * if it already did (or new sessions were created after the copy), old
 * UUID session files never reach `bobonyo/sessions` and `--resume <uuid>`
 * reports "not found". This is the source those sessions are migrated from.
 */
function nanocoderSessionsDir(): string {
	if (process.env.NANOCODER_DATA_DIR) {
		return join(process.env.NANOCODER_DATA_DIR, 'sessions');
	}
	if (process.env.XDG_DATA_HOME) {
		return join(process.env.XDG_DATA_HOME, 'nanocoder', 'sessions');
	}
	return join(homedir(), '.local', 'share', 'nanocoder', 'sessions');
}

/**
 * Migrate every legacy nanocoder session into the bobonyo sessions dir
 * (converted to the bobonyo shape, idempotent, non-destructive). The
 * legacy `sessions.json` index is skipped — only real `<uuid>.json`
 * conversations convert. Returns the number of sessions migrated.
 */
export function migrateNanocoderSessions(): number {
	const legacy = nanocoderSessionsDir();
	if (!existsSync(legacy)) return 0;
	mkdirSync(sessionsDir(), {recursive: true});
	let migrated = 0;
	for (const file of readdirSync(legacy)) {
		if (!file.endsWith('.json') || file === 'sessions.json') continue;
		try {
			const raw = JSON.parse(
				readFileSync(join(legacy, file), 'utf8'),
			) as NanocoderSessionFile;
			if (
				typeof raw.id !== 'string' ||
				!Array.isArray(raw.messages) ||
				raw.messages.length === 0
			) {
				continue;
			}
			if (existsSync(sessionPath(raw.id))) continue;
			const converted = convertNanocoderSession(raw);
			if (!converted || converted.messages.length === 0) continue;
			writeFileSync(
				sessionPath(converted.id),
				`${JSON.stringify(converted, null, 2)}\n`,
				'utf8',
			);
			migrated += 1;
		} catch {
			// Corrupt legacy file: skip, never block resume/startup.
		}
	}
	return migrated;
}

function checkpointsDir(): string {
	const base = bobonyoDataDir();
	return join(base, 'checkpoints');
}

export interface CheckpointData {
	id: string;
	name: string;
	createdAt: number;
	messages: ChatMessage[];
	context: ChatMessageLike[];
}

/** A4: save a named checkpoint snapshot of the current conversation. */
export function saveCheckpoint(
	name: string,
	messages: ChatMessage[],
	context: ChatMessageLike[],
): string {
	const dir = checkpointsDir();
	mkdirSync(dir, {recursive: true});
	const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	const data: CheckpointData = {
		id: `ckpt_${Date.now().toString(36)}`,
		name: safe,
		createdAt: Date.now(),
		messages,
		context,
	};
	writeFileSync(
		join(dir, `${safe}.json`),
		`${JSON.stringify(data, null, 2)}\n`,
		'utf8',
	);
	return safe;
}

export function listCheckpoints(): CheckpointData[] {
	const dir = checkpointsDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(file => file.endsWith('.json'))
		.map(file => {
			try {
				return JSON.parse(
					readFileSync(join(dir, file), 'utf8'),
				) as CheckpointData;
			} catch {
				return null;
			}
		})
		.filter((data): data is CheckpointData => data !== null)
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadCheckpoint(name: string): CheckpointData | null {
	const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	const file = join(checkpointsDir(), `${safe}.json`);
	try {
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, 'utf8')) as CheckpointData;
	} catch {
		return null;
	}
}

function sessionPath(id: string): string {
	return join(sessionsDir(), `${id}.json`);
}

let idSeq = 0;
export function newSessionId(): string {
	idSeq += 1;
	return `sess_${Date.now().toString(36)}_${idSeq}`;
}

export function saveSession(data: SessionData): void {
	mkdirSync(sessionsDir(), {recursive: true});
	// EMPTY conversations are never persisted, delete any stale empty file
	// so they can't appear in the resume/save list.
	if (!data.messages || data.messages.length === 0) {
		try {
			rmSync(sessionPath(data.id), {force: true});
		} catch {
			// best-effort
		}
		return;
	}
	writeFileSync(sessionPath(data.id), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function listSessions(): SessionMeta[] {
	// Bring legacy nanocoder sessions into the bobonyo dir so the resume
	// picker shows every old conversation (idempotent after the first run).
	migrateNanocoderSessions();
	const dir = sessionsDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(file => file.endsWith('.json'))
		.map(file => {
			try {
				const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SessionData & {
					title?: string;
					messageCount?: number;
				};
				// Skip EMPTY sessions (both formats).
				const messageCount =
					data.messages?.length ?? data.messageCount ?? 0;
				if (messageCount === 0) return null;
				const createdAt = toEpoch(data.createdAt);
				const updatedAt = toEpoch(data.updatedAt) || createdAt;
				const cwd =
					typeof data.cwd === 'string' && data.cwd.length > 0
						? data.cwd
						: undefined;
				return {
					id: data.id,
					// nanocoder sessions carry `title` instead of `name`.
					name: data.name ?? data.title ?? data.id,
					createdAt,
					updatedAt,
					firstMessage: data.firstMessage,
					...(cwd ? {cwd} : {}),
				};
			} catch {
				return null;
			}
		})
		.filter((meta): meta is SessionMeta => meta !== null)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		// Dedupe by id: the same session can be saved under several files
		// (nanocoder sessions + local copies), keep the newest entry so the
		// resume picker never shows duplicates ("Today" twice, same days).
		.filter(
			((seen: Set<string>) => (meta: SessionMeta) =>
				!seen.has(meta.id) && (seen.add(meta.id), true))(new Set()),
		);
}

export function loadSession(id: string): SessionData | null {
	try {
		const raw = JSON.parse(readFileSync(sessionPath(id), 'utf8')) as SessionData;
		// NANOCODER session files use a different shape (`title`, OpenAI-style
		// messages, no `context`), convert them so resume actually works.
		if (raw.context === undefined || raw.name === undefined) {
			return (
				convertNanocoderSession(
					raw as unknown as NanocoderSessionFile,
				) ?? raw
			);
		}
		return raw;
	} catch {
		// fall through to the legacy nanocoder file below
	}
	// The session may only exist in the legacy data dir (the full-dir copy
	// is skipped when the bobonyo dir already existed). Convert it on the
	// fly and persist the copy so the next resume is a local hit.
	try {
		const legacy = join(nanocoderSessionsDir(), `${id}.json`);
		if (!existsSync(legacy)) return null;
		const raw = JSON.parse(
			readFileSync(legacy, 'utf8'),
		) as NanocoderSessionFile;
		const converted = convertNanocoderSession(raw);
		if (converted && converted.messages.length > 0) {
			saveSession(converted);
			return converted;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Resume repair for sessions persisted BEFORE interrupted turns committed
 * their history to the provider context (the context can lag the
 * transcript — user messages missing, so a resumed conversation looks
 * empty to the model). Detects the divergence (context has FEWER user
 * messages than the transcript) and rebuilds the provider context from the
 * transcript: user rows verbatim, error rows and reasoning-only rows
 * skipped, and runs of tool rows reconstructed as one assistant
 * `tool_calls` message + per-call tool results (the real outputs live in
 * the transcript's `tool.output`). Pure, unit-tested.
 *
 * CACHE INVARIANT: the rebuild must only trigger on GENUINE tail lag, not
 * on normal context capping. The live loop caps the provider context to the
 * newest N messages (`capMessages`), so a long conversation legitimately
 * has fewer users in context than in the full transcript — comparing raw
 * user counts misread every capped session as broken, rebuilt the ENTIRE
 * history on every resume, and sent a bigger, byte-different head that
 * busted the provider's prefix cache (cost went up). The trigger is now the
 * context's TAIL: heal only when the context does not already end where the
 * transcript ends. Rebuilds are also capped to the same newest-N the live
 * loop uses, so a repair never exceeds the original request size.
 */
export function healResumedContext(
	context: ChatMessageLike[],
	messages: ChatMessage[],
	max = Number.POSITIVE_INFINITY,
): ChatMessageLike[] {
	if (contextCoversTranscriptTail(context, messages)) return context;

	const out: ChatMessageLike[] = [];
	let toolRun: Array<{
		id?: string;
		name: string;
		args?: Record<string, unknown>;
		output?: string;
	}> = [];
	const flushTools = () => {
		if (toolRun.length === 0) return;
		out.push({
			role: 'assistant',
			content: '',
			tool_calls: toolRun.map((tool, index) => ({
				id: tool.id ?? `call-${index}`,
				name: tool.name,
				arguments: JSON.stringify(tool.args ?? {}),
			})),
		});
		for (const tool of toolRun) {
			out.push({
				role: 'tool',
				content: tool.output ?? '',
				tool_call_id: tool.id ?? '',
			});
		}
		toolRun = [];
	};
	for (const message of messages) {
		if (message.role === 'tool') {
			toolRun.push({
				id: message.toolId,
				name: message.tool?.name ?? '',
				args: message.tool?.args,
				output: message.tool?.output,
			});
			continue;
		}
		flushTools();
		if (message.role === 'user' && !message.error) {
			out.push({role: 'user', content: message.content});
		} else if (
			message.role === 'assistant' &&
			!message.error &&
			message.content.trim()
		) {
			out.push({role: 'assistant', content: message.content});
		}
	}
	flushTools();
	// Keep the same newest-N the live loop keeps, so a repaired context never
	// outgrows what the original conversation actually sent (bounded cost).
	if (Number.isFinite(max) && out.length > max) {
		const sliced = out.slice(-max);
		let start = 0;
		while (start < sliced.length && sliced[start]?.role === 'tool') start++;
		return sliced.slice(start);
	}
	return out;
}

/**
 * True when the context already ends where the transcript ends (a valid
 * capped tail), so the rebuild can be skipped and the persisted bytes — the
 * exact prefix the provider cached — are reused untouched.
 */
function contextCoversTranscriptTail(
	context: ChatMessageLike[],
	messages: ChatMessage[],
): boolean {
	if (context.length === 0) return messages.length === 0;
	const last = context[context.length - 1]!;
	// Scan from the newest transcript row for the first message that maps to
	// a provider-context row (error rows, info rows and reasoning-only
	// assistant rows never reach the context).
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.kind === 'info' || message.kind === 'warning') continue;
		if (message.error) continue;
		if (message.role === 'assistant' && !message.content?.trim()) continue;
		if (message.role === 'tool') {
			return last.role === 'tool' && last.tool_call_id === message.toolId;
		}
		if (message.role === 'user') {
			return last.role === 'user' && last.content === message.content;
		}
		return last.role === 'assistant' && last.content === message.content;
	}
	return true;
}

interface NanocoderSessionFile {
	id: string;
	title?: string;
	createdAt?: string;
	lastAccessedAt?: string;
	messages?: Array<{
		role: string;
		content?: string;
		tool_call_id?: string;
		name?: string;
		tool_calls?: Array<{
			id: string;
			function?: {name: string; arguments: string | Record<string, unknown>};
		}>;
	}>;
	/** Some nanocoder files carry the display label as `name`, not `title`. */
	name?: string;
}

/** Convert a NANOCODER session file into bobonyo's SessionData shape. */
export function convertNanocoderSession(
	file: NanocoderSessionFile,
): SessionData | null {
	if (!file || typeof file.id !== 'string') return null;
	const msgs = Array.isArray(file.messages) ? file.messages : [];
	const messages: ChatMessage[] = [];
	const context: ChatMessageLike[] = [];

	for (const message of msgs) {
		if (message.role === 'user') {
			const content = message.content ?? '';
			messages.push({role: 'user', content});
			context.push({role: 'user', content});
			continue;
		}
		if (message.role === 'assistant') {
			// Assistant tool calls become tool rows (rendered like executed
			// calls); the assistant TEXT stays an assistant message.
			if (message.tool_calls?.length) {
				for (const call of message.tool_calls) {
					const name = call.function?.name ?? 'unknown';
					const rawArgs = call.function?.arguments;
					const args =
						typeof rawArgs === 'string'
							? (safeParseArgs(rawArgs) ?? {})
							: (rawArgs ?? {});
					const mockCall = {
						id: call.id ?? '',
						name,
						arguments: args,
						rawArguments: JSON.stringify(args),
					} as MockToolCall;
					const detail = toolArgsSummary(mockCall);
					messages.push({
						role: 'tool',
						content: `✦ ${displayToolName(name)}${detail ? `(${detail})` : ''}`,
						toolId: call.id,
						tool: {name, detail, output: '', args},
					});
					context.push({
						role: 'assistant',
						content: '',
						tool_calls: [
							{id: call.id ?? '', name, arguments: JSON.stringify(args)},
						],
					});
				}
			}
			if (message.content) {
				messages.push({role: 'assistant', content: message.content});
				context.push({role: 'assistant', content: message.content});
			}
			continue;
		}
		if (message.role === 'tool') {
			const content = message.content ?? '';
			const name = message.name ?? '';
			const toolId = message.tool_call_id ?? '';
			// Attach the result to the matching tool row (by call id).
			const existing = messages.find(
				candidate => candidate.toolId === toolId,
			);
			if (existing?.tool) {
				existing.tool.output = content;
				existing.content = content;
			} else {
				messages.push({
					role: 'tool',
					content,
					toolId,
					tool: {name, detail: '', output: content, args: {}},
				});
			}
			context.push({role: 'tool', content, tool_call_id: toolId});
		}
	}

	return {
		id: file.id,
		name: file.name ?? file.title ?? file.id,
		createdAt: new Date(file.createdAt ?? Date.now()).getTime(),
		updatedAt: new Date(
			file.lastAccessedAt ?? file.createdAt ?? Date.now(),
		).getTime(),
		firstMessage: firstMessagePreview(messages),
		messages,
		context,
	};
}

function safeParseArgs(raw: string): Record<string, unknown> | null {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function deleteSession(id: string): void {
	rmSync(sessionPath(id), {force: true});
}

/** `last` → most recent; `N` → index into the sorted list; otherwise an id. */
export function resolveSession(ref: string): SessionData | null {
	const sessions = listSessions();
	if (ref === 'last') {
		return sessions[0] ? loadSession(sessions[0].id) : null;
	}
	if (/^\d+$/.test(ref)) {
		const meta = sessions[Number(ref)];
		return meta ? loadSession(meta.id) : null;
	}
	return loadSession(ref);
}

export function firstMessagePreview(messages: ChatMessage[]): string {
	const user = messages.find(message => message.role === 'user');
	const text = user?.content.trim() ?? '(empty conversation)';
	return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
