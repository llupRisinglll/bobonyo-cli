/** Legacy nanocoder session import and conversion. */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';
import {displayToolName, toolArgsSummary} from './tools';
import type {ChatMessageLike, MockToolCall} from './client';
import type {ChatMessage} from './state';
import {isTaskNotification} from './background-notification';
import {firstMessagePreview, lastMessagePreview} from './session-previews';
import {healResumedContext} from './session';
import type {SessionData} from './session';

function sessionsDir(): string {
	return join(bobonyoDataDir(), 'sessions');
}

function sessionPath(id: string): string {
	return join(sessionsDir(), `${id}.json`);
}

/** The legacy nanocoder sessions directory. */
export function nanocoderSessionsDir(): string {
	if (process.env.NANOCODER_DATA_DIR) {
		return join(process.env.NANOCODER_DATA_DIR, 'sessions');
	}
	if (process.env.XDG_DATA_HOME) {
		return join(process.env.XDG_DATA_HOME, 'nanocoder', 'sessions');
	}
	return join(homedir(), '.local', 'share', 'nanocoder', 'sessions');
}

/** Migrate legacy sessions. Returns number of sessions migrated. */
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
			if (existsSync(sessionPath(raw.id))) {
				// Repair collapsed conversions; never overwrite newer local sessions.
				try {
					const existing = JSON.parse(
						readFileSync(sessionPath(raw.id), 'utf8'),
					) as {messages?: unknown[]};
					if ((existing.messages?.length ?? 0) >= raw.messages.length) {
						continue;
					}
				} catch {
					continue;
				}
			}
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

export interface NanocoderSessionFile {
	id: string;
	title?: string;
	createdAt?: string;
	lastAccessedAt?: string;
	messages?: Array<{
		role: string;
		content?: string;
		submittedCommand?: boolean;
		tool_call_id?: string;
		toolId?: string;
		tool?: {
			name?: string;
			detail?: string;
			output?: string;
			args?: Record<string, unknown>;
		};
		name?: string;
		tool_calls?: Array<{
			id: string;
			function?: {name: string; arguments: string | Record<string, unknown>};
		}>;
	}>;
	name?: string;
}

/** Convert legacy nanocoder data into bobonyo's session shape. */
export function convertNanocoderSession(
	file: NanocoderSessionFile,
): SessionData | null {
	if (!file || typeof file.id !== 'string') return null;
	const msgs = Array.isArray(file.messages) ? file.messages : [];
	const messages: ChatMessage[] = [];

	for (const message of msgs) {
		if (isTaskNotification(message.content)) continue;
		if (message.role === 'user') {
			const content = message.content ?? '';
			messages.push({
				role: 'user',
				content,
				...(message.submittedCommand !== undefined
					? {submittedCommand: message.submittedCommand}
					: {}),
			});
			continue;
		}
		if (message.role === 'assistant') {
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
				}
			}
			if (message.content) {
				messages.push({role: 'assistant', content: message.content});
			}
			continue;
		}
		if (message.role === 'tool') {
			const content = message.content ?? '';
			// Preserve display-shape tool rows verbatim; flattening loses history.
			if (message.toolId !== undefined || message.tool !== undefined) {
				messages.push({
					role: 'tool',
					content: content || message.tool?.output || '',
					toolId: message.toolId,
					tool: message.tool
						? {
								name: message.tool.name ?? '',
								detail: message.tool.detail ?? '',
								output: message.tool.output ?? '',
								args: message.tool.args ?? {},
							}
						: {
								name: message.name ?? '',
								detail: '',
								output: content,
								args: {},
							},
				});
				continue;
			}
			const name = message.name ?? '';
			const toolId = message.tool_call_id ?? '';
			// OPENAI shape: attach result to matching tool row.
			const existing = messages.find(candidate => candidate.toolId === toolId);
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
		}
	}

	// Rebuild provider context; synthesis prevents orphan tool results.
	const context: ChatMessageLike[] = healResumedContext([], messages);
	return {
		id: file.id,
		name: file.name ?? file.title ?? file.id,
		createdAt: new Date(file.createdAt ?? Date.now()).getTime(),
		updatedAt: new Date(
			file.lastAccessedAt ?? file.createdAt ?? Date.now(),
		).getTime(),
		firstMessage: firstMessagePreview(messages),
		lastMessage: lastMessagePreview(messages),
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
