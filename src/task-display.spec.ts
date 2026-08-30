import {afterEach, expect, test} from 'bun:test';
import {formatToolEntry} from './tool-display';
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
	expect(rendered).toContain(
		'✦ Review memory implementation (1 done, 1 in progress, 0 open)',
	);
	expect(rendered).toContain('  └ ◆ Check production build status');
	expect(rendered).toContain('    › Deploying release');
	expect(rendered).toContain('Check production build status');
});

test('task row does not derive list title from pre-tool text', () => {
	setTasks([{id: '1', title: 'Inspect code', status: 'pending'}]);
	const rendered = taskTool('Inspect implementation');
	expect(rendered).toContain(
		'✦ Inspect implementation (0 done, 0 in progress, 1 open)',
	);
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
		'✦ Review completed work (1 done, 0 in progress, 0 open)',
	);
	expect(rendered).not.toContain('Update project files');
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
	expect(rendered).toContain(
		'✦ Finish implementation (1 done, 0 in progress, 0 open)',
	);
	expect(rendered).toContain('Old completed group');
	expect(rendered).not.toContain('New unrelated task');
});
