import {afterEach, expect, test} from 'bun:test';
import {formatTaskStatusText, formatToolEntry} from './tool-display';
import {latestSettledTaskMessages, renderToolRun} from './components/history';
import type {ChatMessage} from './state';
import {setTasks} from './state';

afterEach(() => setTasks([]));

function taskTool(
	title = 'Implement durable memory',
	compactTask = false,
	status: 'running' | 'done' = 'running',
): string {
	return formatToolEntry(
		{
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			args: {title},
			compactTask,
		},
		false,
		status,
	);
}

function savedTaskTool(
	tasks: Array<Record<string, unknown>>,
	title = 'Finish implementation',
): string {
	return formatToolEntry(
		{
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			args: {title, tasks},
		},
		false,
		'done',
	);
}

test('task rows render explicit list title and task titles', () => {
	setTasks([
		{id: '1', title: 'Check production build status', status: 'completed'},
		{
			id: '2',
			title: 'Deploy release',
			activeForm: 'Deploying release',
			status: 'in_progress',
		},
	]);
	const rendered = taskTool('Review memory implementation');
	expect(rendered).toContain('```taskrow:running');
	expect(rendered).toContain(
		'Review memory implementation (1 done, 1 in progress, 0 open)',
	);
	expect(rendered).toContain('◆ Check production build status');
	expect(rendered).toContain('› Deploying release');
});

test('task progress uses human-readable status text, not tool chrome', () => {
	const tool = {
		name: 'write_tasks',
		detail: '',
		output: 'Tasks updated.',
		args: {title: 'Run full verification gates'},
	};
	expect(formatTaskStatusText(tool, 'running')).toBe(
		'Working on: Run full verification gates',
	);
	expect(formatTaskStatusText(tool, 'done')).toBe(
		'Finished working on: Run full verification gates',
	);
	expect(formatToolEntry(tool, false, 'done')).toContain('```taskrow:done');
});

test('task lifecycle output preserves task_update status', () => {
	const tool = {
		name: 'task_update',
		detail: '',
		output: 'task_1 · in_progress · Verify the build',
		args: {task_id: 'task_1'},
	};
	expect(formatTaskStatusText(tool, 'done')).toBe(
		'Working on: Verify the build',
	);
});

test('task row does not derive list title from pre-tool text', () => {
	setTasks([{id: '1', title: 'Inspect code', status: 'pending'}]);
	const rendered = taskTool('Inspect implementation');
	expect(rendered).toContain('✦ Inspect implementation');
	expect(rendered).toContain('· Inspect code');
});

test('superseded task snapshot collapses to title plus summary', () => {
	const rendered = formatToolEntry(
		{
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			compactTask: true,
			args: {
				title: 'Review completed work',
				tasks: [{id: '1', title: 'Inspect code', status: 'completed'}],
			},
		},
		false,
		'done',
	);
	expect(rendered).toContain(
		'Review completed work (1 done, 0 in progress, 0 open)',
	);
	expect(rendered).not.toContain('◆ Inspect code');
});

test('superseded task snapshot without pre-tool text is hidden', () => {
	const oldSnapshot: ChatMessage = {
		role: 'tool',
		content: 'Tasks updated.',
		toolId: 'tasks-old',
		tool: {
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			args: {
				tasks: [{id: '1', title: 'Inspect code', status: 'completed'}],
			},
		},
	};
	expect(renderToolRun([oldSnapshot], 80, new Map(), new Set())).toEqual([]);
});

test('legacy settled task snapshots without saved args do not read unrelated current tasks', () => {
	setTasks([{id: 'new', title: 'New unrelated task', status: 'in_progress'}]);
	const rendered = formatToolEntry(
		{name: 'write_tasks', detail: '', output: 'Tasks updated.'},
		false,
		'done',
	);
	expect(rendered).toContain('```taskrow:done');
	expect(rendered).toContain('(0 done, 0 in progress, 0 open)');
	expect(rendered).not.toContain('New unrelated task');
});

test('settled task snapshots with saved args keep their own group', () => {
	setTasks([{id: 'new', title: 'New unrelated task', status: 'in_progress'}]);
	const rendered = savedTaskTool([
		{id: 'old', title: 'Old completed group', status: 'completed'},
	]);
	expect(rendered).toContain('◆ Old completed group');
	expect(rendered).not.toContain('New unrelated task');
});
test('resumed settled task rows keep the diamond and spacing', () => {
	const row: ChatMessage = {
		role: 'tool',
		content: 'Tasks updated.',
		toolId: 'resumed-task',
		tool: {
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			args: {title: 'Resume task display'},
		},
	};
	const rendered =
		renderToolRun([row], 80, new Map(), new Set([row]))[0]?.text ?? '';
	expect(rendered).toContain('✦ Resume task display');
	expect(rendered).toContain('```taskrow:done');
});

test('an explicitly empty running snapshot never borrows live tasks', () => {
	setTasks([{id: 'other', title: 'Unrelated live work', status: 'pending'}]);
	const rendered = formatToolEntry(
		{
			name: 'write_tasks',
			detail: '',
			output: '',
			args: {title: 'Clear list', tasks: []},
		},
		false,
		'running',
	);
	expect(rendered).toContain('(0 done, 0 in progress, 0 open)');
	expect(rendered).not.toContain('Unrelated live work');
});

test('running updates preserve latest settled snapshot in each user turn', () => {
	const snapshot = (toolId: string, running = false): ChatMessage => ({
		role: 'tool',
		content: '',
		toolId,
		running,
		tool: {name: 'write_tasks', detail: '', output: '', args: {tasks: []}},
	});
	const old = snapshot('old');
	const latest = snapshot('latest');
	const pending = snapshot('pending', true);
	const previousTurn = snapshot('previous-turn');
	expect([
		...latestSettledTaskMessages([
			previousTurn,
			{role: 'user', content: 'Next'},
			old,
			latest,
			pending,
		]),
	]).toEqual([latest, previousTurn]);
});

test('superseded snapshots preserve meaningful narration without task rows', () => {
	const message: ChatMessage = {
		role: 'tool',
		content: '',
		brief: 'Keep deployment blocked until checks pass.',
		tool: {
			name: 'write_tasks',
			detail: '',
			output: '',
			args: {
				title: 'Verify release',
				tasks: [{title: 'Inspect build', status: 'completed'}],
			},
		},
	};
	const rows = renderToolRun([message], 80, new Map(), new Set());
	expect(rows[0]?.brief).toBe(message.brief);
	expect(rows[0]?.text).toContain('Verify release (1 done');
	expect(rows[0]?.text).not.toContain('◆ Inspect build');
});
