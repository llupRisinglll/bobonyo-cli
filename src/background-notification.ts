export type PendingWorkSource = 'goal' | 'loop' | 'task';
export type BackgroundOwner = 'user' | 'goal' | 'loop';

export interface PendingWorkItem {
	value: string;
	attachments?: Record<string, string>;
	source?: PendingWorkSource;
	owner?: BackgroundOwner;
}

export interface DetachedCompletion {
	kind: 'bash' | 'agent';
	id: string;
	status: 'completed' | 'failed' | 'cancelled' | 'incomplete';
	output: string;
	owner: BackgroundOwner;
}

export function taskNotificationPrompt(completion: DetachedCompletion): string {
	return (
		`<task_notification>${JSON.stringify({
			taskId: completion.id,
			kind: completion.kind,
			status: completion.status,
			output: completion.output,
		})}</task_notification>\n` +
		'Background work finished. Integrate this result into current work. Do not poll the completed task.'
	);
}

/** User prompts outrank autonomous continuations and task notifications. */
export function enqueueUserWork(
	queue: PendingWorkItem[],
	item: PendingWorkItem,
): PendingWorkItem[] {
	const autonomousIndex = queue.findIndex(candidate => candidate.source);
	return autonomousIndex < 0
		? [...queue, item]
		: [
				...queue.slice(0, autonomousIndex),
				item,
				...queue.slice(autonomousIndex),
			];
}

/** Task notifications are lower priority and deduplicated by exact payload. */
export function enqueueTaskNotification(
	queue: PendingWorkItem[],
	completion: DetachedCompletion,
): PendingWorkItem[] {
	const value = taskNotificationPrompt(completion);
	if (queue.some(item => item.source === 'task' && item.value === value)) {
		return queue;
	}
	return [...queue, {value, source: 'task', owner: completion.owner}];
}

/** Coalesce consecutive task notifications into one model turn. */
export function dequeuePendingWork(queue: PendingWorkItem[]): {
	item?: PendingWorkItem;
	remaining: PendingWorkItem[];
} {
	const first = queue[0];
	if (!first) return {remaining: queue};
	if (first.source !== 'task') {
		return {item: first, remaining: queue.slice(1)};
	}
	let count = 0;
	const taskItems: PendingWorkItem[] = [];
	while (queue[count]?.source === 'task') {
		taskItems.push(queue[count]!);
		count += 1;
	}
	const owner: BackgroundOwner = taskItems.some(item => item.owner === 'goal')
		? 'goal'
		: taskItems.some(item => item.owner === 'loop')
			? 'loop'
			: 'user';
	return {
		item: {
			value: taskItems.map(item => item.value).join('\n\n'),
			source: 'task',
			owner,
		},
		remaining: queue.slice(count),
	};
}
