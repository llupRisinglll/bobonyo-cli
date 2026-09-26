/** Checklist execution belongs to agents, not to the person using the harness. */
export const AGENT_TASK_DESCRIPTION =
	'Only agent-executed work belongs in this checklist. Never add user verification, ' +
	'restart, approval, confirmation, or waiting-for-user items. Request user actions ' +
	'outside the checklist. Keep unfinished agent tests pending until they can run. ' +
	'Update silently without prose announcements or checklist recaps; the UI shows the changes. ' +
	'Do not resubmit an unchanged list. Report actual outcomes, blockers, or next actions instead.';

// Anchored deliberately: mentioning a user in an implementation task is valid.
// This conservative English guard is not a general natural-language classifier.
const USER = '(?:the\\s+)?(?:user|human|end[- ]user|you)';
const USER_ACTION =
	'(?:verif\\w*|validat\\w*|test\\w*|restart\\w*|approv\\w*|confirm\\w*|review\\w*|check\\w*|accept\\w*|input|feedback|sign[- ]?off)';
const USER_WORK = [
	new RegExp(
		`^(?:(?:manual|live)\\s+)?${USER}\\s+(?:(?:must|should|will|needs? to|to|manually)\\s+)*${USER_ACTION}\\b`,
		'i',
	),
	new RegExp(`^(?:ask|request|have|let|prompt|remind)\\s+${USER}\\b`, 'i'),
	new RegExp(
		`^(?:wait(?:ing)?(?:\\s+for)?|await(?:ing)?|obtain|obtaining|get|getting|receive|receiving|secure|securing)\\s+(?:the\\s+)?(?:user|human|your)\\b`,
		'i',
	),
	/^(?:wait(?:ing)?(?:\s+for)?|await(?:ing)?)\s+(?:(?:manual|live)\s+(?:verification|validation|testing)|(?:restart|manual verification|live verification)\s+confirmation|approval|confirmation)\b/i,
	new RegExp(
		`^${USER_ACTION}(?:\\s+\\S+){0,8}\\s+(?:by|from)\\s+${USER}\\b`,
		'i',
	),
	new RegExp(
		`^(?:manual|live)\\s+${USER_ACTION}(?:\\s+\\S+){0,8}\\s+(?:by|from)\\s+${USER}\\b`,
		'i',
	),
];

export function taskOwnershipError(task: {
	title?: unknown;
	activeForm?: unknown;
	owner?: unknown;
}): string | undefined {
	const owner = typeof task.owner === 'string' ? task.owner.trim() : '';
	const userOwner = /^(?:user|human|end[- ]user|you)$/i.test(owner);
	const offending = [task.title, task.activeForm].find(
		value =>
			typeof value === 'string' &&
			USER_WORK.some(pattern => pattern.test(value.trim())),
	);
	if (!userOwner && offending === undefined) return undefined;
	return (
		`Error: checklist tasks must be agent-owned; rejected ${JSON.stringify(offending ?? task.title)}.` +
		' Request user verification, restart, approval, or other user action outside the checklist.' +
		' Keep unfinished agent work (including automated tests) pending; no tasks were changed.'
	);
}
