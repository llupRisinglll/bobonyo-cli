/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';

/**
 * Compact-block DETAILS modal. Clicking an expandable compact tally (e.g.
 * `✦ Ran Bash ×10`) opens this scrollable card with the individual call
 * entries, so the user can read the information without the in-place toggle
 * confusing them. Esc / backdrop click closes; ↑/↓/PageUp/PageDn scroll.
 */
export function DetailsModal(props: {
	title: string;
	content: string;
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const cardWidth = () => Math.min(96, Math.max(60, dims().width - 4));
	const cardHeight = () => {
		const available = Math.max(8, dims().height - 2);
		return Math.min(30, available);
	};
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const lines = () => props.content.replace(/\s+$/, '').split('\n');
	const [scroll, setScroll] = createSignal(0);

	useKeyboard(event => {
		if (event.name === 'escape') {
			props.onClose();
			return;
		}
		if (event.name === 'up') {
			setScroll(prev => Math.max(0, prev - 1));
			return;
		}
		if (event.name === 'down') {
			setScroll(prev =>
				Math.min(Math.max(0, lines().length - 1), prev + 1),
			);
			return;
		}
		if (event.name === 'pageup') {
			setScroll(prev => Math.max(0, prev - 10));
			return;
		}
		if (event.name === 'pagedown') {
			setScroll(prev =>
				Math.min(
					Math.max(0, lines().length - 1),
					prev + 10,
				),
			);
		}
	});

	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();

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
				backgroundColor={colors().base}
				paddingX={1}
				paddingY={1}
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						{props.title || 'Tool details'}
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc close · ↑/↓ scroll
					</text>
				</box>
				<box height={1} />
				<box
					flexDirection="column"
					height={cardHeight() - 5}
					border
					borderStyle="rounded"
					borderColor={colors().secondary}
					paddingX={1}
					overflow="hidden"
				>
					<For
						each={lines()
							.slice(scroll(), scroll() + (cardHeight() - 7))
							.map((line, index) => ({
								text: line,
								index: scroll() + index,
							}))}
					>
						{(line) => (
							<text
								fg={colors().text}
								attributes={
									line.index === scroll() ? bold() : undefined
								}
							>
								{line.text || ' '}
							</text>
						)}
					</For>
					<Show when={lines().length > cardHeight() - 7}>
						<text fg={colors().secondary} attributes={dim()}>
							{scroll() + (cardHeight() - 7)}/{lines().length}
						</text>
					</Show>
				</box>
			</box>
		</box>
	);
}
