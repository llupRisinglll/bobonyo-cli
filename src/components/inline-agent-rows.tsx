/** @jsxImportSource @opentui/solid */
import {
	For,
	Show,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from 'solid-js';
import {useTerminalDimensions} from '@opentui/solid';
import {activeAgentRuns, runningAgentRows, type ActiveAgentRun} from '../state';
export {runningAgentRows} from '../state';
import {colors} from '../theme';
import {agentDisplayLabels} from '../agent-label';

const AGENT_TYPE_WIDTH = 17;
const DESCRIPTION_TELEMETRY_GAP = 2;
const ELAPSED_WIDTH = 14;
const TELEMETRY_GAP = 3;
const TOKENS_WIDTH = 14;
export const INLINE_AGENT_VISIBLE_ROWS = 5;
const FINISHED_SUMMARY_MS = 12_000;

export function finishedAgentRows(
	runs: ActiveAgentRun[],
	now = Date.now(),
): ActiveAgentRun[] {
	return runs.filter(
		run =>
			run.status !== 'running' &&
			run.finishedAt !== undefined &&
			now - run.finishedAt < FINISHED_SUMMARY_MS,
	);
}

export function formatFinishedAgentResult(run: ActiveAgentRun): string {
	const output = `${run.output}\n${run.transcript.join('\n')}`;
	if (
		/\b(?:error|failed|failure|cancelled|incomplete|review_findings)\b/i.test(
			output,
		)
	) {
		return run.status === 'completed'
			? 'result has findings'
			: `result ${run.status}`;
	}
	return 'result passed';
}

export function formatFinishedAgentRow(
	run: ActiveAgentRun,
	waitingCount: number,
	width: number,
): string {
	const wait =
		waitingCount > 0
			? `waiting for ${waitingCount} more agents`
			: 'all agents finished';
	return fitRow(
		`  └ ${run.name} - ${formatFinishedAgentResult(run)} ${wait}`,
		width,
	);
}

/** Includes the separator; a one-row budget shows a row or overflow summary. */
export function inlineAgentLayout(agentCount: number, availableHeight = 7) {
	const budget = Math.max(0, Math.floor(availableHeight));
	const gapHeight = agentCount > 0 && budget > 1 ? 1 : 0;
	const listBudget = Math.max(0, budget - gapHeight);
	const visibleRows = Math.min(
		agentCount,
		INLINE_AGENT_VISIBLE_ROWS,
		Math.max(0, listBudget - (agentCount > listBudget ? 1 : 0)),
	);
	const overflowHeight = agentCount > visibleRows && listBudget > 0 ? 1 : 0;
	const listHeight = visibleRows + overflowHeight;
	return {
		gapHeight,
		visibleRows,
		overflowHeight,
		listHeight,
		height: gapHeight + listHeight,
	};
}

function fitRow(text: string, width: number): string {
	const limit = Math.max(0, Math.floor(width));
	const singleLine = text.replace(/[\r\n\t]/g, ' ');
	if (Bun.stringWidth(singleLine) <= limit) return singleLine;
	if (limit <= 1) return limit === 1 ? '…' : '';
	let result = '';
	for (const {segment} of new Intl.Segmenter().segment(singleLine)) {
		if (Bun.stringWidth(result + segment) > limit - 1) break;
		result += segment;
	}
	return `${result}…`;
}

function displayAgentType(name: string): string {
	return name === 'general' ? 'general-purpose' : name;
}

export function formatInlineAgentRow(
	name: string,
	description: string,
	elapsedSeconds: number,
	tokensUsed: number,
	width: number,
	selected: boolean,
): string {
	const prefix = selected ? '❯ ' : '  ';
	const type = displayAgentType(name).slice(0, AGENT_TYPE_WIDTH);
	const elapsed = formatElapsedTime(elapsedSeconds);
	const tokens = `${formatTokenCount(tokensUsed)} tokens`;
	const telemetry = `${elapsed.padStart(ELAPSED_WIDTH)}${' '.repeat(TELEMETRY_GAP)}${tokens.padStart(TOKENS_WIDTH)}`;
	const fixedWidth =
		prefix.length +
		2 +
		AGENT_TYPE_WIDTH +
		2 +
		DESCRIPTION_TELEMETRY_GAP +
		telemetry.length;
	const descriptionWidth = Math.max(1, width - fixedWidth);
	if (width < fixedWidth + 8) {
		return fitRow(
			`${prefix}◯ ${description} · ${type} · ${elapsed} · ${tokens}`,
			width,
		);
	}
	const clipped =
		description.length > descriptionWidth
			? `${description.slice(0, Math.max(1, descriptionWidth - 1))}…`
			: description;
	return fitRow(
		`${prefix}◯ ${type.padEnd(AGENT_TYPE_WIDTH)}  ${clipped.padEnd(descriptionWidth)}${' '.repeat(DESCRIPTION_TELEMETRY_GAP)}${telemetry}`,
		width,
	);
}

export function formatElapsedTime(elapsedSeconds: number): string {
	let remaining = Math.max(0, Math.floor(elapsedSeconds));
	const days = Math.floor(remaining / 86_400);
	remaining %= 86_400;
	const hours = Math.floor(remaining / 3600);
	remaining %= 3600;
	const minutes = Math.floor(remaining / 60);
	const seconds = remaining % 60;
	return [
		days > 0 ? `${days}d` : '',
		hours > 0 ? `${hours}h` : '',
		minutes > 0 ? `${minutes}m` : '',
		`${seconds}s`,
	]
		.filter(Boolean)
		.join(' ');
}

function formatTokenCount(tokens: number): string {
	const safe = Math.max(0, tokens);
	if (safe < 1000) return String(Math.round(safe));
	if (safe < 1_000_000) return `${(safe / 1000).toFixed(1)}K`;
	return `${(safe / 1_000_000).toFixed(1)}M`;
}

export function inlineAgentSelectionIndex(
	agents: Array<{id: string}>,
	selectedId: string | null,
): number {
	if (selectedId === null) return -1;
	return agents.findIndex(agent => agent.id === selectedId);
}

export function inlineAgentWindowStart(
	agentCount: number,
	selectedIndex: number,
	visibleRows = INLINE_AGENT_VISIBLE_ROWS,
): number {
	if (agentCount <= visibleRows || selectedIndex < 0) return 0;
	return Math.min(
		Math.max(0, selectedIndex - visibleRows + 1),
		agentCount - visibleRows,
	);
}

export function inlineAgentRowsHeight(agentCount: number): number {
	return inlineAgentLayout(agentCount).height;
}

export function inlineAgentListHeight(agentCount: number): number {
	return inlineAgentLayout(agentCount).listHeight;
}

export function formatInlineAgentOverflow(
	start: number,
	agentCount: number,
	visibleRows = INLINE_AGENT_VISIBLE_ROWS,
): string {
	if (visibleRows === 0) return `agents: ${agentCount} · /ps`;
	const above = Math.max(0, start);
	const below = Math.max(0, agentCount - start - visibleRows);
	return [
		above > 0 ? `↑ ${above} more above` : '',
		below > 0 ? `↓ ${below} more below` : '',
	]
		.filter(Boolean)
		.join(' · ');
}

export function InlineAgentRows(props: {
	layout?: ReturnType<typeof inlineAgentLayout>;
	selectedIndex: number;
	onSelect: (index: number) => void;
	onOpen: (agentId: string) => void;
	onNavigate: (direction: 'up' | 'down') => boolean;
}) {
	const terminalDimensions = useTerminalDimensions();
	const agents = () => runningAgentRows();
	const finished = () => finishedAgentRows(activeAgentRuns());
	const layout = createMemo(
		() =>
			props.layout ??
			inlineAgentLayout(agents().length, terminalDimensions().height + 1),
	);
	const rowWidth = () => Math.max(0, terminalDimensions().width - 2);
	const [now, setNow] = createSignal(Date.now());
	const [hoveredIndex, setHoveredIndex] = createSignal(-1);
	const [wheelStart, setWheelStart] = createSignal(0);
	let previousAgentCount = agents().length;
	const windowStart = createMemo(() =>
		props.selectedIndex >= 0
			? inlineAgentWindowStart(
					agents().length,
					props.selectedIndex,
					layout().visibleRows,
				)
			: Math.min(
					wheelStart(),
					Math.max(0, agents().length - layout().visibleRows),
				),
	);
	const labels = createMemo(() => agentDisplayLabels(agents()));
	const visibleAgents = createMemo(() =>
		agents()
			.slice(windowStart(), windowStart() + layout().visibleRows)
			.map((agent, offset) => {
				const index = windowStart() + offset;
				return {agent, index, label: labels()[index] ?? agent.description};
			}),
	);
	onMount(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => clearInterval(timer));
	});
	createEffect(() => {
		const count = agents().length;
		const maxStart = Math.max(0, count - layout().visibleRows);
		if (props.selectedIndex < 0 && count > previousAgentCount) {
			setWheelStart(maxStart);
		} else {
			setWheelStart(start => Math.min(start, maxStart));
		}
		previousAgentCount = count;
	});
	return (
		<Show when={layout().listHeight > 0 || finished().length > 0}>
			<box
				flexDirection="column"
				flexShrink={0}
				height={
					layout().listHeight +
					(finished().length > 0 ? finished().length + 1 : 0)
				}
				overflow="hidden"
				{...({
					onMouseScroll: (event: {
						scroll?: {direction?: 'up' | 'down' | 'left' | 'right'};
					}) => {
						const direction = event.scroll?.direction;
						if (direction === 'up' || direction === 'down') {
							if (props.selectedIndex >= 0) {
								props.onNavigate(direction);
								return;
							}
							const maxStart = Math.max(
								0,
								agents().length - layout().visibleRows,
							);
							setWheelStart(start =>
								direction === 'down'
									? Math.min(maxStart, start + 1)
									: Math.max(0, start - 1),
							);
						}
					},
				} as any)}
			>
				<For each={visibleAgents()}>
					{entry => {
						const agent = entry.agent;
						const rowIndex = () => entry.index;
						const selected = () => props.selectedIndex === rowIndex();
						const active = () => selected() || hoveredIndex() === rowIndex();
						return (
							<box
								height={1}
								flexShrink={0}
								overflow="hidden"
								{...({
									onMouseMove: () => setHoveredIndex(rowIndex()),
									onMouseOut: () => setHoveredIndex(-1),
									onMouseUp: () => {
										props.onOpen(agent.id);
									},
								} as any)}
							>
								<text fg={active() ? colors().primary : colors().secondary}>
									{formatInlineAgentRow(
										agent.name,
										entry.label,
										Math.floor(
											Math.max(0, now() - (agent.startedAt ?? now())) / 1000,
										),
										agent.tokensUsed ?? 0,
										rowWidth(),
										selected(),
									)}
								</text>
							</box>
						);
					}}
				</For>
				<Show when={layout().overflowHeight > 0}>
					<text height={1} flexShrink={0} fg={colors().secondary}>
						{fitRow(
							`  ${formatInlineAgentOverflow(windowStart(), agents().length, layout().visibleRows)}`,
							rowWidth(),
						)}
					</text>
				</Show>
			</box>
		</Show>
	);
}
