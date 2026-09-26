import {
	appendFileSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
} from 'node:fs';
import {join} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';
import type {ActiveAgentRun} from './state';

export interface SubagentResult {
	id: string;
	name: string;
	description: string;
	status: ActiveAgentRun['status'];
	output: string;
}

/** Fail explicitly rather than exhausting memory or silently losing reports. */
export const MAX_SUBAGENT_ARCHIVE_READ_BYTES = 64 * 1024 * 1024;

/** Unlike diagnostic tails, completed responses must not be shortened. */
export function subagentResultText(run: ActiveAgentRun): string {
	if (run.status === 'completed' || run.status === 'incomplete') {
		const last = run.history?.at(-1);
		if (last?.role === 'assistant' && !last.tool_calls?.length)
			return last.content;
	}
	return run.output;
}

function archivePath(sessionId: string): string {
	return join(
		bobonyoDataDir(),
		'subagent-results',
		`${encodeURIComponent(sessionId)}.jsonl`,
	);
}

/** Preserve every settled response independently of the twenty-row UI cache. */
export function saveSubagentResult(
	sessionId: string | undefined,
	result: SubagentResult,
): void {
	if (!sessionId) return;
	mkdirSync(join(bobonyoDataDir(), 'subagent-results'), {
		recursive: true,
		mode: 0o700,
	});
	const fd = openSync(
		archivePath(sessionId),
		constants.O_WRONLY |
			constants.O_APPEND |
			constants.O_CREAT |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		fchmodSync(fd, 0o600);
		// Only response fields belong here, never incidental child history or tool arguments.
		const {id, name, description, status, output} = result;
		// A separator also isolates any torn append left by an interrupted process.
		appendFileSync(
			fd,
			`\n${JSON.stringify({id, name, description, status, output})}\n`,
			'utf8',
		);
	} finally {
		closeSync(fd);
	}
}

/** Storage failure must never replace a useful model response with an error. */
export function archiveSubagentResponse(
	sessionId: string | undefined,
	result: SubagentResult,
): string {
	try {
		saveSubagentResult(sessionId, result);
		return result.output;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `${result.output}\n\n[Subagent archive failed: ${detail}. This response is still available in the current result and child history; durable archival was not confirmed.]`;
	}
}

function readText(path: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const size = fstatSync(fd).size;
		if (size > MAX_SUBAGENT_ARCHIVE_READ_BYTES) {
			throw new Error(
				`Saved subagent history exceeds the ${MAX_SUBAGENT_ARCHIVE_READ_BYTES}-byte retrieval limit: ${path}. No records were deleted.`,
			);
		}
		const buffer = Buffer.alloc(size);
		let bytes = 0;
		while (bytes < size) {
			const count = readSync(fd, buffer, bytes, size - bytes, bytes);
			if (!count) break;
			bytes += count;
		}
		return buffer.subarray(0, bytes).toString('utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function validResult(value: unknown): value is SubagentResult {
	if (!value || typeof value !== 'object') return false;
	const row = value as SubagentResult;
	return (
		['completed', 'incomplete', 'error', 'cancelled'].includes(row.status) &&
		['id', 'name', 'description', 'status', 'output'].every(
			key => typeof row[key as keyof SubagentResult] === 'string',
		)
	);
}

/** Session-scoped archive, with legacy saved child histories as a fallback. */
export function loadSubagentResults(
	sessionId: string | undefined,
	runs: ActiveAgentRun[],
	warnings?: string[],
): SubagentResult[] {
	const results: SubagentResult[] = [];
	const readSource = (path: string): string => {
		try {
			return readText(path);
		} catch (error) {
			if (!warnings) throw error;
			warnings.push(
				`Subagent history source unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
			return '';
		}
	};
	if (sessionId) {
		for (const line of readSource(archivePath(sessionId)).split('\n')) {
			try {
				const row: unknown = JSON.parse(line);
				if (validResult(row)) results.push(row);
			} catch {
				// An interrupted final append must not hide earlier responses.
			}
		}
		// Do not import session.ts: it imports the tool registry itself.
		if (/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
			const saved = readSource(
				join(bobonyoDataDir(), 'sessions', `${sessionId}.json`),
			);
			try {
				const session = JSON.parse(saved) as {subagentRuns?: ActiveAgentRun[]};
				if (Array.isArray(session.subagentRuns))
					runs = [...session.subagentRuns, ...runs];
			} catch {
				// Legacy/corrupt session files must not hide the independent archive.
			}
		}
	}
	for (const run of runs) {
		if (!validResult(run) || run.status === 'running') continue;
		results.push({
			id: run.id,
			name: run.name,
			description: run.description,
			status: run.status,
			output: subagentResultText(run),
		});
	}
	const seen = new Set<string>();
	return results.filter(result => {
		const key = JSON.stringify([result.id, result.status, result.output]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Character pagination keeps even one enormous report line retrievable. */
export function formatSubagentResults(
	results: SubagentResult[],
	agentId: string,
	offset = 0,
	limit = 12000,
): string {
	const selected = agentId
		? results.filter(result => result.id === agentId)
		: results;
	if (!selected.length)
		return agentId
			? `Agent ${agentId} has no saved responses.`
			: 'No saved delegated-agent responses.';
	const output = selected
		.map(
			result =>
				`${result.id} · ${result.status} · agent:${result.name}(${result.description})${agentId ? `\n${result.output}` : ''}`,
		)
		.join('\n\n');
	const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
	const size = Number.isFinite(limit)
		? Math.max(1, Math.min(24000, Math.floor(limit)))
		: 12000;
	const end = Math.min(output.length, start + size);
	return `${output.slice(start, end)}${end < output.length ? `\n[More saved responses: call agent_history with offset=${end}${agentId ? ` and agent_id=${agentId}` : ''}.]` : ''}`;
}
