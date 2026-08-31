import {appendFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';

export interface SubagentLogEvent {
	event: string;
	sessionId?: string;
	agentId?: string;
	agentName?: string;
	status?: string;
	detail?: string;
	data?: Record<string, unknown>;
}

const MAX_TEXT = 2000;

function redact(value: string): string {
	return value
		.replace(
			/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
			'$1=[redacted]',
		)
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function safeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function bounded(value: unknown): unknown {
	if (typeof value === 'string') {
		const safe = redact(value);
		return safe.length > MAX_TEXT ? `${safe.slice(0, MAX_TEXT)}…` : safe;
	}
	if (Array.isArray(value)) return value.slice(0, 20).map(bounded);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.slice(0, 30)
				.map(([key, item]) => [key, bounded(item)]),
		);
	}
	return value;
}

export function subagentLogPath(sessionId: string): string {
	return join(bobonyoDataDir(), 'subagent-logs', `${safeId(sessionId)}.jsonl`);
}

/** Append one diagnostic event. Best-effort: logging never changes behavior. */
export function logSubagentEvent(event: SubagentLogEvent): string | undefined {
	if (!event.sessionId) return undefined;
	try {
		const dir = join(bobonyoDataDir(), 'subagent-logs');
		mkdirSync(dir, {recursive: true});
		const path = subagentLogPath(event.sessionId);
		appendFileSync(
			path,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				...event,
				detail: bounded(event.detail),
				data: bounded(event.data),
			})}\n`,
			'utf8',
		);
		return path;
	} catch {
		return undefined;
	}
}
