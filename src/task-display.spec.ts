import {afterEach, expect, test} from 'bun:test';
import {formatTaskStatusText, formatToolEntry} from './tool-display';
import {renderToolRun} from './components/history';
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
	expect(rendered).toBe('Working on: Review memory implementation');
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
	expect(formatToolEntry(tool, false, 'done')).toBe(
		'Finished working on: Run full verification gates',
	);
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
	expect(rendered).toBe('Working on: Inspect implementation');
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
	expect(rendered).toBe('Finished working on: Review completed work');
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
	expect(renderToolRun([oldSnapshot], 80, new Map())).toEqual([]);
});

test('legacy settled task snapshots without saved args do not read unrelated current tasks', () => {
	setTasks([{id: 'new', title: 'New unrelated task', status: 'in_progress'}]);
	const rendered = formatToolEntry(
		{name: 'write_tasks', detail: '', output: 'Tasks updated.'},
		false,
		'done',
	);
	expect(rendered).toBe('Finished working on: task checklist');
	expect(rendered).not.toContain('New unrelated task');
});

test('settled task snapshots with saved args keep their own group', () => {
	setTasks([{id: 'new', title: 'New unrelated task', status: 'in_progress'}]);
	const rendered = savedTaskTool([
		{id: 'old', title: 'Old completed group', status: 'completed'},
	]);
	expect(rendered).toBe('Finished working on: Finish implementation');
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
	expect(rendered).toContain('Finished working on: Resume task display');
	expect(rendered).not.toContain('✦  Finished');
	expect(rendered).toContain('```inforow:done');
});
