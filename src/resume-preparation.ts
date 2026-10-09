import {healResumedContext, type SessionData} from './session';
import {capDisplayMessages, type ChatMessage} from './state';
import {isTaskNotification} from './background-notification';

/** Restore prompt recall: typed commands, non-error users, newest 100. */
export function promptHistoryFromMessages(messages: ChatMessage[]): string[] {
	const history: string[] = [];
	for (const message of messages) {
		if (message.role !== 'user' || message.error) continue;
		const prompt = message.command?.original ?? message.content ?? '';
		if (!prompt || history.at(-1) === prompt) continue;
		history.push(prompt);
	}
	return history.slice(-100);
}

/** Run transcript-wide work in the reader worker, not in the renderer. */
export function prepareResume(session: SessionData, maxMessages: number) {
	return {
		session,
		display: capDisplayMessages(
			session.messages.filter(message => !isTaskNotification(message.content)),
		),
		context: session.graphContexts
			? session.context
			: healResumedContext(
					session.context,
					session.messages.filter(
						message =>
							message.steeringStatus !== 'accepted' &&
							message.steeringStatus !== 'discarded',
					),
					maxMessages,
				),
		promptHistory: promptHistoryFromMessages(session.messages),
		taskMessage: session.messages.findLast(
			message => message.tool?.name === 'write_tasks',
		),
	};
}
export type PreparedResume = ReturnType<typeof prepareResume>;
