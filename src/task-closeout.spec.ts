import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {toolCatalog, executeTool} from './tools';
import {tasks, setTasks} from './state';
import {
	TASK_CLOSEOUT_PROMPT,
	shouldNudgeTaskCloseout,
	shouldPersistTaskCloseoutReply,
} from './task-closeout';

test('closeout requests silent reconciliation rather than bookkeeping confirmations', () => {
	expect(TASK_CLOSEOUT_PROMPT).toContain(
		'no prose announcement, confirmation, or task-list recap',
	);
	expect(TASK_CLOSEOUT_PROMPT).toContain(
		'Keep blocked or incomplete work in_progress/pending',
	);
	expect(TASK_CLOSEOUT_PROMPT).toContain(
		'actual outcome, concrete blocker, or next action',
	);
	expect(TASK_CLOSEOUT_PROMPT).toContain(
		'Do not repeat an unchanged checklist',
	);
});
test('task tools request silent updates and do not demand unchanged resubmission', async () => {
	for (const name of ['write_tasks', 'task_create', 'task_update']) {
		expect(
			toolCatalog().find(tool => tool.name === name)?.description,
		).toContain('Update silently');
	}
	const previous = tasks();
	try {
		const arguments_ = {
			title: 'Verification',
			tasks: [{title: 'Run regression tests', status: 'pending'}],
		};
		const result = await executeTool({
			id: 'silent-test',
			name: 'write_tasks',
			arguments: arguments_,
			rawArguments: JSON.stringify(arguments_),
		});
		expect(result.content).toContain('do not resubmit an unchanged list');
		expect(tasks()[0]?.status).toBe('pending');
	} finally {
		setTasks(previous);
	}
});

test('honestly pending work does not trigger another closeout after reconciliation', () => {
	expect(shouldNudgeTaskCloseout(2, 0, false)).toBe(true);
	expect(shouldNudgeTaskCloseout(2, 1, true)).toBe(false);
	expect(shouldNudgeTaskCloseout(2, 1, false)).toBe(true);
	expect(shouldNudgeTaskCloseout(2, 2, false)).toBe(false);
	expect(shouldNudgeTaskCloseout(0, 0, false)).toBe(false);
});
test('inherited tasks do not force an unrelated turn to reconcile old work', () => {
	expect(shouldNudgeTaskCloseout(2, 0, false, false)).toBe(false);
	expect(shouldNudgeTaskCloseout(2, 0, false, true)).toBe(true);
});
test('application scopes closeout to current user work and resets it on queued direction', () => {
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	expect(app).toContain('checklistTouchedThisTurn && !systemTurn');
	const steering = app.slice(
		app.indexOf('// New user direction is not another failed attempt'),
	);
	expect(steering.slice(0, 700)).toContain('checklistTouchedThisTurn = false;');
	expect(steering.slice(0, 700)).toContain(
		'taskToolRanAfterCloseoutDraft = false;',
	);
});

test('repeated text after write_tasks still persists', () => {
	expect(shouldPersistTaskCloseoutReply('Done.', 'Done.', true)).toBe(true);
});

test('duplicate closeout text without an intervening task tool stays deduped', () => {
	expect(shouldPersistTaskCloseoutReply('Done.', 'Done.', false)).toBe(false);
});

test('different closeout text always persists', () => {
	expect(shouldPersistTaskCloseoutReply('Finished.', 'Done.', false)).toBe(
		true,
	);
});
