/** @jsxImportSource @opentui/solid */
import '@opentui/solid/preload';
import {afterEach, describe, expect, test} from 'bun:test';
import {RGBA, type BoxRenderable} from '@opentui/core';
import {testRender, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, Show} from 'solid-js';
import {
	InlineAgentRows,
	inlineAgentLayout,
} from './components/inline-agent-rows';
import {
	type ActiveAgentRun,
	input,
	runningAgentRows,
	setActiveAgentRuns,
	setActiveAgents,
	setBusy,
	setInput,
} from './state';
import {InputBox, computeInputBoxHeight} from './components/input-box';
import {ActivityIndicator} from './components/activity-indicator';
import {Status} from './components/status';
import {colors} from './theme';

const makeAgent = (index: number) => ({
	id: `agent_${index}`,
	name: 'general',
	description: `Agent task ${index}`,
	output: '',
	transcript: [],
	streaming: '',
	history: [],
	status: 'running' as const,
	startedAt: Date.now(),
	tokensUsed: 0,
});

test('running rows survive count changes with unchanged retained-run cardinality', async () => {
	setActiveAgentRuns([]);
	const setup = await testRender(
		() => (
			<InlineAgentRows
				selectedIndex={-1}
				onSelect={() => {}}
				onOpen={() => {}}
				onNavigate={() => true}
			/>
		),
		{width: 100, height: 10},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	try {
		await setup.flush();
		expect(text()).not.toContain('general-purpose');
		setActiveAgentRuns([makeAgent(1)]);
		await setup.flush();
		expect(text()).toContain('Agent task 1');
		setActiveAgentRuns(
			Array.from({length: 9}, (_, index) => makeAgent(index + 1)),
		);
		await setup.flush();
		expect(text()).toContain('Agent task 9');
		setActiveAgentRuns(runs =>
			runs.map(run => ({
				...run,
				status: run.id === 'agent_9' ? 'running' : 'completed',
			})),
		);
		await setup.flush();
		expect(text()).toContain('Agent task 9');
		expect(text()).not.toContain('more above');
	} finally {
		setup.renderer.destroy();
	}
});

afterEach(() => {
	setActiveAgentRuns([]);
	setActiveAgents(0);
	setInput('');
	setBusy(false);
});

test('recently completed agents consume no rows with a zero allocation', async () => {
	setActiveAgentRuns([
		{...makeAgent(1), status: 'completed', finishedAt: Date.now()},
	]);
	const setup = await testRender(
		() => (
			<box flexDirection="column">
				<InlineAgentRows
					layout={inlineAgentLayout(0, 0)}
					selectedIndex={-1}
					onSelect={() => {}}
					onOpen={() => {}}
					onNavigate={() => true}
				/>
				<text height={1}>Next row</text>
			</box>
		),
		{width: 80, height: 12},
	);
	try {
		await setup.flush();
		expect(
			setup
				.captureSpans()
				.lines[0]!.spans.map(span => span.text)
				.join(''),
		).toContain('Next row');
	} finally {
		setup.renderer.destroy();
	}
});

test('real composer stays intact through agent completion and narrow resize', async () => {
	setBusy(false);
	const draft = 'Keep this draft intact while agents finish.';
	setInput(draft);
	setActiveAgentRuns([makeAgent(1), makeAgent(2), makeAgent(3)]);
	let root!: BoxRenderable;
	let end!: BoxRenderable;
	let allocated = () => inlineAgentLayout(0, 0);
	const setup = await testRender(
		() => {
			const dimensions = useTerminalDimensions();
			const composerRows = createMemo(
				() => computeInputBoxHeight(input(), dimensions().width, false) + 2,
			);
			const layout = createMemo(() =>
				inlineAgentLayout(
					runningAgentRows().length,
					dimensions().height - composerRows(),
				),
			);
			allocated = layout;
			return (
				<box ref={root} height="100%" flexDirection="column" paddingX={1}>
					{/* Saturate the available history without mounting unrelated session machinery. */}
					<box
						height={Math.max(
							0,
							dimensions().height - composerRows() - layout().height,
						)}
						flexShrink={0}
						overflow="hidden"
					>
						<text>{'History transcript\n'.repeat(40)}</text>
					</box>
					<box height={1} />
					<InputBox onSubmit={() => {}} />
					<Status cwd="/work" />
					<Show when={layout().gapHeight > 0}>
						<box height={layout().gapHeight} flexShrink={0}>
							<text> </text>
						</box>
					</Show>
					<InlineAgentRows
						layout={layout()}
						selectedIndex={-1}
						onSelect={() => {}}
						onOpen={() => {}}
						onNavigate={() => true}
					/>
					<box ref={end} height={0} flexShrink={0} />
				</box>
			);
		},
		{width: 80, height: 12},
	);
	const assertGeometry = async (width: number, height: number) => {
		await setup.flush();
		const lines = setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''));
		const statusY = height - allocated().height - 1;
		const inputHeight = computeInputBoxHeight(draft, width, false);
		expect(end.y).toBe(height);
		expect(root.height).toBe(height);
		expect(lines[statusY]).toMatch(/^\s*⏵⏵⏵ /);
		expect(lines[statusY - inputHeight]).toContain('╭');
		expect(lines[statusY - inputHeight]).toContain('╮');
		expect(lines[statusY - 1]).toContain('╰');
		expect(lines[statusY - 1]).toContain('╯');
		const paintedDraft = lines
			.slice(statusY - inputHeight + 1, statusY - 1)
			.join('')
			.replace(/[\s│❯]/g, '');
		expect(paintedDraft).toContain(draft.replace(/\s/g, ''));
		expect(input()).toBe(draft);
	};
	try {
		await assertGeometry(80, 12);
		setActiveAgentRuns(runs =>
			runs.map((run, index) =>
				index === 0
					? {...run, status: 'completed', finishedAt: Date.now()}
					: run,
			),
		);
		await assertGeometry(80, 12);
		setup.resize(32, 8);
		await assertGeometry(32, 8);
		setActiveAgentRuns(runs =>
			runs.map(run => ({...run, status: 'completed', finishedAt: Date.now()})),
		);
		await assertGeometry(32, 8);
		setup.resize(80, 12);
		await assertGeometry(80, 12);

		// A failed or cancelled child must release the same allocation as a success.
		setActiveAgentRuns([makeAgent(1), makeAgent(2), makeAgent(3)]);
		await assertGeometry(80, 12);
		const outcomes = [
			'error',
			'cancelled',
			'completed',
		] as const satisfies readonly ActiveAgentRun['status'][];
		for (const [index, status] of outcomes.entries()) {
			const finishedAt = Date.now();
			setActiveAgentRuns(runs =>
				runs.map((run, runIndex) =>
					runIndex === index ? {...run, status, finishedAt} : run,
				),
			);
			expect(runningAgentRows()).toHaveLength(outcomes.length - index - 1);
			await assertGeometry(80, 12);
			setup.resize(32, 8);
			await assertGeometry(32, 8);
			setup.resize(80, 12);
			await assertGeometry(80, 12);
		}
	} finally {
		setup.renderer.destroy();
	}
});

test('badge and inline rows share reactive running projection, not execution counter', async () => {
	setActiveAgentRuns([]);
	setActiveAgents(77);
	const setup = await testRender(
		() => (
			<box height="100%" flexDirection="column">
				<box height={6} flexShrink={0} />
				<Status cwd="/work" />
				<InlineAgentRows
					selectedIndex={-1}
					onSelect={() => {}}
					onOpen={() => {}}
					onNavigate={() => true}
				/>
				<Show when={runningAgentRows().length > 0}>
					<ActivityIndicator
						backgroundCount={0}
						agentCount={runningAgentRows().length}
						goalActive={false}
						onOpen={() => {}}
					/>
				</Show>
			</box>
		),
		{width: 100, height: 18},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	try {
		await setup.flush();
		expect(text()).not.toContain('agents:');
		setActiveAgentRuns([makeAgent(1), {...makeAgent(2), status: 'completed'}]);
		await setup.flush();
		expect(text()).toContain('agents: 1');
		expect(text()).toContain('Agent task 1');
		expect(text()).not.toContain('Agent task 2');
		setActiveAgentRuns(runs => runs.map(run => ({...run, status: 'running'})));
		await setup.flush();
		expect(text()).toContain('agents: 2');
		expect(text()).toContain('Agent task 2');
		setActiveAgentRuns(runs =>
			runs.map(run => ({
				...run,
				status: run.id === 'agent_2' ? 'running' : 'completed',
				tokensUsed: 42_000,
			})),
		);
		await setup.flush();
		expect(text()).toContain('agents: 1');
		expect(text()).toContain('Agent task 2');
		expect(text()).toContain('42.0K tokens');
		expect(text()).not.toContain('Agent task 1');
		setActiveAgentRuns(runs =>
			runs.map(run => ({...run, status: 'completed'})),
		);
		await setup.flush();
		expect(text()).not.toContain('agents:');
		expect(text()).not.toContain('general-purpose');
	} finally {
		setup.renderer.destroy();
	}
});

test('resizing bounds footer, preserves status, and keeps selected overflow row visible', async () => {
	setActiveAgentRuns(
		Array.from({length: 8}, (_, index) => makeAgent(index + 1)),
	);
	const [selected, setSelected] = createSignal(7);
	const setup = await testRender(
		() => {
			const dimensions = useTerminalDimensions();
			const layout = createMemo(() =>
				inlineAgentLayout(runningAgentRows().length, dimensions().height - 4),
			);
			return (
				<box height="100%" flexDirection="column" paddingX={1}>
					<box
						height={Math.max(0, dimensions().height - 4 - layout().height)}
						flexShrink={0}
					/>
					<box height={3} flexShrink={0}>
						<text>Composer</text>
					</box>
					<Status cwd="/work" />
					<Show when={layout().gapHeight > 0}>
						<box height={layout().gapHeight} flexShrink={0}>
							<text> </text>
						</box>
					</Show>
					<InlineAgentRows
						layout={layout()}
						selectedIndex={selected()}
						onSelect={setSelected}
						onOpen={() => {}}
						onNavigate={() => true}
					/>
				</box>
			);
		},
		{width: 100, height: 18},
	);
	const lines = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''));
	try {
		await setup.flush();
		expect(lines().join('\n')).toContain('Agent task 8');
		expect(
			lines().filter(line => line.includes('general-purpose')),
		).toHaveLength(5);
		setup.resize(32, 8);
		await setup.flush();
		expect(lines().join('\n')).toContain('Composer');
		expect(lines()[3]).toMatch(/^\s*⏵⏵⏵ \S/);
		expect(lines().join('\n')).toContain('Agent task 8');
		expect(lines().filter(line => line.includes('Agent task'))).toHaveLength(2);
		expect(lines().join('\n')).toContain('↑ 6 more above');
		setSelected(0);
		await setup.flush();
		expect(lines().join('\n')).toContain('Agent task 1');
		expect(lines().join('\n')).toContain('↓ 6 more below');
		setup.resize(24, 5);
		await setup.flush();
		expect(lines().join('\n')).toContain('agents: 8 · /ps');
		expect(lines()[3]).toMatch(/^\s*⏵⏵⏵ \S/);
		setup.resize(80, 18);
		await setup.flush();
		expect(lines().join('\n')).toContain('Agent task 1');
		expect(
			lines().filter(line => line.includes('general-purpose')),
		).toHaveLength(5);
	} finally {
		setup.renderer.destroy();
	}
});

describe('InlineAgentRows', () => {
	test('renders only agents with fixed telemetry columns', async () => {
		setActiveAgentRuns([
			{
				id: 'agent_1',
				name: 'general',
				description: 'What is hello in Japanese',
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				status: 'running',
				startedAt: Date.now() - 4000,
				tokensUsed: 34_500,
			},
		]);
		const setup = await testRender(
			() => (
				<InlineAgentRows
					selectedIndex={-1}
					onSelect={() => {}}
					onOpen={() => {}}
					onNavigate={() => true}
				/>
			),
			{width: 80, height: 8},
		);
		try {
			await setup.flush();
			const rows = setup
				.captureSpans()
				.lines.filter(line =>
					line.spans.some(span => span.text.includes('general-purpose')),
				);
			expect(rows).toHaveLength(1);
			const text = rows.map(line => line.spans.map(span => span.text).join(''));
			expect(text[0]).not.toContain('main');
			expect(text[0]).toContain('general-purpose');
			expect(text[0]).toContain('What is hello in Japa…');
			expect(text[0]).toContain('34.5K tokens');
			const secondary = RGBA.fromHex(colors().secondary);
			for (const row of rows) {
				for (const span of row.spans.filter(span => span.text.trim())) {
					expect((span.fg as RGBA).equals(secondary)).toBe(true);
				}
			}
		} finally {
			setup.renderer.destroy();
		}
	});

	test('hover or explicit keyboard selection uses primary; click opens without selecting', async () => {
		setActiveAgentRuns([
			{
				id: 'agent_1',
				name: 'general',
				description: 'Inspect UI',
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				status: 'running',
				startedAt: Date.now(),
				tokensUsed: 0,
			},
		]);
		let opened = '';
		const [selected, setSelected] = createSignal(-1);
		const setup = await testRender(
			() => (
				<InlineAgentRows
					selectedIndex={selected()}
					onSelect={setSelected}
					onOpen={id => (opened = id)}
					onNavigate={() => true}
				/>
			),
			{width: 80, height: 4},
		);
		try {
			await setup.flush();
			let span = setup
				.captureSpans()
				.lines.flatMap(line => line.spans)
				.find(item => item.text.includes('Inspect UI'))!;
			expect((span.fg as RGBA).equals(RGBA.fromHex(colors().secondary))).toBe(
				true,
			);
			await setup.mockMouse.moveTo(4, 0);
			expect(selected()).toBe(-1);
			await setup.flush();
			span = setup
				.captureSpans()
				.lines.flatMap(line => line.spans)
				.find(item => item.text.includes('Inspect UI'))!;
			expect((span.fg as RGBA).equals(RGBA.fromHex(colors().primary))).toBe(
				true,
			);
			await setup.mockMouse.click(4, 0);
			expect(opened).toBe('agent_1');
			expect(selected()).toBe(-1);

			setSelected(0);
			await setup.flush();
			span = setup
				.captureSpans()
				.lines.flatMap(line => line.spans)
				.find(item => item.text.includes('Inspect UI'))!;
			expect((span.fg as RGBA).equals(RGBA.fromHex(colors().primary))).toBe(
				true,
			);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('renders a blank gap, five-agent window, and overflow count', async () => {
		setActiveAgentRuns(
			Array.from({length: 8}, (_, index) => ({
				id: `agent_${index + 1}`,
				name: 'general',
				description: `Agent task ${index + 1}`,
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				status: 'running' as const,
				startedAt: Date.now(),
				tokensUsed: 0,
			})),
		);
		const setup = await testRender(
			() => (
				<InlineAgentRows
					selectedIndex={-1}
					onSelect={() => {}}
					onOpen={() => {}}
					onNavigate={() => true}
				/>
			),
			{width: 100, height: 10},
		);
		try {
			await setup.flush();
			const lines = setup
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''));
			const firstAgentLine = lines.findIndex(line =>
				line.includes('Agent task 1'),
			);
			expect(firstAgentLine).toBe(0);
			expect(
				lines.filter(line => line.includes('general-purpose')),
			).toHaveLength(5);
			expect(lines.join('\n')).toContain('Agent task 5');
			expect(lines.join('\n')).not.toContain('Agent task 6');
			expect(lines.join('\n')).toContain('↓ 3 more below');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('arrow selection past row five scrolls the window and overflow labels', async () => {
		setActiveAgentRuns(
			Array.from({length: 8}, (_, index) => ({
				id: `agent_${index + 1}`,
				name: 'general',
				description: `Agent task ${index + 1}`,
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				status: 'running' as const,
				startedAt: Date.now(),
				tokensUsed: 0,
			})),
		);
		const setup = await testRender(
			() => (
				<InlineAgentRows
					selectedIndex={5}
					onSelect={() => {}}
					onOpen={() => {}}
					onNavigate={() => true}
				/>
			),
			{width: 100, height: 8},
		);
		try {
			await setup.flush();
			const text = setup
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
			expect(text).not.toContain('Agent task 1');
			expect(text).toContain('Agent task 2');
			expect(text).toContain('Agent task 6');
			expect(text).not.toContain('Agent task 7');
			expect(text).toContain('↑ 1 more above · ↓ 2 more below');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('duplicate long tasks use description prefixes', async () => {
		const description =
			'Do not edit files. First run exactly `sleep 45`. Then inspect package structure and dependency boundaries in detail.';
		setActiveAgentRuns(
			Array.from({length: 2}, (_, index) => ({
				id: `agent_${index + 1}`,
				name: 'general',
				description,
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				status: 'running' as const,
				startedAt: Date.now(),
				tokensUsed: 0,
			})),
		);
		const setup = await testRender(
			() => (
				<InlineAgentRows
					selectedIndex={-1}
					onSelect={() => {}}
					onOpen={() => {}}
					onNavigate={() => true}
				/>
			),
			{width: 100, height: 4},
		);
		try {
			await setup.flush();
			const text = setup
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
			expect(text).toContain('alpha: inspect package structure and depe…');
			expect(text).toContain(
				'◯ general-purpose    alpha: inspect package structure',
			);
			expect(text).not.toContain('Do not edit files');
		} finally {
			setup.renderer.destroy();
		}
	});

	test('mouse wheel scrolls list and new agents follow bottom', async () => {
		const makeAgents = (count: number) =>
			Array.from({length: count}, (_, index) => ({
				id: `agent_${index + 1}`,
				name: 'general',
				description: `Agent task ${index + 1}`,
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				status: 'running' as const,
				startedAt: Date.now(),
				tokensUsed: 0,
			}));
		setActiveAgentRuns(makeAgents(8));
		const setup = await testRender(
			() => (
				<InlineAgentRows
					selectedIndex={-1}
					onSelect={() => {}}
					onOpen={() => {}}
					onNavigate={() => true}
				/>
			),
			{width: 100, height: 8},
		);
		try {
			await setup.flush();
			await setup.mockMouse.scroll(4, 1, 'down');
			await setup.flush();
			let text = setup
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
			expect(text).toContain('Agent task 2');
			setActiveAgentRuns(makeAgents(9));
			await setup.flush();
			text = setup
				.captureSpans()
				.lines.map(line => line.spans.map(span => span.text).join(''))
				.join('\n');
			expect(text).toContain('Agent task 9');
		} finally {
			setup.renderer.destroy();
		}
	});
});
