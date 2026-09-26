import type {ChatMessageLike} from './client';
import {normalizeGoal, type SessionGoal} from './goal-loop';

export const CONTEXT_GOAL_MAX_CHARS = 2400;
const EXECUTION_NOTE =
	'\n\nCarry out this scope, not another proposed plan. Existing safety and approval rules still apply.';

export function contextGoalRequest(focus: string, cwd: string): string {
	return `/goal:this is a new execution request. Return only JSON {"objective":"..."}; do not execute tools in this drafting request.
Current focus (authoritative scope): ${JSON.stringify(focus)}. Directory: ${JSON.stringify(cwd)}.
Resolve "this/these" against the latest relevant findings or list, not the entire conversation. Explicit focus overrides older broad objectives. Preserve every requested item and exact technical distinctions; do not add neighboring work.
Write one action sentence, a short bullet list only if needed to preserve the requested cases, and one measurable done condition. Aim for 120 words plus any explicit list; hard limit ${CONTEXT_GOAL_MAX_CHARS - EXECUTION_NOTE.length} characters. No five-section plan, background narrative, path inventory, generic project rules, or repeated focus/preamble. Do not add CI changes, scenario research, reviews, commits, PRs, or release work unless the current request explicitly targets them. Existing project instructions still apply during execution; do not restate them as additional goals.
Do not repeat completed investigation. Earlier investigation-phase pauses do not block this implementation request; substantive restrictions and an explicitly research-only current focus still apply. A coverage task is done when each named case has meaningful passing coverage, not another proposed test plan. Do not authorize deployment or bypass approvals. If scope is genuinely ambiguous or cannot fit without dropping requested cases, return {"question":"one focused clarification question"}.`;
}

/** Persist the command's execution intent, not just the model's interpretation. */
export function contextGoalObjective(objective: string): string {
	return `${objective}${EXECUTION_NOTE}`;
}

/** Resolve only an unqualified request for all uncovered cases, never a subset. */
export function uncoveredCasesGoal(
	history: ChatMessageLike[],
	focus: string,
): string | undefined {
	if (
		!/^(?:please\s+)?(?:finish|cover|test|implement|work on|complete|address)\s+(?:all(?:\s+of)?\s+)?(?:these|the)\s+uncovered\s+(?:cases|things|items)(?:\s+(?:yet|now))?[.!]?$/i.test(
			focus.trim(),
		)
	)
		return undefined;
	// Only the latest ordinary reply is eligible. An older list could be stale
	// after a correction or completed work; leave those cases to synthesis.
	const latest = [...history]
		.reverse()
		.find(
			message =>
				message.role === 'assistant' &&
				message.content?.trim() &&
				!message.tool_calls?.length,
		);
	if (!latest) return undefined;
	const lines = latest.content.split('\n');
	const headings = lines.flatMap((line, index) =>
		/^(?:#{1,6}\s*)?(?:\*\*)?(?:still\s+)?uncovered\b.*:?(?:\*\*)?\s*$/i.test(
			line.trim(),
		)
			? [index]
			: [],
	);
	if (headings.length !== 1) return undefined;
	const cases: string[] = [];
	for (const line of lines.slice(headings[0]! + 1)) {
		if (!line.trim()) {
			if (cases.length) break;
			else continue;
		}
		const item = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(line);
		if (!item) {
			// Wrapped/nested cases cannot be flattened without interpreting them.
			if (/^\s+\S/.test(line)) return undefined;
			break;
		}
		cases.push(item[1]!.trim());
	}
	if (!cases.length) return undefined;
	return `Add and run tests for these uncovered cases only:\n${cases.map(item => `- ${item}`).join('\n')}\nDone when every listed case has meaningful passing coverage; report any remaining gaps.`;
}

export function parseContextGoal(
	text: string,
): {objective: string} | {question: string} {
	const cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/, '')
		.replace(/\n?```$/, '');
	const value = JSON.parse(cleaned);
	if (!value || typeof value !== 'object')
		throw new Error('Goal generation returned invalid JSON.');
	if (
		typeof value.question === 'string' &&
		value.question.trim() &&
		!value.objective
	)
		return {question: value.question.trim()};
	if (
		typeof value.objective !== 'string' ||
		!value.objective.trim() ||
		value.objective.length > CONTEXT_GOAL_MAX_CHARS - EXECUTION_NOTE.length ||
		value.question
	)
		throw new Error(
			`Goal generation must return one concise, nonempty objective fitting ${CONTEXT_GOAL_MAX_CHARS} characters including execution guidance; no goal started.`,
		);
	return {objective: value.objective.trim()};
}

/** Save the generated objective before scheduling any autonomous execution. */
export async function createContextGoal(options: {
	history: ChatMessageLike[];
	focus: string;
	cwd: string;
	request: (messages: ChatMessageLike[]) => Promise<string>;
	isCurrent: () => boolean;
	save: (goal: SessionGoal) => void;
	start: () => void;
}): Promise<SessionGoal | {question: string}> {
	if (!options.history.some(message => message.content?.trim()))
		throw new Error(
			'No conversation context yet. Investigate or describe the task first.',
		);
	const exactList = uncoveredCasesGoal(options.history, options.focus);
	const result = parseContextGoal(
		exactList
			? JSON.stringify({objective: exactList})
			: await options.request([
					...structuredClone(options.history),
					{
						role: 'user',
						content: contextGoalRequest(options.focus, options.cwd),
					},
				]),
	);
	if (!options.isCurrent())
		throw new Error(
			'Goal generation cancelled or conversation changed; no goal started.',
		);
	if ('question' in result) return result;
	const now = Date.now();
	const goal = normalizeGoal({
		objective: contextGoalObjective(result.objective),
		status: 'active',
		tokensUsed: 0,
		iteration: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
	});
	options.save(goal);
	options.start();
	return goal;
}
