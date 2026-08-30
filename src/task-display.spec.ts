import {afterEach, expect, test} from 'bun:test';
import {formatToolEntry} from './tool-display';
import {renderToolRun} from './components/history';
import type {ChatMessage} from './state';
import {setTasks} from './state';

afterEach(() => setTasks([]));

function taskTool(
	briefTitle?: string,
	compactTask = false,
	status: 'running' | 'done' = 'running',
): string {
	return formatToolEntry(
		{
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			briefTitle,
			compactTask,
		},
		false,
		status,
	);
}

function savedTaskTool(tasks: Array<Record<string, unknown>>): string {
	return formatToolEntry(
		{
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			args: {tasks},
		},
		false,
		'done',
	);
}

test('task rows branch from header and pre-tool text replaces Tasks', () => {
	setTasks([
		{id: '1', title: 'Check production build status', status: 'completed'},
		{
			id: '2',
			title: 'Deploy release',
			activeForm: 'Deploying release',
			status: 'in_progress',
		},
	]);
	const rendered = taskTool('This is a task pretool text');
	expect(rendered).toContain(
		'✦ This is a task pretool text (1 done, 1 in progress, 0 open)',
	);
	expect(rendered).toContain('  └ ◆ Check production build status');
	expect(rendered).toContain('    › Deploying release');
	expect(rendered).not.toContain('✦ Tasks (');
});

test('task pre-tool title is one line and ellipsized after a few words', () => {
	setTasks([{id: '1', title: 'Inspect code', status: 'pending'}]);
	const rendered = taskTool(
		'This is an excessively verbose task pretool explanation that should not flood chat',
	);
	expect(rendered).toContain(
		'✦ This is an excessively verbose task pretool... (',
	);
	expect(rendered).not.toContain('\nexplanation');
});

test('superseded task snapshot collapses to title plus summary', () => {
	const rendered = formatToolEntry(
		{
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			briefTitle: 'Update project files',
			compactTask: true,
			args: {tasks: [{id: '1', title: 'Inspect code', status: 'completed'}]},
		},
		false,
		'done',
	);
	expect(rendered).toContain('✦ Update project files');
	expect(rendered).toContain('  └ Tasks (1 done, 0 in progress, 0 open)');
	expect(rendered).not.toContain('Inspect code');
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
	expect(rendered).toContain('✦ Tasks (0 done, 0 in progress, 0 open)');
	expect(rendered).not.toContain('New unrelated task');
});

test('settled task snapshots with saved args keep their own group', () => {
	setTasks([{id: 'new', title: 'New unrelated task', status: 'in_progress'}]);
	const rendered = savedTaskTool([
		{id: 'old', title: 'Old completed group', status: 'completed'},
	]);
	expect(rendered).toContain('✦ Tasks (1 done, 0 in progress, 0 open)');
	expect(rendered).toContain('Old completed group');
	expect(rendered).not.toContain('New unrelated task');
});
