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
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';
import type {ChatMessageLike} from './client';
import type {SteeringMessage} from './live-steering';
import type {
	ActiveAgentRun,
	ChatMessage,
	SessionUsageSnapshot,
	SessionTask,
} from './state';
import type {LoopJob, SessionGoal} from './goal-loop';
import {copySessionMemory} from './memory';
import {
	deleteTranscriptArchive,
	forkTranscriptArchive,
	transcriptArchiveInfo,
} from './transcript-archive';
import type {GraphContextSnapshot} from './graph-context';
import {firstMessagePreview, lastMessagePreview} from './session-previews';
import {
	convertNanocoderSession,
	migrateNanocoderSessions,
	nanocoderSessionsDir,
} from './session-migration';
import type {NanocoderSessionFile} from './session-migration';
export {
	convertNanocoderSession,
	migrateNanocoderSessions,
	nanocoderSessionsDir,
} from './session-migration';
export {firstMessagePreview, lastMessagePreview} from './session-previews';
export {
	loadCheckpoint,
	listCheckpoints,
	saveCheckpoint,
} from './session-checkpoints';
export type {CheckpointData} from './session-checkpoints';

export interface SessionMeta {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	/** Epoch milliseconds when latest user prompt was sent. */
	lastMessageAt?: number;
	firstMessage: string;
	/** Latest user prompt, used by the resume picker preview. */
	lastMessage?: string;
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
	/** Accepted directions not yet inserted into model history. Resume retains them without auto-running. */
	steeringInbox?: SteeringMessage[];
	messages: ChatMessage[];
	context: ChatMessageLike[];
	/** Missing in legacy sessions; never infer graph ownership from the transcript. */
	graphContexts?: GraphContextSnapshot;
	/** Codex-style persisted long-running goal. */
	goal?: SessionGoal;
	/** Codex-style scheduled thread jobs created by /loop. */
	loopJobs?: LoopJob[];
	/** Recent subagent child histories, restored into /ps on resume. */
	subagentRuns?: ActiveAgentRun[];
	/** Per-session provider usage, including prompt-cache counts. */
	usageHistory?: SessionUsageSnapshot[];
	/** Current task checklist, restored on resume. */
	/** Legacy sessions may omit task ids; resume normalization assigns them. */
	tasks?: Array<Omit<SessionTask, 'id'> & {id?: string}>;
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
function sessionPath(id: string): string {
	return join(sessionsDir(), `${id}.json`);
}

function compactionTranscriptsDir(): string {
	return join(bobonyoDataDir(), 'compaction-transcripts');
}

/** Durable pre-compaction transcript for exact-detail recovery. */
export function saveCompactionTranscript(
	sessionId: string,
	messages: ChatMessage[],
	context: ChatMessageLike[],
	now = Date.now(),
): string {
	const dir = compactionTranscriptsDir();
	mkdirSync(dir, {recursive: true});
	const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
	const path = join(dir, `${safeId}.jsonl`);
	appendFileSync(
		path,
		`${JSON.stringify({sessionId, createdAt: now, messages, context})}\n`,
		'utf8',
	);
	return path;
}

let idSeq = 0;
export function newSessionId(): string {
	idSeq += 1;
	return `sess_${Date.now().toString(36)}_${idSeq}`;
}

/** Create independent Codex-style branch from current session snapshot. */
export function forkSession(data: SessionData): SessionData {
	const forked: SessionData = {
		...data,
		id: newSessionId(),
		name: `${data.name} (fork)`,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		messages: structuredClone(data.messages),
		context: structuredClone(data.context),
		graphContexts: data.graphContexts
			? structuredClone(data.graphContexts)
			: undefined,
		tasks: structuredClone(data.tasks ?? []),
	};
	forkTranscriptArchive(data.id, forked.id);
	saveSession(forked);
	copySessionMemory(data.id, forked.id);
	return forked;
}
export function saveSession(data: SessionData): void {
	mkdirSync(sessionsDir(), {recursive: true});
	// A fully compacted display can be empty while exact history remains on disk.
	// Delete only genuinely empty conversations, not archive-only sessions.
	if (
		(!data.messages || data.messages.length === 0) &&
		!data.goal &&
		(data.loopJobs?.length ?? 0) === 0 &&
		(data.tasks?.length ?? 0) === 0 &&
		transcriptArchiveInfo(data.id).count === 0
	) {
		try {
			rmSync(sessionPath(data.id), {force: true});
		} catch {
			// best-effort
		}
		return;
	}
	writeFileSync(
		sessionPath(data.id),
		`${JSON.stringify(data, null, 2)}\n`,
		'utf8',
	);
}

export function listSessions(): SessionMeta[] {
	// Bring legacy nanocoder sessions into the bobonyo dir so the resume
	// picker shows every old conversation (idempotent after the first run).
	migrateNanocoderSessions();
	const dir = sessionsDir();
	if (!existsSync(dir)) return [];
	return (
		readdirSync(dir)
			.filter(file => file.endsWith('.json'))
			.map((file): SessionMeta | null => {
				try {
					const data = JSON.parse(
						readFileSync(join(dir, file), 'utf8'),
					) as SessionData & {
						title?: string;
						messageCount?: number;
					};
					// Skip genuinely empty sessions, retaining compacted archive-only ones.
					const messageCount = data.messages?.length ?? data.messageCount ?? 0;
					if (
						messageCount === 0 &&
						!data.goal &&
						(data.loopJobs?.length ?? 0) === 0 &&
						(data.tasks?.length ?? 0) === 0 &&
						transcriptArchiveInfo(data.id).count === 0
					)
						return null;
					const createdAt = toEpoch(data.createdAt);
					const updatedAt = toEpoch(data.updatedAt) || createdAt;
					const lastMessageAt = toEpoch(data.lastMessageAt) || updatedAt;
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
						lastMessageAt,
						firstMessage:
							data.firstMessage ?? firstMessagePreview(data.messages ?? []),
						lastMessage: lastMessagePreview(data.messages ?? []),
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
				(
					(seen: Set<string>) => (meta: SessionMeta) =>
						!seen.has(meta.id) && (seen.add(meta.id), true)
				)(new Set()),
			)
	);
}

export function loadSession(id: string): SessionData | null {
	// Keep legacy file type private to migration module through inference.
	try {
		const raw = JSON.parse(
			readFileSync(sessionPath(id), 'utf8'),
		) as SessionData;
		// NANOCODER session files use a different shape (`title`, OpenAI-style
		// messages, no `context`), convert them so resume actually works.
		if (raw.context === undefined || raw.name === undefined) {
			return (
				convertNanocoderSession(raw as unknown as NanocoderSessionFile) ?? raw
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
		) as unknown as NanocoderSessionFile;
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
		// Each tool result must reference the SAME id its declaration uses
		// (a missing transcript toolId synthesizes one for BOTH sides —
		// mismatched ids would 400 the request body).
		const calls = toolRun.map((tool, index) => {
			const id = tool.id ?? `call-${index}`;
			return {
				id,
				name: tool.name,
				arguments: JSON.stringify(tool.args ?? {}),
				output: tool.output ?? '',
			};
		});
		out.push({
			role: 'assistant',
			content: '',
			tool_calls: calls.map(({output: _output, ...call}) => call),
		});
		for (const call of calls) {
			out.push({
				role: 'tool',
				content: call.output,
				tool_call_id: call.id,
			});
		}
		toolRun = [];
	};
	for (const message of messages) {
		// Submitted built-ins are display-only, not provider turns or tool-run boundaries.
		if (message.submittedCommand) continue;
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
	const last = context[context.length - 1];
	// Scan from the newest transcript row for the first message that maps to
	// a provider-context row (error rows, info rows and reasoning-only
	// assistant rows never reach the context).
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.submittedCommand) continue;
		if (message.kind === 'info' || message.kind === 'warning') continue;
		if (message.error) continue;
		if (message.role === 'assistant' && !message.content?.trim()) continue;
		if (!last) return false;
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

export function deleteSession(id: string): void {
	deleteTranscriptArchive(id);
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
