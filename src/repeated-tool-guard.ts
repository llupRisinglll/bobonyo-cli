export const MAX_REPEATED_TOOL_CALLS = 3;

const BOOKKEEPING_TOOLS = new Set(['write_tasks']);

export interface ToolCallSignatureInput {
	name: string;
	arguments: Record<string, unknown>;
}

export interface RepeatedToolState {
	lastSignature: string | null;
	count: number;
}

export interface RepeatedToolEvaluation {
	state: RepeatedToolState;
	stop: boolean;
}

export const INITIAL_REPEATED_TOOL_STATE: RepeatedToolState = {
	lastSignature: null,
	count: 0,
};

export function toolCallSignature(
	calls: ToolCallSignatureInput[],
): string | null {
	const guardedCalls = calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name));
	if (guardedCalls.length === 0) return null;
	return guardedCalls
		.map(call => `${call.name}:${JSON.stringify(call.arguments)}`)
		.join('|');
}

export function evaluateRepeatedToolCalls(
	calls: ToolCallSignatureInput[],
	state: RepeatedToolState,
): RepeatedToolEvaluation {
	const signature = toolCallSignature(calls);
	if (signature === null) {
		return {state, stop: false};
	}
	if (signature !== state.lastSignature) {
		return {
			state: {lastSignature: signature, count: 1},
			stop: false,
		};
	}
	const count = state.count + 1;
	return {
		state: {lastSignature: signature, count},
		stop: count >= MAX_REPEATED_TOOL_CALLS,
	};
}
