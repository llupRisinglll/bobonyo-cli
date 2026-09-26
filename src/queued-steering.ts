import type {PendingWorkItem} from './background-notification';

/** Only ordinary chat may join an active turn; commands and events keep their dispatcher. */
export function steeringSnapshot(queue: PendingWorkItem[]): PendingWorkItem[] {
	const boundary = queue.findIndex(
		item =>
			item.delivery === 'after-current' ||
			item.source ||
			item.command ||
			/^[!/]/.test(item.value.trim()),
	);
	return queue.slice(0, boundary < 0 ? queue.length : boundary);
}

/** Snapshot once, deliver serially, and acknowledge only completed deliveries. */
export async function deliverQueuedSteering(
	queue: PendingWorkItem[],
	deliver: (item: PendingWorkItem) => Promise<boolean>,
	acknowledge: (item: PendingWorkItem) => void,
): Promise<void> {
	for (const item of steeringSnapshot(queue)) {
		if (!(await deliver(item))) break;
		acknowledge(item);
	}
}
