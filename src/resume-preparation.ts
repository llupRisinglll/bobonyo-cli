import {healResumedContext, type SessionData} from './session';
import {
	capDisplayMessages,
	identifyTranscriptRows,
	type ChatMessage,
} from './state';
import {
	appendTranscriptRows,
	importLegacyCompactionTranscript,
} from './transcript-archive';
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
	// Legacy sessions lack display identities. Stable positions distinguish even
	// identical adjacent rows and repeated worker loads reuse the same archive IDs.
	for (const [index, message] of session.messages.entries())
		message.transcriptId ??= `legacy:${session.id}:${index}`;
	const original = identifyTranscriptRows(
		session.messages.filter(message => !isTaskNotification(message.content)),
	);
	let display = capDisplayMessages(original);
	let archiveError = '';
	const outgoing = original.filter(message => !display.includes(message));
	if (outgoing.some(message => message.running)) display = original;
	else if (outgoing.length) {
		try {
			const legacy = importLegacyCompactionTranscript(
				session.id,
				1024 * 1024,
				original,
			);
			if (legacy.status === 'too-large')
				throw new Error(
					'Legacy transcript exceeds the 1 MiB recovery limit; source snapshot retained without parsing',
				);
			appendTranscriptRows(session.id, outgoing);
		} catch (error) {
			display = original;
			archiveError = `Transcript archive failed; earlier rows retained: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const context = session.graphContexts
		? session.context
		: healResumedContext(
				session.context,
				session.messages.filter(
					message =>
						message.steeringStatus !== 'accepted' &&
						message.steeringStatus !== 'discarded',
				),
				maxMessages,
			);
	const promptHistory = promptHistoryFromMessages(session.messages);
	const taskMessage = session.messages.findLast(
		message => message.tool?.name === 'write_tasks',
	);
	return {
		session: {...session, messages: display},
		display,
		archiveError,
		context,
		promptHistory,
		taskMessage,
	};
}
export type PreparedResume = ReturnType<typeof prepareResume>;
