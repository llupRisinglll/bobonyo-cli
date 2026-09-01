/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {bgTasks, type BackgroundTask} from '../bash';
import {
	activeAgents,
	activeAgentRuns,
	glyphBlinkOn,
	spinnerFrame,
} from '../state';
import {liveRowSegments} from '../live-tool-row';
import {cancelActiveAgent, cancelActiveAgents} from '../tools';
import {activeRowPalette} from '../row-highlight';
import {History} from './history';
import {subagentDisplayMessages} from '../subagent-transcript';
import {formatSubagentCompactTail} from '../subagent-tail';
import {formatGoal, type SessionGoal} from '../goal-loop';

const JOB_TAIL_LINES = 4;
const AGENT_TAIL_LINES = 4;
const LIST_CHROME_ROWS = 4;
type ActivityTab = 'jobs' | 'agents' | 'goal';

/** Last N output rows for the compact job list. */
export function backgroundJobTail(
	output: string[],
	lines = JOB_TAIL_LINES,
): string[] {
	return output.slice(-Math.max(0, lines));
}

/** Visible detail window, offset 0 means follow live tail. */
export function backgroundJobDetailWindow(
	output: string[],
	visible: number,
	offsetFromTail: number,
): string[] {
	const end = Math.max(0, output.length - Math.max(0, offsetFromTail));
	return output.slice(Math.max(0, end - Math.max(1, visible)), end);
}

/**
 * Background process monitor. Compact list rows show syntax-highlighted
 * command plus four live output-tail rows. Selecting a row and pressing Enter
 * opens a live detail view. Detail view follows tail by default; Up/Down scroll
 * history, End returns to live tail.
 */
export function BackgroundJobsModal(props: {
	onClose: () => void;
	goal?: SessionGoal;
	initialTab?: ActivityTab;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const active = () => activeRowPalette(colors());
	const availableWidth = () => Math.max(1, dims().width - 2);
	const availableHeight = () => Math.max(1, dims().height - 2);
	const listCardWidth = () => Math.min(110, availableWidth());
	const detailContentLines = () =>
		detailAgent()
			? Math.max(6, agentMessages().length * 4)
			: Math.max(1, (detailTask()?.output.length ?? 0) + 2);
	const cardWidth = () => (detailId() ? availableWidth() : listCardWidth());
	const cardHeight = () =>
		detailId()
			? Math.min(availableHeight(), Math.max(1, detailContentLines() + 5))
			: Math.max(1, Math.min(availableHeight(), 34));
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();
	const [tab, setTab] = createSignal<ActivityTab>(props.initialTab ?? 'jobs');
	const [selected, setSelected] = createSignal(0);
	const [detailId, setDetailId] = createSignal<string | null>(null);
	const [detailOffset, setDetailOffset] = createSignal(0);
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	// Running jobs only. Clone output so every runBash signal tick repaints.
	const jobs = createMemo(() =>
		bgTasks()
			.filter(task => task.running)
			.map(task => ({...task, output: [...task.output]})),
	);
	const agents = createMemo(() =>
		activeAgentRuns().filter(run => run.status === 'running'),
	);
	const detailTask = createMemo(
		() => jobs().find(task => task.id === detailId()) ?? null,
	);
	const detailAgent = createMemo(
		() => agents().find(agent => agent.id === detailId()) ?? null,
	);
	const listRowsPerJob = JOB_TAIL_LINES + 2; // command + tail + gap
	const listRowsPerAgent = AGENT_TAIL_LINES + 2; // header + tail + gap
	const visibleCount = (rowsPerItem: number) =>
		Math.max(1, Math.floor((cardHeight() - LIST_CHROME_ROWS) / rowsPerItem));
	const listStart = (length: number, count: number) =>
		Math.max(0, Math.min(selected(), Math.max(0, length - count)));
	const visibleJobs = createMemo(() => {
		const count = visibleCount(listRowsPerJob);
		const start = listStart(jobs().length, count);
		return jobs().slice(start, start + count);
	});
	const visibleAgents = createMemo(() => {
		const count = visibleCount(listRowsPerAgent);
		const start = listStart(agents().length, count);
		return agents().slice(start, start + count);
	});
	const detailVisibleLines = () => Math.max(1, cardHeight() - 8);
	const detailLines = createMemo(() =>
		backgroundJobDetailWindow(
			detailTask()?.output ?? [],
			detailVisibleLines(),
			detailOffset(),
		),
	);
	const agentMessages = createMemo(() => {
		const agent = detailAgent();
		return agent ? subagentDisplayMessages(agent) : [];
	});
	const detailHistoryWidth = () => Math.max(1, cardWidth() - 8);

	createEffect(() => {
		const count =
			tab() === 'agents'
				? agents().length
				: tab() === 'goal'
					? props.goal
						? 1
						: 0
					: jobs().length;
		if (count === 0) setSelected(0);
		else if (selected() >= count) setSelected(count - 1);
		if (detailId() && !detailTask() && !detailAgent()) {
			setDetailId(null);
			setDetailOffset(0);
		}
	});

	const commandSegments = (task: BackgroundTask) =>
		liveRowSegments(
			`✦ $ ${task.command.replace(/\s+/g, ' ').trim()}`,
			'bashrow',
			'running',
			colors(),
			Math.max(20, cardWidth() - 8),
		).header;

	useKeyboard(event => {
		if (event.name === 'escape') {
			if (detailId()) {
				setDetailId(null);
				setDetailOffset(0);
			} else props.onClose();
			return true;
		}
		if (detailId()) {
			if (detailAgent()) return;
			const detailOutputLength =
				detailAgent()?.transcript.length ?? detailTask()?.output.length ?? 0;
			const maxOffset = Math.max(0, detailOutputLength - detailVisibleLines());
			if (event.name === 'up' || event.name === 'pageup') {
				setDetailOffset(value =>
					Math.min(maxOffset, value + (event.name === 'pageup' ? 8 : 1)),
				);
				return true;
			}
			if (event.name === 'down' || event.name === 'pagedown') {
				setDetailOffset(value =>
					Math.max(0, value - (event.name === 'pagedown' ? 8 : 1)),
				);
				return true;
			}
			if (event.name === 'end') {
				setDetailOffset(0);
				return true;
			}
			return;
		}
		if (tab() === 'agents' && event.name.toLowerCase() === 'x') {
			const agent = agents()[selected()];
			if (agent) cancelActiveAgent(agent.id);
			return true;
		}
		if (tab() === 'agents' && event.name.toLowerCase() === 'c') {
			cancelActiveAgents();
			return true;
		}
		if (
			event.name === 'left' ||
			event.name === 'right' ||
			event.name === 'tab'
		) {
			const tabs: ActivityTab[] = ['jobs', 'agents', 'goal'];
			setTab(current => {
				const index = tabs.indexOf(current);
				const delta = event.name === 'left' ? -1 : 1;
				return tabs[(index + delta + tabs.length) % tabs.length]!;
			});
			setSelected(0);
			return true;
		}
		if (tab() === 'agents' && (event.name === 'up' || event.name === 'down')) {
			setSelected(index =>
				event.name === 'down'
					? Math.min(Math.max(0, agents().length - 1), index + 1)
					: Math.max(0, index - 1),
			);
			return true;
		}
		if (tab() === 'agents' && event.name === 'return') {
			const agent = agents()[selected()];
			if (agent) {
				setDetailId(agent.id);
				setDetailOffset(0);
			}
			return true;
		}
		if (tab() === 'jobs' && (event.name === 'up' || event.name === 'down')) {
			setSelected(index =>
				event.name === 'down'
					? Math.min(Math.max(0, jobs().length - 1), index + 1)
					: Math.max(0, index - 1),
			);
			return true;
		}
		if (tab() === 'jobs' && event.name === 'return') {
			const task = jobs()[selected()];
			if (task) {
				setDetailId(task.id);
				setDetailOffset(0);
			}
			return true;
		}
	});

	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width={dims().width}
			height={dims().height}
			zIndex={3000}
			alignItems="center"
			paddingTop={cardY()}
			backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
			{...({
				onMouseUp: (event: {x?: number; y?: number}) => {
					if (isOpeningRelease()) return;
					if (
						typeof event.x === 'number' &&
						typeof event.y === 'number' &&
						!insideCard(event.x, event.y)
					) {
						props.onClose();
					}
				},
			} as any)}
		>
			<box
				width={cardWidth()}
				height={cardHeight()}
				backgroundColor={colors().base}
				overflow="hidden"
				paddingX={2}
				paddingY={1}
				flexDirection="column"
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						{detailId()
							? detailAgent()
								? 'Subagent details'
								: 'Background job details'
							: `Process monitor [${tab() === 'jobs' ? '*jobs*' : 'jobs'} | ${tab() === 'agents' ? '*agents*' : 'agents'} | ${tab() === 'goal' ? '*goal*' : 'goal'}]`}
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						{detailId()
							? '↑/↓ history · End live · Esc back'
							: tab() === 'agents' && agents().length > 0
								? 'x cancel selected · c cancel all · Esc close'
								: tab() === 'goal'
									? 'Esc close'
									: '↑/↓ select · Enter details · Esc close'}
					</text>
				</box>

				<Show when={!detailId()}>
					<box height={1} flexDirection="row">
						<box
							height={1}
							paddingX={1}
							backgroundColor={tab() === 'jobs' ? colors().info : undefined}
						>
							<text
								fg={tab() === 'jobs' ? colors().base : colors().secondary}
								attributes={tab() === 'jobs' ? bold() : dim()}
							>{`Jobs (${jobs().length})`}</text>
						</box>
						<box width={1} />
						<box
							height={1}
							paddingX={1}
							backgroundColor={tab() === 'agents' ? colors().info : undefined}
						>
							<text
								fg={tab() === 'agents' ? colors().base : colors().secondary}
								attributes={tab() === 'agents' ? bold() : dim()}
							>{`Agents (${agents().length})`}</text>
						</box>
						<box width={1} />
						<box
							height={1}
							paddingX={1}
							backgroundColor={tab() === 'goal' ? colors().info : undefined}
						>
							<text
								fg={tab() === 'goal' ? colors().base : colors().secondary}
								attributes={tab() === 'goal' ? bold() : dim()}
							>{`Goal (${props.goal?.status === 'active' ? 'active' : 'none'})`}</text>
						</box>
					</box>
				</Show>

				<Show when={detailTask()}>
					{task => (
						<box flexDirection="column" flexGrow={1} minHeight={0}>
							{/* One BashToolRow-style box owns BOTH command and live
							    output. Separate boxes made output look detached. */}
							<box
								width="100%"
								flexDirection="column"
								flexGrow={1}
								minHeight={0}
								overflow="hidden"
								border
								borderStyle="rounded"
								borderColor={colors().secondary}
								paddingX={1}
							>
								<box flexDirection="row">
									<text fg={colors().secondary}>$ </text>
									<text>
										<For each={commandSegments(task())}>
											{chunk => (
												<span
													style={{
														fg: chunk.fg as never,
														attributes: chunk.attributes,
													}}
												>
													{chunk.text.replace(/^\$\s*/, '')}
												</span>
											)}
										</For>
									</text>
								</box>
								<box height={1} />
								<For each={detailLines()}>
									{line => <text fg={colors().text}>{line}</text>}
								</For>
								<Show when={detailLines().length === 0}>
									<text fg={colors().secondary} attributes={dim()}>
										Waiting for output…
									</text>
								</Show>
								<box flexGrow={1} />
								<text fg={colors().secondary} attributes={dim()}>
									{detailOffset() === 0
										? `LIVE · ${task().output.length} lines`
										: `${detailOffset()} lines behind live tail`}
								</text>
							</box>
						</box>
					)}
				</Show>

				<Show when={detailAgent()}>
					{agent => (
						<box width="100%" flexDirection="column" flexGrow={1} minHeight={0}>
							<box
								width="100%"
								flexDirection="column"
								flexGrow={1}
								minHeight={0}
								overflow="hidden"
								border
								borderStyle="rounded"
								borderColor={colors().secondary}
								paddingX={1}
							>
								<text fg={colors().primary} attributes={bold()}>
									{`agent:${agent().name}(${agent().description}) is ${agent().status === 'running' ? 'running' : agent().status}`}
								</text>
								<History
									embedded
									width={detailHistoryWidth()}
									height={Math.max(1, cardHeight() - 7)}
									messages={agentMessages}
									running={() => detailAgent()?.status === 'running'}
									streaming={() => detailAgent()?.streaming ?? ''}
									reasoning={() => ''}
									liveOutputs={() => ({})}
									activeAgentRuns={() => []}
								/>
							</box>
						</box>
					)}
				</Show>
				<Show when={!detailId() && tab() === 'jobs'}>
					<Show
						when={jobs().length > 0}
						fallback={
							<text fg={colors().secondary} attributes={dim()}>
								No background jobs.
							</text>
						}
					>
						<For each={visibleJobs()}>
							{task => {
								const index = () =>
									jobs().findIndex(item => item.id === task.id);
								const selectedRow = () => index() === selected();
								return (
									<box
										flexDirection="column"
										backgroundColor={selectedRow() ? active().bg : undefined}
										paddingX={1}
										{...({
											onMouseUp: () => {
												setSelected(index());
												setDetailId(task.id);
												setDetailOffset(0);
											},
										} as any)}
									>
										<text>
											<span
												style={{
													fg: selectedRow()
														? (active().fg as never)
														: (colors().secondary as never),
												}}
											>
												{selectedRow() ? '❯ ' : '  '}
												{glyphBlinkOn(spinnerFrame()) ? '✦ ' : '  '}
											</span>
											<For each={commandSegments(task)}>
												{chunk => (
													<span
														style={{
															fg: selectedRow()
																? (active().fg as never)
																: (chunk.fg as never),
															attributes: chunk.attributes,
														}}
													>
														{chunk.text}
													</span>
												)}
											</For>
										</text>
										<For each={backgroundJobTail(task.output)}>
											{line => (
												<text
													fg={selectedRow() ? active().fg : colors().secondary}
													attributes={dim()}
												>
													{'    ' + line}
												</text>
											)}
										</For>
										<Show when={task.output.length === 0}>
											<text
												fg={selectedRow() ? active().fg : colors().secondary}
												attributes={dim()}
											>
												Waiting for output…
											</text>
										</Show>
										<box height={1} />
									</box>
								);
							}}
						</For>
					</Show>
				</Show>

				<Show when={!detailId() && tab() === 'agents'}>
					<Show
						when={agents().length > 0}
						fallback={
							<text fg={colors().secondary} attributes={dim()}>
								No subagents found.
							</text>
						}
					>
						<For each={visibleAgents()}>
							{run => {
								const index = () =>
									agents().findIndex(item => item.id === run.id);
								const selectedRow = () => index() === selected();
								const tail = formatSubagentCompactTail(
									run.output,
									AGENT_TAIL_LINES,
									Math.max(20, cardWidth() - 14),
								);
								const seg = liveRowSegments(
									`✦ agent:${run.name}(${run.description}) is running\n${tail}`,
									'agentrow',
									'running',
									colors(),
									cardWidth() - 8,
								);
								return (
									<box
										height={listRowsPerAgent}
										flexDirection="column"
										backgroundColor={selectedRow() ? active().bg : undefined}
										paddingX={1}
										{...({
											onMouseUp: () => {
												setSelected(index());
												setDetailId(run.id);
												setDetailOffset(0);
											},
										} as any)}
									>
										<text>
											<span
												style={{
													fg: selectedRow()
														? (active().fg as never)
														: (colors().secondary as never),
												}}
											>
												{selectedRow() ? '❯ ' : '  '}
												{run.status === 'running' &&
												glyphBlinkOn(spinnerFrame())
													? '✦ '
													: '  '}
											</span>
											<For each={seg.header}>
												{chunk => (
													<span
														style={{
															fg: selectedRow()
																? (active().fg as never)
																: (chunk.fg as never),
															attributes: chunk.attributes,
														}}
													>
														{chunk.text}
													</span>
												)}
											</For>
										</text>
										<For each={seg.body.slice(0, AGENT_TAIL_LINES)}>
											{line => (
												<text>
													<For each={line}>
														{chunk => (
															<span
																style={{
																	fg: selectedRow()
																		? (active().fg as never)
																		: (chunk.fg as never),
																	attributes: chunk.attributes,
																}}
															>
																{chunk.text}
															</span>
														)}
													</For>
												</text>
											)}
										</For>
										<box height={1} />
									</box>
								);
							}}
						</For>
					</Show>
				</Show>

				<Show when={!detailId() && tab() === 'goal'}>
					<Show
						when={props.goal}
						fallback={
							<text fg={colors().secondary} attributes={dim()}>
								No active goal.
							</text>
						}
					>
						{goal => (
							<box
								width="100%"
								flexDirection="column"
								border
								borderStyle="rounded"
								borderColor={colors().secondary}
								paddingX={1}
							>
								<text fg={colors().primary} attributes={bold()}>
									Long-running goal
								</text>
								<box height={1} />
								<text fg={colors().text}>{formatGoal(goal())}</text>
								<box height={1} />
								<text fg={colors().secondary} attributes={dim()}>
									/goal pause · /goal clear
								</text>
							</box>
						)}
					</Show>
				</Show>
			</box>
		</box>
	);
}
