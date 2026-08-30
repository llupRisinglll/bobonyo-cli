import type {ChatMessageLike, MockToolCall} from './client';
import type {ActiveAgentRun, ChatMessage} from './state';
import {toolArgsSummary} from './tools';

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object'
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Project persisted provider-format child history into the same ChatMessage
 * shape consumed by the main History renderer. This keeps tool cards, reply
 * glyphs, indentation, syntax colors, diffs, and future visual changes shared.
 */
export function subagentDisplayMessages(run: ActiveAgentRun): ChatMessage[] {
	const display: ChatMessage[] = [];
	const tools = new Map<string, ChatMessage>();
	let firstUser = true;

	for (const message of run.history) {
		if (message.role === 'user') {
			const content = firstUser ? `Task: ${run.description}` : message.content;
			firstUser = false;
			display.push({role: 'user', content});
			continue;
		}
		if (message.role === 'assistant') {
			if (message.content.trim()) {
				display.push({role: 'assistant', content: message.content});
			}
			for (const call of message.tool_calls ?? []) {
				const args = parseArgs(call.arguments);
				const mock: MockToolCall = {
					id: call.id,
					name: call.name,
					arguments: args,
					rawArguments: call.arguments,
				};
				const row: ChatMessage = {
					role: 'tool',
					content: '',
					toolId: call.id,
					running: run.status === 'running',
					tool: {
						name: call.name,
						detail: toolArgsSummary(mock),
						output: '',
						args,
					},
				};
				tools.set(call.id, row);
				display.push(row);
			}
			continue;
		}
		const row = message.tool_call_id
			? tools.get(message.tool_call_id)
			: undefined;
		if (row?.tool) {
			row.running = false;
			row.content = message.content;
			row.tool.output = message.content;
		} else {
			display.push({role: 'tool', content: message.content});
		}
	}
	return display;
}

export function subagentHistorySource(run: ActiveAgentRun): ChatMessageLike[] {
	return run.history;
}
