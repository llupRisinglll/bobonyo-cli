import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {createSignal} from 'solid-js';
import {History} from './components/history';
import {setActiveAgentRuns, setTasks, type ChatMessage} from './state';

function snapshot(id: string, title: string, brief?: string): ChatMessage {
	return {
		role: 'tool',
		content: 'Tasks updated.',
		toolId: id,
		brief,
		tool: {
			name: 'write_tasks',
			detail: '',
			output: 'Tasks updated.',
			args: {
				title: 'Release checklist',
				tasks: [
					{id: 'done', title, status: 'completed'},
					{
						id: 'active',
						title: 'Run checks',
						activeForm: 'Running checks',
						status: 'in_progress',
					},
					{id: 'pending', title: 'Publish release', status: 'pending'},
				],
			},
		},
	};
}

function taskProgressSnapshot(
	name: 'task_update' | 'task_list',
	id: string,
	tasks: NonNullable<ChatMessage['tool']>['args'] extends never
		? never
		: Array<{
				id: string;
				title: string;
				activeForm?: string;
				status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
			}>,
): ChatMessage {
	return {
		role: 'tool',
		content: 'Task state updated.',
		toolId: id,
		tool: {
			name,
			detail: '',
			output: tasks
				.map(task => `${task.id} · ${task.status} · ${task.title}`)
				.join('\n'),
			args: {title: 'Finish Finance PR disposition', tasks},
		},
	};
}

test('History renders saved task rows and keeps them while replacement runs', async () => {
	const stale = snapshot('stale', 'Superseded task');
	const narrated = snapshot(
		'narrated',
		'Earlier task',
		'Keep deployment blocked until checks pass.',
	);
	const settled = snapshot('settled', 'Build completed');
	const [messages, setMessages] = createSignal<ChatMessage[]>([
		stale,
		narrated,
		settled,
	]);
	setTasks([
		{id: 'unrelated', title: 'Unrelated live task', status: 'pending'},
	]);
	const setup = await testRender(
		() => (
			<History
				embedded
				width={100}
				height={30}
				messages={messages}
				running={() => true}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 100, height: 30},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	// Markdown's worker starts asynchronously; flush alone does not await it.
	const waitForText = async (expected: string) => {
		const deadline = Date.now() + 4000;
		do {
			await setup.flush();
			if (text().includes(expected)) return;
			await Bun.sleep(25);
		} while (Date.now() < deadline);
		expect(text()).toContain(expected);
	};
	try {
		await waitForText('Keep deployment blocked until checks pass.');
		expect(text()).toContain('Build completed');
		expect(text()).toContain('Running checks');
		expect(text()).toContain('Publish release');
		expect(text()).toContain('Keep deployment blocked until checks pass.');
		expect(text()).not.toContain('Superseded task');
		expect(text()).not.toContain('Earlier task');
		expect(text()).not.toContain('Unrelated live task');

		const next = {...snapshot('next', 'Replacement completed'), running: true};
		setMessages([stale, narrated, settled, next]);
		await setup.flush();
		expect(text()).toContain('Build completed');
		expect(text()).toContain('Publish release');

		setMessages([stale, narrated, settled, {...next, running: false}]);
		await waitForText('Replacement completed');
		expect(text()).toContain('Replacement completed');
		expect(text()).not.toContain('Build completed');
	} finally {
		setup.renderer.destroy();
		setTasks([]);
	}
});

test('later task updates keep the rich checklist instead of generic TaskList output', async () => {
	const initial = snapshot('initial-tasks', 'Inspect current status');
	initial.tool!.args = {
		title: 'Finish Finance PR disposition',
		tasks: [
			{id: 'inspect', title: 'Inspect current status', status: 'in_progress'},
			{
				id: 'review',
				title: 'Review exact checkpoint-isolation test change',
				status: 'pending',
			},
			{
				id: 'merge',
				title: 'Merge checkpoint-isolation PR if exact-snapshot review passes',
				status: 'pending',
			},
			{
				id: 'verify',
				title: 'Confirm Finance PR states and checks',
				status: 'pending',
			},
		],
	};
	const updatedTasks = [
		{
			id: 'inspect',
			title: 'Inspect current status',
			status: 'completed' as const,
		},
		{
			id: 'review',
			title: 'Review exact checkpoint-isolation test change',
			activeForm: 'Reviewing exact checkpoint-isolation test change',
			status: 'in_progress' as const,
		},
		{
			id: 'merge',
			title: 'Merge checkpoint-isolation PR if exact-snapshot review passes',
			status: 'pending' as const,
		},
		{
			id: 'verify',
			title: 'Confirm Finance PR states and checks',
			status: 'pending' as const,
		},
	];
	const update = taskProgressSnapshot(
		'task_update',
		'update-task',
		updatedTasks,
	);
	const listed = taskProgressSnapshot('task_list', 'list-tasks', updatedTasks);
	const [messages] = createSignal<ChatMessage[]>([initial, update, listed]);
	const setup = await testRender(
		() => (
			<History
				embedded
				width={120}
				height={20}
				messages={messages}
				running={() => false}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 120, height: 20},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	try {
		const deadline = Date.now() + 4000;
		do {
			await setup.flush();
			if (text().includes('Reviewing exact checkpoint-isolation test change'))
				break;
			await Bun.sleep(25);
		} while (Date.now() < deadline);
		expect(text()).toContain('Finish Finance PR disposition');
		expect(text()).toContain('(1 done, 1 in progress, 2 open)');
		expect(text()).toContain('◆ Inspect current status');
		expect(text()).toContain(
			'› Reviewing exact checkpoint-isolation test change',
		);
		expect(text()).toContain('· Confirm Finance PR states and checks');
		expect(text()).not.toContain('TaskList');
		expect(text()).not.toContain('· in_progress ·');
		expect(text()).not.toContain('more lines');
	} finally {
		setup.renderer.destroy();
	}
});

test('History renders finished-agent summary inside chat history', async () => {
	setActiveAgentRuns([
		{
			id: 'review-api',
			name: 'review-api',
			description: 'Review API changes',
			output: 'REVIEW_PASSED',
			transcript: [],
			streaming: '',
			history: [],
			status: 'completed',
			finishedAt: Date.now(),
		},
		{
			id: 'review-db',
			name: 'review-db',
			description: 'Review DB changes',
			output: '',
			transcript: [],
			streaming: '',
			history: [],
			status: 'running',
		},
	]);
	const setup = await testRender(
		() => (
			<History
				embedded
				width={100}
				height={20}
				messages={createSignal<ChatMessage[]>([])[0]}
				running={() => true}
				reasoning={() => ''}
				streaming={() => ''}
				liveOutputs={() => ({})}
			/>
		),
		{width: 100, height: 20},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	try {
		const deadline = Date.now() + 4000;
		do {
			await setup.flush();
			if (text().includes('✦ Agent Finished')) break;
			await Bun.sleep(25);
		} while (Date.now() < deadline);
		expect(text()).toContain('✦  Agent Finished');
		expect(text()).toContain(
			'review-api - result passed waiting for 1 more agents',
		);
	} finally {
		setup.renderer.destroy();
		setActiveAgentRuns([]);
	}
});
