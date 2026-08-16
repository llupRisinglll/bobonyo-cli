/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createMemo, For, Show} from 'solid-js';
import {colors} from '../theme';
import {bgTasks, type BackgroundTask} from '../bash';
import {liveRowSegments} from '../live-tool-row';
import {BashToolRow} from './bash-tool-row';
import type {MarkdownBriefRenderer} from './markdown-brief';
import {markdownSyntaxStyleFor} from '../syntax';
import {formatElapsed} from '../state';

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
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	// Running jobs FIRST (live output), then completed ones.
	const jobs = createMemo(() => {
		const tasks = bgTasks();
		return [...tasks]
			.sort((a, b) => Number(b.running) - Number(a.running))
			.slice(0, 8);
	});

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
		const commandLines = wrapCommand(task.command, Math.max(20, width - 4));
		const PREVIEW = 10;
		const outputTail = task.output.slice(-PREVIEW);
		const hidden = task.output.length - outputTail.length;
		const body = [
			...commandLines,
			...outputTail,
			...(hidden > 0
				? [`… +${hidden} more lines`]
				: task.output.length === 0
					? ['(no output yet)']
					: []),
		].join('\n');
		return liveRowSegments(
			body,
			'bashrow',
			task.running ? 'running' : 'done',
			colors(),
			width,
		);
	};

	useKeyboard(event => {
		if (event.name === 'escape') {
			props.onClose();
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
						Background jobs
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc close
					</text>
				</box>
				<box height={1} />
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
										status={task.running ? 'running' : 'done'}
										glyph="✦"
										hovered={false}
										md={md}
									/>
									{/* Meta line: task id · running/exit + elapsed. */}
									<box flexDirection="row" height={1} paddingLeft={4}>
										<text fg={colors().secondary} attributes={dim()}>
											{task.id}
											{' · '}
											{task.running
												? `running (${formatElapsed(
														Math.floor((Date.now() - task.startedAt) / 1000),
													)})`
												: `exit ${task.exitCode ?? '?'} · ${formatElapsed(
														Math.floor(
															((task.completedAt ?? Date.now()) -
																task.startedAt) /
																1000,
														),
													)}`}
										</text>
									</box>
								</box>
							);
						}}
					</For>
				</Show>
			</box>
		</box>
	);
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
