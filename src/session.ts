/**
 * Session lifecycle (parity: nanocoder's session-manager + resolve-session).
 *
 * Each conversation is persisted to `$NANOCODER_CONFIG_DIR/sessions/<id>.json`
 * (or `~/.local/share/bobonyo/sessions`) immediately on creation
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
import {join} from 'node:path';
import {nanocoderDataDir} from './nanocoder-paths';
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
	// Sessions live in the NANOCODER DATA dir (`~/.local/share/nanocoder`),
	// NOT the config dir, resume must find the real nanocoder sessions.
	const base = nanocoderDataDir();
	return join(base, 'sessions');
}

function checkpointsDir(): string {
	const base = nanocoderDataDir();
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
		return null;
	}
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
		name: file.title ?? file.id,
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
