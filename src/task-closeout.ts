import {SILENT_CHECKLIST_GUIDANCE} from './plain-response';

export const TASK_CLOSEOUT_PROMPT =
	'You still have unfinished checklist items. Reconcile actual task state with write_tasks only if it needs updating; mark only genuinely finished items completed. ' +
	'Keep blocked or incomplete work in_progress/pending. Do not repeat an unchanged checklist. ' +
	SILENT_CHECKLIST_GUIDANCE;

/** A reconciled checklist may honestly remain unfinished; do not demand another update. */
export function shouldNudgeTaskCloseout(
	unfinishedCount: number,
	nudgeCount: number,
	taskToolRanAfterDraft: boolean,
): boolean {
	return (
		unfinishedCount > 0 &&
		nudgeCount < 2 &&
		!(nudgeCount > 0 && taskToolRanAfterDraft)
	);
}

/** A post-task reply is new history even when its text repeats an earlier draft. */
export function shouldPersistTaskCloseoutReply(
	visibleReply: string,
	lastDraft: string,
	taskToolRanAfterDraft: boolean,
): boolean {
	return taskToolRanAfterDraft || visibleReply !== lastDraft;
}
