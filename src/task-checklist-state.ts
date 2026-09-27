import {activeAgentRuns, setActiveAgentRuns, setTasks, tasks} from './state';
import type {SessionTask} from './state';
import type {ToolContext} from './tools';

function checklistAgent(ctx: ToolContext) {
	const run = activeAgentRuns().find(row => row.id === ctx.agentId);
	if (!run) throw new Error(`Agent ${ctx.agentId} not found.`);
	if (
		ctx.agentGeneration !== undefined &&
		run.generation !== ctx.agentGeneration
	) {
		throw new Error(`Agent ${ctx.agentId} attempt is no longer current.`);
	}
	return run;
}

export function contextTasks(ctx: ToolContext): SessionTask[] {
	return ctx.agentId === undefined
		? tasks()
		: (checklistAgent(ctx).tasks ?? []);
}

export function setContextTasks(
	ctx: ToolContext,
	next: SessionTask[] | ((previous: SessionTask[]) => SessionTask[]),
	title?: string,
): void {
	if (ctx.agentId === undefined) {
		setTasks(next);
	} else {
		const run = checklistAgent(ctx);
		const updated = typeof next === 'function' ? next(run.tasks ?? []) : next;
		setActiveAgentRuns(previous =>
			previous.map(row =>
				row.id === run.id
					? {
							...row,
							tasks: updated,
							...(title !== undefined ? {tasksTitle: title} : {}),
						}
					: row,
			),
		);
	}
	ctx.onStateChange?.();
}
