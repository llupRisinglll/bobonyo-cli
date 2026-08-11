/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';

/** Scroll window start for a list index (pure, unit-tested). */
export function listScrollStart(
	index: number,
	total: number,
	visible: number,
): number {
	return Math.max(0, Math.min(index, Math.max(0, total - visible)));
}

export interface SettingsListRow {
	label: string;
	/** Secondary detail line (description, count, path…). */
	value?: string;
	/**
	 * Optional action on Enter (e.g. resume a session). Without it the row
	 * is view-only.
	 */
	onActivate?: () => void;
	activateHint?: string;
}

/**
 * Generic settings LIST modal (the "view" half of the settings flows):
 * a centered card with a scrollable, ↑/↓-navigable row list. This is what
 * rows like Custom commands / Skills / Tools / Sessions / Steering open
 * instead of the old "set value" text prompt — same data, proper UI.
 * Esc closes; a row with an action hint activates on Enter.
 */
export function SettingsListModal(props: {
	title: string;
	rows: SettingsListRow[];
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const [index, setIndex] = createSignal(0);
	const cardWidth = () => Math.min(88, Math.max(62, dims().width - 4));
	const listVisible = () => Math.max(6, Math.min(20, dims().height - 10));
	const cardHeight = () =>
		Math.min(props.rows.length + 5, listVisible() + 5);
	const cardY = () =>
		Math.max(2, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);

	const scrollStart = () =>
		listScrollStart(index(), props.rows.length, listVisible());
	const visible = createMemo(() =>
		props.rows.slice(scrollStart(), scrollStart() + listVisible()),
	);

	useKeyboard(event => {
		if (event.name === 'escape') {
			props.onClose();
			return;
		}
		if (event.name === 'up' || event.name === 'down') {
			setIndex(prev =>
				event.name === 'down'
					? Math.min(props.rows.length - 1, prev + 1)
					: Math.max(0, prev - 1),
			);
			return;
		}
		if (event.name === 'return') {
			const row = props.rows[index()];
			if (row?.onActivate) row.onActivate();
			return;
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
			zIndex={3100}
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
				paddingX={2}
				paddingY={1}
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						{props.title}
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						{props.rows.length} item{props.rows.length === 1 ? '' : 's'} · Esc close
					</text>
				</box>
				<box height={1} />
				<For each={visible()}>
					{(row, i) => (
						<box
							flexDirection="row"
							height={1}
							backgroundColor={
								index() === i() + scrollStart()
									? activeRow().bg
									: undefined
							}
							{...({
								onMouseMove: () => setIndex(i() + scrollStart()),
								onMouseUp: () => {
									if (row.onActivate) row.onActivate();
								},
							} as any)}
						>
							<text
								fg={
									index() === i() + scrollStart()
										? activeRow().fg
										: colors().text
								}
								attributes={bold()}
							>
								{index() === i() + scrollStart() ? '❯ ' : '  '}
								{row.label}
							</text>
							<text fg={colors().secondary}>
								{row.value ? `  ${row.value}` : ''}
							</text>
							<Show when={row.activateHint && index() === i() + scrollStart()}>
								<box flexGrow={1} />
								<text fg={colors().primary} attributes={dim()}>
									{row.activateHint}
								</text>
							</Show>
						</box>
					)}
				</For>
				<Show when={props.rows.length === 0}>
					<text fg={colors().secondary} attributes={dim()}>
						Nothing here yet.
					</text>
				</Show>
			</box>
		</box>
	);
}
