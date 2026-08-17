/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createSignal, For, Show} from 'solid-js';
import {colors, type Colors} from '../theme';

export interface DetailSegment {
	text: string;
	fg: string;
	attrs?: number;
}

/**
 * Color one details-modal line (pure, unit-tested): `✦ Name(detail)`
 * headers get the glyph secondary, the FULL tool NAME primary bold (the
 * name is the whole word up to the `(` — a non-greedy match colored only
 * the first letter of `Bash(...)`), the rest secondary; `└`/indented
 * output and summaries are secondary dim; everything else is plain text.
 */
export function colorDetailLine(
	line: string,
	colors: Colors,
	attrs: {bold: () => number; dim: () => number},
): DetailSegment[] {
	// Usage calendar rows use Codex-style colored activity squares. Keep
	// labels secondary, then color cells by intensity instead of dimming the
	// whole indented row as generic details output.
	if (/^(Su|Mo|Tu|We|Th|Fr|Sa)\s/.test(line)) {
		const label = line.slice(0, 3);
		const cells = line.slice(3).split('');
		const segments: DetailSegment[] = [
			{text: label, fg: colors.secondary, attrs: attrs.dim()},
		];
		for (const cell of cells) {
			const fg =
				cell === '█'
					? colors.success
					: cell === '■'
						? colors.primary
						: cell === '▪'
							? colors.secondary
							: colors.text;
			segments.push({
				text: cell,
				fg,
				attrs: cell === ' ' ? attrs.dim() : attrs.bold(),
			});
		}
		return segments;
	}
	if (/^\s+Less /.test(line)) {
		return line.split('').map(cell => ({
			text: cell,
			fg:
				cell === '█'
					? colors.success
					: cell === '■'
						? colors.primary
						: cell === '▪'
							? colors.secondary
							: colors.text,
			attrs: cell === ' ' ? attrs.dim() : attrs.bold(),
		}));
	}
	if (/^✦\s*[A-Za-z]/.test(line)) {
		const m = line.match(/^(✦\s*)([A-Za-z][A-Za-z0-9_:-]*)(.*)$/);
		if (m) {
			return [
				{text: m[1] ?? '', fg: colors.secondary, attrs: attrs.dim()},
				{text: m[2] ?? '', fg: colors.primary, attrs: attrs.bold()},
				{text: m[3] ?? '', fg: colors.secondary, attrs: attrs.dim()},
			];
		}
	}
	if (
		/^\s*└/.test(line) ||
		/^\s+/.test(line) ||
		/^\s*⎿/.test(line) ||
		/^\s*```/.test(line)
	) {
		return [{text: line, fg: colors.secondary, attrs: attrs.dim()}];
	}
	return [{text: line, fg: colors.text}];
}

/**
 * Details-card height: fits SHORT content (a 3-line tool row must not open
 * a full-screen card) but caps at the terminal height so LONG details still
 * minimize scrolling. `lines + 6` accounts for the header row, the gap, the
 * content box borders and the card padding. Pure, unit-tested.
 */
export function detailsCardHeight(
	content: string,
	terminalHeight: number,
): number {
	const available = Math.max(8, terminalHeight - 2);
	const lines = content.replace(/\s+$/, '').split('\n').length;
	return Math.min(available, Math.max(6, lines + 6));
}

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
	const cardHeight = () => detailsCardHeight(props.content, dims().height);
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const lines = () => props.content.replace(/\s+$/, '').split('\n');
	const [scroll, setScroll] = createSignal(0);
	// AUTO-CLOSE GUARD: the modal opens on the row's mouse-DOWN; the SAME
	// click's mouse-UP lands on the backdrop and would close it instantly.
	// Only that opening release is ignored — a time window, NOT a one-shot
	// boolean: a one-shot flag gets consumed by the opening release and then
	// swallows the user's FIRST real outside click (click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	// Color each line like the tool rows: `✦ Name(detail)` headers primary,
	// `└`/indented output + `⎿` summaries secondary, everything else text.
	const colorLine = (line: string) =>
		colorDetailLine(line, colors(), {bold, dim});

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
			setScroll(prev => Math.min(Math.max(0, lines().length - 1), prev + 1));
			return;
		}
		if (event.name === 'pageup') {
			setScroll(prev => Math.max(0, prev - 10));
			return;
		}
		if (event.name === 'pagedown') {
			setScroll(prev => Math.min(Math.max(0, lines().length - 1), prev + 10));
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
						{line => (
							<box flexDirection="row">
								<For each={colorLine(line.text)}>
									{segment => (
										<text fg={segment.fg} attributes={segment.attrs}>
											{segment.text}
										</text>
									)}
								</For>
							</box>
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
