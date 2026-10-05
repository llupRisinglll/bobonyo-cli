import type {PendingWorkItem} from './background-notification';

/** Delivery and final-response continuation must agree on turn ownership. */
export function canDeliverQueuedSteering(state: {
	taskTurn: boolean;
	detachedWorkStarted: boolean;
	aborted: boolean;
}): boolean {
	return !state.taskTurn && !state.detachedWorkStarted && !state.aborted;
}

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

/** Explicit chat outranks a stale autonomous/task final response. */
export function queuedSteeringSupersedesSystemTurn(
	systemTurn: boolean,
	queue: PendingWorkItem[],
): boolean {
	return systemTurn && steeringSnapshot(queue).length > 0;
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
