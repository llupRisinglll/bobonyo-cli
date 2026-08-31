export type GoalStatus =
	| 'active'
	| 'paused'
	| 'blocked'
	| 'budget-limited'
	| 'iteration-limited'
	| 'complete';

export interface SessionGoal {
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	maxIterations?: number;
	iteration?: number;
	completionPromise?: string;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface LoopJob {
	id: string;
	cronExpression: string;
	prompt: string;
	runOnce: boolean;
	createdAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
}

export interface ParsedLoopSpec {
	cronExpression: string;
	prompt: string;
	runOnce: boolean;
	intervalMs?: number;
}

export type LoopControl = 'clear' | 'stop' | {deleteId: string};

export interface ParsedGoalSpec {
	objective: string;
	tokenBudget?: number;
	maxIterations?: number;
	completionPromise?: string;
}

const DURATION_RE = /^(\d+)(s|m|h|d)$/i;

export function parseDuration(value: string): number | undefined {
	const match = DURATION_RE.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const unit = (match[2] ?? '').toLowerCase();
	const multiplier =
		unit === 's'
			? 1000
			: unit === 'm'
				? 60_000
				: unit === 'h'
					? 3_600_000
					: 86_400_000;
	return amount * multiplier;
}

/**
 * Deterministic subset of Codex `/loop` specs.
 *
 * Supported:
 * - `/loop @after-turn <prompt>`
 * - `/loop @every 5m <prompt>`
 * - `/loop every 5m <prompt>`
 * - `/loop once after 30s <prompt>`
 * - `/loop <prompt>` (defaults to after-turn)
 */
export function parseLoopSpec(spec: string): ParsedLoopSpec | null {
	const input = spec.trim();
	if (!input) return null;
	let match = /^@after-turn\s+([\s\S]+)$/i.exec(input);
	if (match) {
		return {
			cronExpression: '@after-turn',
			prompt: (match[1] ?? '').trim(),
			runOnce: false,
		};
	}
	match = /^(?:@every|every)\s+(\d+[smhd])\s+([\s\S]+)$/i.exec(input);
	if (match) {
		const intervalMs = parseDuration(match[1] ?? '');
		const prompt = (match[2] ?? '').trim();
		if (!intervalMs || !prompt) return null;
		return {
			cronExpression: `@every ${(match[1] ?? '').toLowerCase()}`,
			prompt,
			runOnce: false,
			intervalMs,
		};
	}
	match = /^once\s+(?:after|in)\s+(\d+[smhd])\s+([\s\S]+)$/i.exec(input);
	if (match) {
		const intervalMs = parseDuration(match[1] ?? '');
		const prompt = (match[2] ?? '').trim();
		if (!intervalMs || !prompt) return null;
		return {
			cronExpression: `@every ${(match[1] ?? '').toLowerCase()}`,
			prompt,
			runOnce: true,
			intervalMs,
		};
	}
	return {cronExpression: '@after-turn', prompt: input, runOnce: false};
}

export function parseLoopControl(input: string): LoopControl | undefined {
	const control = input.trim().toLowerCase();
	if (control === 'clear') return 'clear';
	if (control === 'stop') return 'stop';
	const deleteMatch = /^delete\s+(\S+)$/i.exec(input.trim());
	return deleteMatch ? {deleteId: deleteMatch[1] ?? ''} : undefined;
}

export function loopIntervalMs(cronExpression: string): number | undefined {
	const match = /^@every\s+(\d+[smhd])$/i.exec(cronExpression.trim());
	return match ? parseDuration(match[1] ?? '') : undefined;
}

export function newLoopJob(spec: ParsedLoopSpec, now = Date.now()): LoopJob {
	return {
		id: `loop_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
		cronExpression: spec.cronExpression,
		prompt: spec.prompt,
		runOnce: spec.runOnce,
		createdAt: now,
		...(spec.intervalMs ? {nextRunAt: now + spec.intervalMs} : {}),
	};
}

export function formatLoopJob(job: LoopJob): string {
	return `${job.id} · ${job.cronExpression}${job.runOnce ? ' · one-shot' : ''} · ${job.prompt}`;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	return first === last && ['"', "'", '`'].includes(first!)
		? trimmed.slice(1, -1)
		: trimmed;
}

/** Parse durable goal limits. Quote multi-word completion promises. */
export function parseGoalSpec(input: string): ParsedGoalSpec | null {
	let objective = input.trim();
	if (!objective) return null;
	let tokenBudget: number | undefined;
	let maxIterations: number | undefined;
	let completionPromise: string | undefined;
	const consumeNumber = (flag: string): number | undefined => {
		const expression = new RegExp(`(?:^|\\s)${flag}\\s+(\\d+)(?=\\s|$)`, 'i');
		const match = expression.exec(objective);
		if (!match) return undefined;
		objective =
			`${objective.slice(0, match.index)} ${objective.slice(match.index + match[0].length)}`.trim();
		const value = Number(match[1]);
		return Number.isFinite(value) && value > 0 ? value : undefined;
	};
	tokenBudget = consumeNumber('--tokens');
	maxIterations = consumeNumber('--max-iterations');
	const promiseMatch =
		/(?:^|\s)--completion-promise\s+("[^"]*"|'[^']*'|`[^`]*`|\S+)(?=\s|$)/i.exec(
			objective,
		);
	if (promiseMatch) {
		completionPromise = unquote(promiseMatch[1] ?? '').trim() || undefined;
		objective =
			`${objective.slice(0, promiseMatch.index)} ${objective.slice(promiseMatch.index + promiseMatch[0].length)}`.trim();
	}
	objective = objective.replace(/\s+/g, ' ').trim();
	if (!objective) return null;
	return {
		objective,
		...(tokenBudget ? {tokenBudget} : {}),
		...(maxIterations ? {maxIterations} : {}),
		...(completionPromise ? {completionPromise} : {}),
	};
}

export function goalContinuationPrompt(goal: SessionGoal): string {
	const iteration = Math.max(1, goal.iteration || 1);
	const iterationLine = goal.maxIterations
		? `Iteration ${iteration} of ${goal.maxIterations}.\n`
		: `Iteration ${iteration}.\n`;
	const completion = goal.completionPromise
		? `Completion is accepted only when you output exactly <promise>${goal.completionPromise}</promise>. Never emit this promise unless every objective requirement is unequivocally true and verified.`
		: 'When fully complete and verified, end the response with [GOAL_COMPLETE]. Never emit this marker merely to stop the loop.';
	return (
		`Continue working autonomously toward this long-running goal:\n\n${goal.objective}\n\n` +
		iterationLine +
		'Do concrete work with tools and use files, tests, and repository state as source of truth. ' +
		'Do not stop merely to report progress, recap, or ask what to do next. ' +
		`${completion} ` +
		'When external intervention is required, end with [GOAL_BLOCKED].'
	);
}

export function goalStatusFromResponse(
	text: string,
	current: GoalStatus,
	completionPromise?: string,
): GoalStatus {
	if (
		completionPromise
			? text.trim() === `<promise>${completionPromise}</promise>`
			: /\[?GOAL_COMPLETE\]?/i.test(text)
	)
		return 'complete';
	if (/\[?GOAL_BLOCKED\]?/i.test(text)) return 'blocked';
	return current;
}

export function isGoalEnvironmentFailure(text: string): boolean {
	return /(?:process\s+\S+\s+not found|connection refused|econnrefused|failed to connect)/i.test(
		text,
	);
}

export function formatGoal(goal: SessionGoal): string {
	const budget = goal.tokenBudget
		? ` · ${goal.tokensUsed}/${goal.tokenBudget} tokens`
		: goal.tokensUsed > 0
			? ` · ${goal.tokensUsed} tokens`
			: '';
	const iteration = goal.iteration ?? 0;
	const iterations = goal.maxIterations
		? ` · iteration ${iteration}/${goal.maxIterations}`
		: iteration > 0
			? ` · iteration ${iteration}`
			: '';
	const promise = goal.completionPromise
		? `\nCompletion promise: ${goal.completionPromise}`
		: '';
	return `Goal ${goal.status}${budget}${iterations}\nObjective: ${goal.objective}${promise}`;
}
