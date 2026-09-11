import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {createSignal} from 'solid-js';
import {History} from './components/history';
import {setTasks, type ChatMessage} from './state';

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
