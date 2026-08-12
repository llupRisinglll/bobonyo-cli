/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {wrapDescription} from '../description-wrap';
import {wrapText} from '../text-wrap';

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
	/** Insert this text into the user input when the row is activated. */
	insert?: string;
	/** Edit this provider (opencode-style: change base URL / API key). */
	providerId?: string;
	/**
	 * Optional action on Enter (e.g. resume a session). Without it the row
	 * is view-only.
	 */
	onActivate?: () => void;
	activateHint?: string;
}

/** Search filter for the list modal (pure, unit-tested). */
export function filterSettingsRows(
	rows: SettingsListRow[],
	query: string,
): SettingsListRow[] {
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	return rows.filter(
		row =>
			row.label.toLowerCase().includes(q) ||
			(row.value ?? '').toLowerCase().includes(q),
	);
}

function rowLineCount(row: SettingsListRow, width: number): number {
	if (!row.value) return 1;
	return 1 + Math.min(2, wrapText(row.value, width).length);
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
	/** Called when a row with `insert` is activated (type into the input). */
	onInsert?: (text: string) => void;
	/** Called when a row with `providerId` is activated (edit wizard). */
	onEditProvider?: (providerId: string) => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const [index, setIndex] = createSignal(0);
	// AUTO-CLOSE GUARD: modals opened by a row click receive the SAME
	// click's mouse-UP on the backdrop, which would close them instantly.
	// Ignore the first mouse-up after mount (the opening click's release).
	let suppressFirstMouseUp = true;

	const [query, setQuery] = createSignal('');
	const cardWidth = () => Math.min(88, Math.max(62, dims().width - 4));
	// RESPONSIVE: use as much vertical space as the terminal gives us
	// (header 1 + search 1 + gaps 2 + footer 1 + padding 2 ≈ 7 rows of
	// chrome), capped so the card never overflows the screen.
	const listVisible = () =>
		Math.max(3, Math.min(60, dims().height - 9));
	const cardHeight = () => Math.min(listVisible() + 7, dims().height - 2);
	const descWidth = () => Math.max(20, cardWidth() - 8);
	// VERTICALLY CENTERED: (screen height − card height) / 2, never off-screen.
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);

	const filtered = createMemo(() => {
		return filterSettingsRows(props.rows, query());
	});
	const scrollStart = () =>
		listScrollStart(index(), filtered().length, listVisible());
	const visible = createMemo(() => {
		const rows = filtered();
		const start = scrollStart();
		let count = 0;
		let lines = 0;
		for (let i = start; i < rows.length; i++) {
			const rowLines = rowLineCount(rows[i]!, descWidth());
			if (count > 0 && lines + rowLines > listVisible()) break;
			count += 1;
			lines += rowLines;
		}
		return count > 0
			? rows.slice(start, start + count)
			: [rows[start] ?? null].filter((row): row is SettingsListRow => Boolean(row));
	});
	/** Pre-wrapped descriptions so the render and the height agree. */
	const wrapped = (row: SettingsListRow): string[] =>
		wrapDescription(row.value ?? '', descWidth());

	useKeyboard(event => {
		if (event.name === 'escape') {
			if (query()) setQuery('');
			else props.onClose();
			return;
		}
		if (event.name === 'up' || event.name === 'down') {
			setIndex(prev =>
				event.name === 'down'
					? Math.min(Math.max(0, filtered().length - 1), prev + 1)
					: Math.max(0, prev - 1),
			);
			return;
		}
		if (event.name === 'return') {
			const row = filtered()[index()];
			if (row?.providerId) {
				props.onEditProvider?.(row.providerId);
				return;
			}
			if (row?.insert) {
				props.onInsert?.(row.insert);
				return;
			}
			if (row?.onActivate) row.onActivate();
			return;
		}
		if (event.name === 'backspace') {
			setQuery(prev => prev.slice(0, -1));
			setIndex(0);
			return;
		}
		if (event.name === 'space' && !event.ctrl && !event.meta) {
			setQuery(prev => prev + ' ');
			setIndex(0);
			return;
		}
		const char = event.name;
		if (char && char.length === 1 && !event.ctrl && !event.meta) {
			setQuery(prev => prev + char);
			setIndex(0);
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
					if (suppressFirstMouseUp) { suppressFirstMouseUp = false; return; }
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
						{filtered().length} item{filtered().length === 1 ? '' : 's'} · Esc close
					</text>
				</box>
				<box height={1} />
				<box height={1}>
					<text fg={colors().secondary} attributes={dim()}>
						⌕ {query() || 'search…'}
					</text>
				</box>
				<box height={1} />
				<For each={visible()}>
					{(row, i) => (
						<box
							flexDirection="column"
							height={rowLineCount(row, descWidth())}
							backgroundColor={
								index() === i() + scrollStart()
									? activeRow().bg
									: undefined
							}
							{...({
								onMouseMove: () => setIndex(i() + scrollStart()),
								onMouseUp: () => {
									if (row.providerId) {
										props.onEditProvider?.(row.providerId);
										return;
									}
									if (row.insert) {
										props.onInsert?.(row.insert);
										return;
									}
									if (row.onActivate) row.onActivate();
								},
							} as any)}
						>
							<box flexDirection="row" height={1}>
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
								<box flexGrow={1} />
								<Show when={row.activateHint && index() === i() + scrollStart()}>
									<text fg={colors().primary} attributes={dim()}>
										{row.activateHint}
									</text>
								</Show>
							</box>
							<Show when={row.value}>
								<For each={wrapped(row)}>
									{(line) => (
										<text fg={colors().secondary} attributes={dim()}>
											{'  '}
											{line}
										</text>
									)}
								</For>
							</Show>
						</box>
					)}
				</For>
					<Show when={filtered().length === 0}>
						<text fg={colors().secondary} attributes={dim()}>
							No matches.
						</text>
					</Show>
			</box>
		</box>
	);
}
