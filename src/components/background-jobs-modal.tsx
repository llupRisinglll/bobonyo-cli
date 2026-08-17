/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {bgTasks, type BackgroundTask} from '../bash';
import {activeAgents} from '../state';
import {liveRowSegments} from '../live-tool-row';
import {BashToolRow} from './bash-tool-row';
import type {MarkdownBriefRenderer} from './markdown-brief';
import {markdownSyntaxStyleFor} from '../syntax';

/**
 * Background-jobs modal (`/ps`, or clicking the floating `background jobs:
 * n` notification). Lists EVERY background bash task — running first, then
 * completed — in the SAME bordered-box format the chat history uses:
 * `$ command` header + the output TAIL (limited lines with a `+N more
 * lines` footer), and the RUNNING jobs' output streams in REALTIME (the
 * list reads bgTasks() reactively; runBash pushes a fresh array on every
 * output tick).
 */
export function BackgroundJobsModal(props: {onClose: () => void}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const cardWidth = () => Math.min(110, Math.max(70, dims().width - 4));
	const cardHeight = () => Math.max(10, Math.min(dims().height - 2, 30));
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();
	const [tab, setTab] = createSignal<'jobs' | 'agents'>('jobs');
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	// Live process list only; snapshot output for reactive row updates.
	const jobs = createMemo(() =>
		bgTasks()
			.filter(task => task.running)
			.slice(0, 8)
			.map(task => ({...task, output: [...task.output]})),
	);

	// The markdown renderer bits the bash rows want (no briefs here, but the
	// component requires the accessor shape).
	const md: MarkdownBriefRenderer = {
		syntaxStyle: () => markdownSyntaxStyleFor(colors()),
		renderNode: () => undefined,
		treeSitter: undefined,
	};

	// One job's live segments in the CHAT-HISTORY bash shape: the command
	// line + the output TAIL (modal preview cap) with a `+N more lines`
	// footer, tokenized exactly like the transcript's BashToolRow so the
	// box, colors and wrapping are identical. Re-runs on every output tick.
	const jobSegments = (task: BackgroundTask) => {
		const width = cardWidth() - 8;
		const contentWidth = Math.max(20, width - 4);
		const commandLines = wrapCommand(task.command, contentWidth);
		const outputTail = task.output.slice(-10);
		const hidden = task.output.length - outputTail.length;
		const outputLines = outputTail.flatMap(line =>
			wrapLine(line, contentWidth),
		);
		const body = [
			...commandLines,
			...outputLines,
			...(hidden > 0
				? [`… +${hidden} more lines`]
				: outputLines.length === 0
					? ['(no output yet)']
					: []),
		].join('\n');
		return liveRowSegments(body, 'bashrow', 'running', colors(), width);
	};

	useKeyboard(event => {
		if (event.name === 'escape') {
			props.onClose();
			return true;
		}
		if (
			event.name === 'left' ||
			event.name === 'right' ||
			event.name === 'tab'
		) {
			setTab(current => (current === 'jobs' ? 'agents' : 'jobs'));
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
				paddingX={2}
				paddingY={1}
				flexDirection="column"
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						{`Process monitor [${tab() === 'jobs' ? '*jobs*' : 'jobs'} | ${tab() === 'agents' ? '*agents*' : 'agents'}]`}
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc close
					</text>
				</box>
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
						>{`Agents (${activeAgents()})`}</text>
					</box>
				</box>
				<Show when={tab() === 'jobs'}>
					<Show
						when={jobs().length > 0}
						fallback={
							<text fg={colors().secondary} attributes={dim()}>
								No background jobs.
							</text>
						}
					>
						<For each={jobs()}>
							{task => {
								const seg = jobSegments(task);
								return (
									<box flexDirection="column">
										<BashToolRow
											header={seg.header}
											body={seg.body}
											status="running"
											glyph="✦"
											hovered={false}
											md={md}
										/>
									</box>
								);
							}}
						</For>
					</Show>
				</Show>
				<Show when={tab() === 'agents'}>
					<text fg={colors().secondary} attributes={dim()}>
						{activeAgents() > 0
							? `${activeAgents()} subagent${activeAgents() === 1 ? '' : 's'} running.`
							: 'No subagents running.'}
					</text>
				</Show>
			</box>
		</box>
	);
}

/** Wrap streamed output so each piece gets its own rendered row. */
function wrapLine(text: string, width: number): string[] {
	if (!text) return [''];
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if (word.length > width) {
			if (current) lines.push(current);
			current = '';
			for (let i = 0; i < word.length; i += width)
				lines.push(word.slice(i, i + width));
		} else if (!current) current = word;
		else if (current.length + 1 + word.length <= width) current += ` ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

/** Wrap a command line to a width (hard-split long words, bash parity). */
function wrapCommand(command: string, width: number): string[] {
	const words = command.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = '';
			}
			for (let i = 0; i < word.length; i += width) {
				lines.push(word.slice(i, i + width));
			}
			continue;
		}
		if (!current) {
			current = word;
		} else if (current.length + 1 + word.length <= width) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines.map((line, index) => `${index === 0 ? '$' : ' '} ${line}`);
}
