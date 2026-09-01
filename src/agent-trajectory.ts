import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ChatMessage} from './state';

const SECRET_PATTERN = /(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi;

function redact(value: unknown): unknown {
	if (typeof value === 'string') {
		return value
			.replace(SECRET_PATTERN, '$1=[redacted]')
			.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
	}
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [
				key,
				redact(item),
			]),
		);
	}
	return value;
}

function isHerdrForkNotice(message: ChatMessage): boolean {
	return (
		message.kind === 'info' &&
		(/\/herdr:fork\b/i.test(message.content) ||
			/^Forked\s+\S+\s+into Herdr pane\s+\S+\.$/i.test(message.content))
	);
}

/** Interview-submittable, human-readable transcript with tool events. */
export function agentTrajectoryDocument(input: {
	sessionId: string;
	cwd: string;
	messages: ChatMessage[];
}): Record<string, unknown> {
	return {
		format: 'bobonyo-agent-trajectory/v1',
		sessionId: input.sessionId,
		workingDirectory: input.cwd,
		events: input.messages
			.filter(message => !isHerdrForkNotice(message))
			.map((message, index) => ({
				sequence: index + 1,
				role: message.role,
				...(message.content ? {content: redact(message.content)} : {}),
				...(message.reasoning ? {reasoning: redact(message.reasoning)} : {}),
				...(message.durationSec ? {durationSeconds: message.durationSec} : {}),
				...(message.error ? {error: redact(message.error)} : {}),
				...(message.brief ? {preToolBrief: redact(message.brief)} : {}),
				...(message.tool
					? {
							tool: redact({
								name: message.tool.name,
								detail: message.tool.detail,
								arguments: message.tool.args ?? {},
								result: message.tool.output,
							}),
						}
					: {}),
			})),
	};
}

export function writeAgentTrajectory(
	cwd: string,
	sessionId: string,
	messages: ChatMessage[],
): string {
	const file = join(cwd, 'agent-trajectory.json');
	writeFileSync(
		file,
		`${JSON.stringify(agentTrajectoryDocument({sessionId, cwd, messages}), null, 2)}\n`,
	);
	return file;
}
