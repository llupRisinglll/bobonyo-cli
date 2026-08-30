import {isAbsolute, resolve} from 'node:path';
import type {ChatMessageLike} from './client';
import type {LoopJob, SessionGoal} from './goal-loop';
import type {ActiveAgentRun, ChatMessage, SessionTask} from './state';
import {estimateTokens} from './tokenize';

export const COMPACTION_STATE_PREFIX =
	'[BOBONYO_AUTHORITATIVE_COMPACTION_STATE_V1]';
export const AUTO_COMPACT_SAFETY_BUFFER_TOKENS = 13_000;
export const COMPACTION_FAILURE_LIMIT = 3;
export const COMPACTION_FAILURE_COOLDOWN_MS = 60_000;

export interface CompactionFailureState {
	consecutiveFailures: number;
	cooldownUntil: number;
}

export const INITIAL_COMPACTION_FAILURE_STATE: CompactionFailureState = {
	consecutiveFailures: 0,
	cooldownUntil: 0,
};

export interface CompactionSkillSource {
	name: string;
	source: string;
	body: string;
}

export interface CompactionInvokedSkill {
	name: string;
	source?: string;
	arguments?: string;
	instructions: string;
}

export interface CompactionRecentFile {
	path: string;
	absolutePath: string;
	offset?: number;
	limit?: number;
	content: string;
}

export interface CompactionAgentSnapshot {
	id: string;
	name: string;
	description: string;
	status: ActiveAgentRun['status'];
	retrieved: boolean;
	outputTail: string;
}

export interface CompactionStateSnapshotData {
	version: 1;
	directive: string;
	session: {
		id: string;
		cwd: string;
		workspaceRoot: string;
		transcriptPath: string;
	};
	tasks: SessionTask[];
	goal?: SessionGoal;
	loopJobs: LoopJob[];
	queuedPrompts: Array<{value: string; source?: 'goal' | 'loop'}>;
	agents: CompactionAgentSnapshot[];
	invokedSkills: CompactionInvokedSkill[];
	recentFiles: CompactionRecentFile[];
}

export interface CompactionSnapshotBudgets {
	maxSkills: number;
	maxSkillTokens: number;
	maxTotalSkillTokens: number;
	maxFiles: number;
	maxFileTokens: number;
	maxTotalFileTokens: number;
}

export interface BuildCompactionStateInput {
	sessionId: string;
	cwd: string;
	workspaceRoot: string;
	transcriptPath: string;
	tasks: SessionTask[];
	goal?: SessionGoal;
	loopJobs: LoopJob[];
	queuedPrompts?: Array<{value: string; source?: 'goal' | 'loop'}>;
	agents: ActiveAgentRun[];
	messages: ChatMessage[];
	context: ChatMessageLike[];
	availableSkills: CompactionSkillSource[];
	model: string;
	budgets: CompactionSnapshotBudgets;
}

interface ToolCallRecord {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
}

function parseToolArguments(raw: string): Record<string, unknown> {
	try {
		const value = JSON.parse(raw) as unknown;
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function collectToolCalls(context: ChatMessageLike[]): ToolCallRecord[] {
	const results = new Map<string, string>();
	for (const message of context) {
		if (message.role === 'tool' && message.tool_call_id) {
			results.set(message.tool_call_id, message.content ?? '');
		}
	}
	return context.flatMap(message =>
		(message.tool_calls ?? []).map(call => ({
			id: call.id,
			name: call.name,
			arguments: parseToolArguments(call.arguments),
			result: results.get(call.id),
		})),
	);
}

export function truncateCompactionText(
	text: string,
	maxTokens: number,
	model: string,
): string {
	if (maxTokens <= 0) return '';
	let tokens = estimateTokens(text, model);
	if (tokens <= maxTokens) return text;
	let charBudget = Math.max(
		64,
		Math.floor((text.length * maxTokens) / Math.max(1, tokens)),
	);
	let shortened = '';
	for (;;) {
		const headChars = Math.floor(charBudget * 0.7);
		const tailChars = Math.max(0, charBudget - headChars);
		shortened = `${text.slice(0, headChars)}\n… [truncated for compaction] …\n${
			tailChars > 0 ? text.slice(-tailChars) : ''
		}`;
		tokens = estimateTokens(shortened, model);
		if (tokens <= maxTokens || charBudget <= 64) return shortened;
		charBudget = Math.max(64, Math.floor(charBudget * 0.85));
	}
}

function keepNewestWithinBudget<T>(
	items: T[],
	maxItems: number,
	maxTotalTokens: number,
	text: (item: T) => string,
	model: string,
): T[] {
	const kept: T[] = [];
	let used = 0;
	for (let index = items.length - 1; index >= 0; index--) {
		if (kept.length >= maxItems) break;
		const item = items[index]!;
		const tokens = estimateTokens(text(item), model);
		if (used + tokens > maxTotalTokens) continue;
		kept.unshift(item);
		used += tokens;
	}
	return kept;
}

export function compactionSnapshotBudgets(
	contextWindow: number,
): CompactionSnapshotBudgets {
	const total = Math.max(
		1_000,
		Math.min(30_000, Math.floor(Math.max(1, contextWindow) * 0.2)),
	);
	const fileTotal = Math.floor(total * 0.6);
	const skillTotal = total - fileTotal;
	return {
		maxSkills: 8,
		maxSkillTokens: Math.max(200, Math.min(5_000, skillTotal)),
		maxTotalSkillTokens: skillTotal,
		maxFiles: 5,
		maxFileTokens: Math.max(200, Math.min(5_000, fileTotal)),
		maxTotalFileTokens: fileTotal,
	};
}

export function isCompactionStateSnapshot(
	content: string | undefined,
): boolean {
	return Boolean(content?.startsWith(`${COMPACTION_STATE_PREFIX}\n`));
}

export function parseCompactionStateSnapshot(
	content: string | undefined,
): CompactionStateSnapshotData | undefined {
	if (!isCompactionStateSnapshot(content)) return undefined;
	try {
		const parsed = JSON.parse(
			content!.slice(COMPACTION_STATE_PREFIX.length).trim(),
		) as CompactionStateSnapshotData;
		return parsed.version === 1 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function previousSnapshot(
	context: ChatMessageLike[],
): CompactionStateSnapshotData | undefined {
	for (let index = context.length - 1; index >= 0; index--) {
		const parsed = parseCompactionStateSnapshot(context[index]?.content);
		if (parsed) return parsed;
	}
	return undefined;
}

function invokedSkills(
	input: BuildCompactionStateInput,
): CompactionInvokedSkill[] {
	const previous = previousSnapshot(input.context);
	const available = new Map(
		input.availableSkills.map(skill => [skill.name.toLowerCase(), skill]),
	);
	const byName = new Map<string, CompactionInvokedSkill>();
	for (const skill of previous?.invokedSkills ?? []) {
		byName.set(skill.name.toLowerCase(), skill);
	}
	for (const call of collectToolCalls(input.context)) {
		if (call.name !== 'skill') continue;
		const name = String(call.arguments.name ?? '').trim();
		if (!name) continue;
		const source = available.get(name.toLowerCase());
		const record: CompactionInvokedSkill = {
			name,
			...(source?.source ? {source: source.source} : {}),
			...(String(call.arguments.arguments ?? '').trim()
				? {arguments: String(call.arguments.arguments).trim()}
				: {}),
			instructions: call.result || source?.body || '',
		};
		byName.delete(name.toLowerCase());
		byName.set(name.toLowerCase(), record);
	}
	for (const message of input.messages) {
		if (message.command?.kind !== 'skill') continue;
		const source = available.get(message.command.name.toLowerCase());
		const record: CompactionInvokedSkill = {
			name: message.command.name,
			...(source?.source ? {source: source.source} : {}),
			instructions: message.command.body || source?.body || '',
		};
		byName.delete(message.command.name.toLowerCase());
		byName.set(message.command.name.toLowerCase(), record);
	}
	const bounded = [...byName.values()].map(skill => ({
		...skill,
		instructions: truncateCompactionText(
			skill.instructions,
			input.budgets.maxSkillTokens,
			input.model,
		),
	}));
	return keepNewestWithinBudget(
		bounded,
		input.budgets.maxSkills,
		input.budgets.maxTotalSkillTokens,
		skill => skill.instructions,
		input.model,
	);
}

function recentFiles(input: BuildCompactionStateInput): CompactionRecentFile[] {
	const previous = previousSnapshot(input.context);
	const byPath = new Map<string, CompactionRecentFile>();
	for (const file of previous?.recentFiles ?? []) {
		byPath.set(file.absolutePath, file);
	}
	for (const call of collectToolCalls(input.context)) {
		if (call.name !== 'read_file') continue;
		const path = String(call.arguments.path ?? '').trim();
		if (!path) continue;
		const absolutePath = isAbsolute(path) ? path : resolve(input.cwd, path);
		const content = call.result ?? '';
		const file: CompactionRecentFile = {
			path,
			absolutePath,
			...(Number.isFinite(Number(call.arguments.offset))
				? {offset: Number(call.arguments.offset)}
				: {}),
			...(Number.isFinite(Number(call.arguments.limit))
				? {limit: Number(call.arguments.limit)}
				: {}),
			content: truncateCompactionText(
				content,
				input.budgets.maxFileTokens,
				input.model,
			),
		};
		byPath.delete(absolutePath);
		byPath.set(absolutePath, file);
	}
	return keepNewestWithinBudget(
		[...byPath.values()],
		input.budgets.maxFiles,
		input.budgets.maxTotalFileTokens,
		file => file.content,
		input.model,
	);
}

export function buildCompactionStateSnapshot(
	input: BuildCompactionStateInput,
): string {
	const data: CompactionStateSnapshotData = {
		version: 1,
		directive:
			'This generated state is authoritative. Resume active work directly. Do not recap, ask what to do next, redo completed discovery, or stop merely to report progress. Continue active goal and checklist as if compaction never occurred. Use transcriptPath only when an exact older detail is needed.',
		session: {
			id: input.sessionId,
			cwd: input.cwd,
			workspaceRoot: input.workspaceRoot,
			transcriptPath: input.transcriptPath,
		},
		tasks: structuredClone(input.tasks),
		...(input.goal ? {goal: structuredClone(input.goal)} : {}),
		loopJobs: structuredClone(input.loopJobs),
		queuedPrompts: structuredClone(input.queuedPrompts ?? []),
		agents: input.agents
			.filter(agent => agent.status === 'running' || agent.retrieved !== true)
			.slice(-20)
			.map(agent => ({
				id: agent.id,
				name: agent.name,
				description: agent.description,
				status: agent.status,
				retrieved: agent.retrieved === true,
				outputTail: agent.output.slice(-800),
			})),
		invokedSkills: invokedSkills(input),
		recentFiles: recentFiles(input),
	};
	// Compact JSON keeps every field and exact value while avoiding thousands
	// of whitespace tokens in long-running sessions.
	return `${COMPACTION_STATE_PREFIX}\n${JSON.stringify(data)}`;
}

export function estimateContextTokens(
	messages: ChatMessageLike[],
	model: string,
	overhead = '',
): number {
	let total = estimateTokens(overhead, model);
	for (const message of messages) {
		const calls = (message.tool_calls ?? [])
			.map(call => `${call.id}\n${call.name}\n${call.arguments}`)
			.join('\n');
		total += estimateTokens(
			`${message.role}\n${message.content ?? ''}\n${message.tool_call_id ?? ''}\n${calls}`,
			model,
		);
		total += 4;
		total += (message.images?.length ?? 0) * 1_024;
	}
	return total;
}

export function autoCompactTokenLimit(
	contextWindow: number,
	thresholdPercent: number,
	reserveTokens = AUTO_COMPACT_SAFETY_BUFFER_TOKENS,
): number {
	if (contextWindow <= 0) return Number.POSITIVE_INFINITY;
	const threshold = Math.max(1, Math.min(99, thresholdPercent));
	const percentageLimit = Math.floor((contextWindow * threshold) / 100);
	const reserve = Math.min(
		reserveTokens,
		Math.max(2_048, Math.floor(contextWindow * 0.2)),
	);
	return Math.max(1_024, Math.min(percentageLimit, contextWindow - reserve));
}

export function shouldAutoCompactContext(options: {
	estimatedTokens: number;
	contextWindow: number;
	thresholdPercent: number;
	messageCount: number;
	messageCap: number;
	messageMargin: number;
}): boolean {
	const effectiveMargin = Math.min(
		options.messageMargin,
		Math.max(5, Math.floor(options.messageCap * 0.2)),
	);
	return (
		options.estimatedTokens >=
			autoCompactTokenLimit(options.contextWindow, options.thresholdPercent) ||
		options.messageCount >= options.messageCap - effectiveMargin
	);
}

/** Prevent immediate summary-of-summary churn when compacted base stays large. */
export function autoCompactReentryFloor(
	postCompactTokens: number,
	tokenLimit: number,
): number {
	return postCompactTokens >= tokenLimit
		? postCompactTokens + Math.max(1_024, Math.floor(tokenLimit * 0.02))
		: 0;
}

export function canAttemptAutoCompaction(
	state: CompactionFailureState,
	now = Date.now(),
): boolean {
	return now >= state.cooldownUntil;
}

export function recordCompactionFailure(
	state: CompactionFailureState,
	now = Date.now(),
): CompactionFailureState {
	const consecutiveFailures = state.consecutiveFailures + 1;
	return {
		consecutiveFailures,
		cooldownUntil:
			consecutiveFailures >= COMPACTION_FAILURE_LIMIT
				? now + COMPACTION_FAILURE_COOLDOWN_MS
				: state.cooldownUntil,
	};
}

export function recordCompactionSuccess(): CompactionFailureState {
	return {...INITIAL_COMPACTION_FAILURE_STATE};
}

export function microcompactToolResults(
	messages: ChatMessageLike[],
	model: string,
	maxToolTokens = 2_000,
	keptTokens = 600,
): {messages: ChatMessageLike[]; compactedCount: number} {
	let compactedCount = 0;
	return {
		messages: messages.map(message => {
			if (
				message.role !== 'tool' ||
				estimateTokens(message.content ?? '', model) <= maxToolTokens
			) {
				return message;
			}
			compactedCount += 1;
			return {
				...message,
				content:
					truncateCompactionText(message.content ?? '', keptTokens, model) +
					'\n[Large historical tool result shortened only for summary generation; exact output remains in compaction transcript.]',
			};
		}),
		compactedCount,
	};
}
