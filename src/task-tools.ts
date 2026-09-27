import type {SessionTask, TaskStatus} from './state';
import type {ToolContext} from './tools';
import {AGENT_TASK_DESCRIPTION, taskOwnershipError} from './task-ownership';
import {contextTasks, setContextTasks} from './task-checklist-state';
import {normalizeTaskList} from './task-list-normalize';

interface TaskToolDefinition {
	execute: (args: Record<string, unknown>, ctx: ToolContext) => string;
	readOnly?: boolean;
	description?: string;
	parameters?: Record<string, unknown>;
}

export function registerTaskTools(
	registerTool: (name: string, definition: TaskToolDefinition) => void,
	text: (args: Record<string, unknown>, key: string) => string,
): void {
	function taskText(task: SessionTask): string {
		return `${task.id} · ${task.status} · ${task.title}${task.owner ? ` · owner ${task.owner}` : ''}${task.dependsOn?.length ? ` · depends on ${task.dependsOn.join(', ')}` : ''}`;
	}
	registerTool('write_tasks', {
		description:
			'Create or update the current session task checklist. Use proactively for ' +
			'non-trivial work, tasks with 3 or more steps, multiple user requests, ' +
			'or any change needing implementation plus verification. Skip only ' +
			'purely informational requests and genuinely tiny one-step changes. ' +
			'Every call replaces the full list. Update immediately when work starts ' +
			'or finishes; keep exactly one in_progress item while work remains. ' +
			'Completed items must remain in the list with status completed so the UI ' +
			'can strike them through. Include only work the agent must perform. Never ' +
			'add user-owned actions such as waiting for user input, approval, manual ' +
			'verification, or confirmation. Mention those outside the checklist. Use ' +
			'title as a concise imperative task-list title, task titles as imperative text, and activeForm as present-continuous text. Both titles must be supplied by the model; never derive either from pre-tool narration. ' +
			AGENT_TASK_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				title: {
					type: 'string',
					description: 'Concise title for this task list, shown in the header.',
				},
				tasks: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: {type: 'string'},
							title: {type: 'string', description: AGENT_TASK_DESCRIPTION},
							activeForm: {
								type: 'string',
								description:
									'Present-continuous agent action, never waiting for the user.',
							},
							status: {
								type: 'string',
								enum: ['pending', 'in_progress', 'completed', 'cancelled'],
							},
							dependsOn: {type: 'array', items: {type: 'string'}},
							owner: {
								type: 'string',
								description:
									'Agent identifier only; never the user or a human.',
							},
						},
						required: ['title', 'status'],
					},
				},
			},
			required: ['title', 'tasks'],
		},
		execute(args: Record<string, unknown>, ctx: ToolContext) {
			const next = normalizeTaskList(args.tasks);
			const title = typeof args.title === 'string' ? args.title.trim() : '';
			if (!title) return 'Error: write_tasks requires a non-empty title.';
			if (Array.isArray(args.tasks) && next.length !== args.tasks.length) {
				return 'Error: every task must provide a non-empty title and valid status.';
			}
			for (const task of next) {
				const error = taskOwnershipError(task);
				if (error) return error;
			}
			setContextTasks(ctx, next, title);
			if (next.length === 0) return 'Tasks updated: no tasks.';
			const icons: Record<TaskStatus, string> = {
				pending: '·',
				in_progress: '›',
				completed: '◆',
				cancelled: '×',
			};
			const lines = next.map(
				(task, index) =>
					`${index + 1}. ${icons[task.status]} ${task.title} [${task.status}]`,
			);
			const unfinished = next.filter(
				task => task.status === 'pending' || task.status === 'in_progress',
			).length;
			return (
				`${title} updated (${unfinished} remaining):\n${lines.join('\n')}\n` +
				(unfinished > 0
					? 'Continue available work. Keep blocked items unfinished; do not resubmit an unchanged list or narrate this update.'
					: 'All tasks completed. Report the substantive outcome, not this checklist update.')
			);
		},
	});

	registerTool('task_create', {
		description:
			'Create one task with a stable id, optional agent owner, and dependencies. ' +
			AGENT_TASK_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				title: {type: 'string', description: AGENT_TASK_DESCRIPTION},
				activeForm: {
					type: 'string',
					description:
						'Present-continuous agent action, never waiting for the user.',
				},
				owner: {
					type: 'string',
					description: 'Agent identifier only; never the user or a human.',
				},
				depends_on: {type: 'array', items: {type: 'string'}},
			},
			required: ['title'],
		},
		execute(args: Record<string, unknown>, ctx: ToolContext) {
			const id = `task_${Date.now().toString(36)}_${contextTasks(ctx).length + 1}`;
			const task: SessionTask = {
				id,
				title: text(args, 'title'),
				activeForm: text(args, 'activeForm') || undefined,
				owner: text(args, 'owner') || undefined,
				dependsOn: Array.isArray(args.depends_on)
					? args.depends_on.map(String)
					: undefined,
				status: 'pending',
			};
			const error = taskOwnershipError(task);
			if (error) return error;
			setContextTasks(ctx, prev => [...prev, task]);
			return taskText(task);
		},
	});
	registerTool('task_list', {
		description: 'List all tasks with ids, status, owners, and dependencies.',
		parameters: {type: 'object', properties: {}},
		readOnly: true,
		execute(_args: Record<string, unknown>, ctx: ToolContext) {
			const current = contextTasks(ctx);
			return current.length ? current.map(taskText).join('\n') : 'No tasks.';
		},
	});
	registerTool('task_get', {
		description: 'Get one task by stable id.',
		parameters: {
			type: 'object',
			properties: {task_id: {type: 'string'}},
			required: ['task_id'],
		},
		readOnly: true,
		execute(args: Record<string, unknown>, ctx: ToolContext) {
			const task = contextTasks(ctx).find(
				row => row.id === text(args, 'task_id'),
			);
			return task
				? taskText(task)
				: `Error: task ${text(args, 'task_id')} not found.`;
		},
	});
	registerTool('task_update', {
		description:
			'Update one task by id. A task cannot start until all dependencies are completed. ' +
			AGENT_TASK_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				task_id: {type: 'string'},
				title: {type: 'string', description: AGENT_TASK_DESCRIPTION},
				activeForm: {
					type: 'string',
					description:
						'Present-continuous agent action, never waiting for the user.',
				},
				status: {
					type: 'string',
					enum: ['pending', 'in_progress', 'completed', 'cancelled'],
				},
				owner: {
					type: 'string',
					description: 'Agent identifier only; never the user or a human.',
				},
				depends_on: {type: 'array', items: {type: 'string'}},
			},
			required: ['task_id'],
		},
		execute(args: Record<string, unknown>, ctx: ToolContext) {
			const id = text(args, 'task_id');
			const current = contextTasks(ctx).find(task => task.id === id);
			if (!current) return `Error: task ${id} not found.`;
			const status = text(args, 'status') as TaskStatus;
			if (status === 'in_progress') {
				const blocked = (current.dependsOn ?? []).filter(
					dep =>
						contextTasks(ctx).find(task => task.id === dep)?.status !==
						'completed',
				);
				if (blocked.length)
					return `Error: task ${id} is blocked by ${blocked.join(', ')}.`;
			}
			const updated: SessionTask = {
				...current,
				...(text(args, 'title') ? {title: text(args, 'title')} : {}),
				...(text(args, 'activeForm')
					? {activeForm: text(args, 'activeForm')}
					: {}),
				...(status ? {status} : {}),
				...(text(args, 'owner') ? {owner: text(args, 'owner')} : {}),
				...(Array.isArray(args.depends_on)
					? {dependsOn: args.depends_on.map(String)}
					: {}),
			};
			const error = taskOwnershipError(updated);
			if (error) return error;
			setContextTasks(ctx, prev =>
				prev.map(task =>
					task.id === id
						? updated
						: status === 'in_progress' && task.status === 'in_progress'
							? {...task, status: 'pending'}
							: task,
				),
			);
			return taskText(updated);
		},
	});
}
