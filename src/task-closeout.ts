/** A post-task reply is new history even when its text repeats an earlier draft. */
export function shouldPersistTaskCloseoutReply(
	visibleReply: string,
	lastDraft: string,
	taskToolRanAfterDraft: boolean,
): boolean {
	return taskToolRanAfterDraft || visibleReply !== lastDraft;
}
