/** Accepted user input is durable independently of autonomous scheduling. */
export interface SteeringMessage {
	id: string;
	value: string;
	attachments?: Record<string, string>;
	/** Admission identity. Resume transfers retained input to the new generation. */
	owner?: {sessionId: string; generation: number; turnId: number};
	/** Retry the existing provider history, never replay its completed tool calls. */
	reuseContext?: boolean;
}

/** Identity, not text equality, acknowledges a single accepted submission. */
export function acknowledgeSteering(
	inbox: SteeringMessage[],
	id: string,
): SteeringMessage[] {
	return inbox.filter(item => item.id !== id);
}

/** Snapshot a boundary; arrivals during preparation belong to the next boundary. */
export async function deliverSteering(
	inbox: readonly SteeringMessage[],
	deliver: (item: SteeringMessage) => Promise<boolean>,
	acknowledge: (id: string) => void,
): Promise<void> {
	for (const item of [...inbox]) {
		if (!(await deliver(item))) break;
		acknowledge(item.id);
	}
}
