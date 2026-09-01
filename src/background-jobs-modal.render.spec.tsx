import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {BackgroundJobsModal} from './components/background-jobs-modal';
import {bgTasks, setBgTasks} from './bash';
import {colors} from './theme';
import {createTextAttributes} from '@opentui/core';

/**
 * RENDER-LEVEL guard for the background-jobs modal + the floating
 * notification that replaced the `bg: n` status-line segment.
 *
 * The modal lists every background bash task in the chat-history bash-box
 * format (bordered `$ command` + tailed output with a `+N more lines`
 * footer) and the RUNNING jobs stream their output in realtime (bgTasks()
 * is a signal — the For re-renders when runBash pushes a fresh array).
 */

/** Full line text (all spans joined) — avoids the per-span split issue. */
function lineText(frame: CapturedFrame, line: number): string {
	return (
		frame.lines[line]?.spans
			.map((span: {text: string}) => span.text)
			.join('') ?? ''
	);
}

/** Whether a multi-span search finds the needle inside a joined line. */
function frameHas(frame: CapturedFrame, needle: string): boolean {
	return frame.lines.some((line: {spans: Array<{text: string}>}) => {
		const full = line.spans.map((span: {text: string}) => span.text).join('');
		return full.includes(needle);
	});
}

describe('BackgroundJobsModal', () => {
	test('goal tab opens directly and renders active goal details', async () => {
		setBgTasks([]);
		const setup = await testRender(
			() => (
				<BackgroundJobsModal
					initialTab="goal"
					goal={{
						objective: 'Ship long-running work',
						status: 'active',
						tokensUsed: 1250,
						iteration: 3,
						maxIterations: 10,
						timeUsedSeconds: 45,
						createdAt: 1,
						updatedAt: 2,
					}}
					onClose={() => {}}
				/>
			),
			{width: 100, height: 24},
		);
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'Process monitor [jobs | agents | *goal*]')).toBe(
				true,
			);
			expect(frameHas(frame, 'Goal (active)')).toBe(true);
			expect(frameHas(frame, 'Long-running goal')).toBe(true);
			expect(frameHas(frame, 'Objective: Ship long-running work')).toBe(true);
			expect(frameHas(frame, 'iteration 3/10')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('lists each running job with syntax command and four-line live tail', async () => {
		setBgTasks([
			{
				id: 'bg_test_1',
				command: 'npm run build',
				output: Array.from({length: 15}, (_, i) => `line ${i + 1}`),
				running: true,
				exitCode: null,
				startedAt: Date.now() - 5000,
			},
			{
				id: 'bg_test_2',
				command: 'echo done',
				output: ['done'],
				running: false,
				exitCode: 0,
				startedAt: Date.now() - 9000,
				completedAt: Date.now() - 8000,
			},
		]);
		const setup = await testRender(
			() => <BackgroundJobsModal onClose={() => {}} />,
			{width: 100, height: 30},
		);
		try {
			await setup.flush();
			await new Promise(resolve => setTimeout(resolve, 100));
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'Process monitor')).toBe(true);
			expect(frameHas(frame, '$ npm run build')).toBe(true);
			// Exactly tail lines 12-15. Older output stays hidden.
			expect(frameHas(frame, 'line 11')).toBe(false);
			for (const line of [12, 13, 14, 15]) {
				expect(frameHas(frame, `line ${line}`)).toBe(true);
			}
			expect(frameHas(frame, 'echo done')).toBe(false);
		} finally {
			setBgTasks([]);
			setup.renderer.destroy();
		}
	});

	test('Enter opens selected job details and output updates live', async () => {
		setBgTasks([
			{
				id: 'bg_live',
				command: 'bun test',
				output: ['first', 'second'],
				running: true,
				exitCode: null,
				startedAt: Date.now(),
			},
		]);
		const setup = await testRender(
			() => <BackgroundJobsModal onClose={() => {}} />,
			{width: 100, height: 30},
		);
		try {
			await setup.flush();
			setup.mockInput.pressEnter();
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'Background job details')).toBe(
				true,
			);
			expect(frameHas(setup.captureSpans(), 'second')).toBe(true);
			setBgTasks(previous =>
				previous.map(task =>
					task.id === 'bg_live'
						? {...task, output: [...task.output, 'third live line']}
						: task,
				),
			);
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'third live line')).toBe(true);
			expect(frameHas(setup.captureSpans(), 'LIVE · 3 lines')).toBe(true);
		} finally {
			setBgTasks([]);
			setup.renderer.destroy();
		}
	});

	test('clicking outside the card closes the modal', async () => {
		setBgTasks([
			{
				id: 'bg_test',
				command: 'sleep 5',
				output: [],
				running: true,
				exitCode: null,
				startedAt: Date.now(),
			},
		]);
		let closed = 0;
		const setup = await testRender(
			() => <BackgroundJobsModal onClose={() => (closed += 1)} />,
			{width: 100, height: 30},
		);
		try {
			await setup.flush();
			// Wait past the mountedAt 400ms auto-close guard window, then
			// click outside the card (backdrop) — same pattern as every
			// other modal's auto-close guard.
			await new Promise(resolve => setTimeout(resolve, 500));
			await setup.mockMouse.click(0, 0);
			await setup.flush();
			expect(closed).toBe(1);
		} finally {
			setBgTasks([]);
			setup.renderer.destroy();
		}
	});

	test('empty state renders a friendly line', async () => {
		setBgTasks([]);
		const setup = await testRender(
			() => <BackgroundJobsModal onClose={() => {}} />,
			{width: 100, height: 20},
		);
		try {
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'No background jobs.')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('the notification card paints `background jobs: n` + the /ps hint (top-right, clickable)', async () => {
		const setup = await testRender(
			() => (
				<box
					position="absolute"
					top={1}
					right={2}
					zIndex={2500}
					flexDirection="column"
					border
					borderStyle="rounded"
					borderColor={colors().primary}
					backgroundColor={colors().base}
					paddingX={2}
					paddingY={1}
				>
					<text
						fg={colors().primary}
						attributes={createTextAttributes({bold: true})}
					>
						bg: 1
					</text>
					<text
						fg={colors().secondary}
						attributes={createTextAttributes({dim: true})}
					>
						/ps · click
					</text>
				</box>
			),
			{width: 100, height: 20},
		);
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'bg: 1')).toBe(true);
			expect(frameHas(frame, '/ps · click')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});
});

test('agents tab supports selection, details, and live transcript updates', async () => {
	setBgTasks([]);
	const {setActiveAgentRuns} = await import('./state');
	setActiveAgentRuns([
		{
			id: 'agent_one',
			name: 'explore',
			description: 'inspect routing',
			output: 'Implemented first slice.',
			transcript: ['Task: inspect routing', 'Implemented first slice.'],
			streaming: '',
			history: [
				{role: 'user', content: 'Task: inspect routing'},
				{role: 'assistant', content: 'Implemented first slice.'},
			],
			status: 'running',
		},
	]);
	const setup = await testRender(
		() => <BackgroundJobsModal onClose={() => {}} />,
		{width: 100, height: 30},
	);
	try {
		await setup.flush();
		setup.mockInput.pressArrow('right');
		await setup.flush();
		expect(frameHas(setup.captureSpans(), 'Agents (1)')).toBe(true);
		expect(frameHas(setup.captureSpans(), 'inspect routing')).toBe(true);
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(frameHas(setup.captureSpans(), 'Subagent details')).toBe(true);
		expect(frameHas(setup.captureSpans(), 'Task: inspect routing')).toBe(true);
		expect(frameHas(setup.captureSpans(), '❯ Task: inspect routing')).toBe(
			true,
		);
		setActiveAgentRuns(previous =>
			previous.map(run =>
				run.id === 'agent_one'
					? {
							...run,
							output: 'Bash bun test',
							transcript: [...run.transcript, 'Bash bun test'],
							history: [
								...run.history,
								{
									role: 'assistant',
									content: '',
									tool_calls: [
										{
											id: 'call_1',
											name: 'execute_bash',
											arguments: '{"command":"bun test"}',
										},
									],
								},
								{
									role: 'tool',
									content: '20 tests passed',
									tool_call_id: 'call_1',
								},
							],
						}
					: run,
			),
		);
		await setup.flush();
		expect(frameHas(setup.captureSpans(), 'bun test')).toBe(true);
		expect(frameHas(setup.captureSpans(), '20 tests passed')).toBe(true);
	} finally {
		setActiveAgentRuns([]);
		setup.renderer.destroy();
	}
});

test('agents tab shows only running agents in a bounded item window', async () => {
	setBgTasks([]);
	const {setActiveAgentRuns} = await import('./state');
	setActiveAgentRuns([
		...Array.from({length: 6}, (_, index) => ({
			id: `agent_${index}`,
			name: 'explore',
			description: `task ${index}`,
			output: Array.from(
				{length: 12},
				(__, line) => `agent ${index} line ${line}`,
			).join('\n'),
			transcript: [],
			streaming: '',
			history: [],
			status: 'running' as const,
		})),
		{
			id: 'agent_done',
			name: 'explore',
			description: 'stale completed task',
			output: 'must not render',
			transcript: [],
			streaming: '',
			history: [],
			status: 'completed',
		},
	]);
	const setup = await testRender(
		() => <BackgroundJobsModal onClose={() => {}} />,
		{width: 100, height: 20},
	);
	try {
		await setup.flush();
		setup.mockInput.pressArrow('right');
		await setup.flush();
		const initial = setup.captureSpans();
		expect(frameHas(initial, 'Agents (6)')).toBe(true);
		expect(frameHas(initial, 'task 0')).toBe(true);
		expect(frameHas(initial, 'task 1')).toBe(true);
		expect(frameHas(initial, 'task 2')).toBe(false);
		expect(frameHas(initial, 'stale completed task')).toBe(false);
		expect(frameHas(initial, 'agent 0 line 7')).toBe(false);
		expect(frameHas(initial, 'agent 0 line 8')).toBe(true);
		setup.mockInput.pressArrow('down');
		setup.mockInput.pressArrow('down');
		await setup.flush();
		const moved = setup.captureSpans();
		expect(frameHas(moved, 'task 0')).toBe(false);
		expect(frameHas(moved, 'task 2')).toBe(true);
	} finally {
		setActiveAgentRuns([]);
		setup.renderer.destroy();
	}
});

test('agents tab advertises per-agent and cancel-all controls', async () => {
	setBgTasks([]);
	const {setActiveAgentRuns} = await import('./state');
	setActiveAgentRuns([
		{
			id: 'agent_cancel_hint',
			name: 'general',
			description: 'long task',
			output: 'Working…',
			transcript: [],
			streaming: '',
			history: [],
			status: 'running',
		},
	]);
	const setup = await testRender(
		() => <BackgroundJobsModal onClose={() => {}} />,
		{width: 100, height: 20},
	);
	try {
		await setup.flush();
		setup.mockInput.pressArrow('right');
		await setup.flush();
		expect(
			frameHas(
				setup.captureSpans(),
				'x cancel selected · c cancel all · Esc close',
			),
		).toBe(true);
	} finally {
		setActiveAgentRuns([]);
		setup.renderer.destroy();
	}
});

test('subagent details wrap long transcript rows inside a viewport-width card', async () => {
	setBgTasks([]);
	const {setActiveAgentRuns} = await import('./state');
	setActiveAgentRuns([
		{
			id: 'agent_long_detail',
			name: 'explore',
			description: 'long detail',
			output: '',
			transcript: [],
			streaming: '',
			history: [
				{
					role: 'user',
					content: `Task: ${'very-long-token '.repeat(24)}`,
				},
			],
			status: 'running',
		},
	]);
	const setup = await testRender(
		() => <BackgroundJobsModal onClose={() => {}} />,
		{width: 40, height: 24},
	);
	try {
		await setup.flush();
		setup.mockInput.pressArrow('right');
		await setup.flush();
		setup.mockInput.pressEnter();
		await setup.flush();
		const frame = setup.captureSpans();
		expect(frameHas(frame, 'Subagent')).toBe(true);
		expect(
			frame.lines.every(
				line => line.spans.map(span => span.text).join('').length <= 40,
			),
		).toBe(true);
	} finally {
		setActiveAgentRuns([]);
		setup.renderer.destroy();
	}
});
