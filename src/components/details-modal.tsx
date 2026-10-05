/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {ModalHeader, modalWheel} from './modal-header';
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
 * minimize scrolling. Chrome reserves a three-row padded title bar, two body
 * padding rows, and an optional scroll counter. Tiny viewports lose margins.
 */
export function detailsCardHeight(
	content: string,
	terminalHeight: number,
): number {
	const available = Math.max(1, terminalHeight - (terminalHeight >= 9 ? 2 : 0));
	const lines = content.replace(/\s+$/, '').split('\n').length;
	return Math.min(available, Math.max(6, lines + 6));
}

/** Modal width never exceeds viewport, including tiny terminals. */
export function detailsCardWidth(title: string, terminalWidth: number): number {
	const available = Math.max(1, terminalWidth - 2);
	return Math.min(title === 'Usage' ? 124 : 96, available);
}

/** Usage cells collapse when two-column cells do not fit. */
export function usageCalendarCellWidth(cardWidth: number): 1 | 2 {
	return cardWidth >= 80 ? 2 : 1;
}
/** Rendered width of graph lines (not summary prose). */
export function usageGraphWidth(content: string, cardWidth: number): number {
	const cellWidth = usageCalendarCellWidth(cardWidth);
	let widest = 0;
	for (const line of content.split('\n')) {
		if (/^(Su|Mo|Tu|We|Th|Fr|Sa)\s/.test(line)) {
			const cells = Math.ceil(Math.max(0, line.length - 3) / 2);
			widest = Math.max(widest, 3 + cells * cellWidth);
		} else if (/^\s{3,}[A-Z][a-z]{2}/.test(line)) {
			widest = Math.max(widest, line.length);
		}
	}
	return widest;
}
/** Pick largest generated month range that fits modal's inner content. */
export function usageVariantIndex(
	cardWidth: number,
	variants: string[],
): number {
	const available = Math.max(1, cardWidth - detailsBodyInset() * 2);
	const index = variants.findIndex(
		variant =>
			usageGraphWidth(
				variant.split('\n---USAGE_PAGE---\n')[0] ?? '',
				cardWidth,
			) <= available,
	);
	return index < 0 ? Math.max(0, variants.length - 1) : index;
}

/** Terminal padding uses cells rather than CSS pixels. */
export function detailsBodyInset(): number {
	return 1;
}

/**
 * Compact-block DETAILS modal. Clicking an expandable compact tally (e.g.
 * grouped activity row opens this scrollable card with the individual call
 * entries, so the user can read the information without the in-place toggle
 * confusing them. Esc / backdrop click closes; ↑/↓/PageUp/PageDn scroll.
 */
function UsageCalendarLine(props: {line: string; width: number}) {
	const cells = () =>
		props.line
			.slice(3)
			.split('')
			.filter((_, index) => index % 2 === 0);
	const fg = (cell: string): string =>
		cell === '█'
			? colors().primary
			: cell === '■'
				? colors().primary
				: cell === '▪'
					? colors().secondary
					: colors().text;
	const cellWidth = usageCalendarCellWidth(props.width);
	return (
		<box flexDirection="row" height={1}>
			<text width={3} fg={colors().secondary}>
				{props.line.slice(0, 2)}
			</text>
			<For each={cells()}>
				{cell => (
					<text
						width={cellWidth}
						fg={fg(cell)}
						attributes={createTextAttributes({bold: true})}
					>
						{cell === '·' ? '·'.padEnd(cellWidth) : '■'.padEnd(cellWidth)}
					</text>
				)}
			</For>
		</box>
	);
}

export function DetailsModal(props: {
	title: string;
	content: string;
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const cardWidth = () => detailsCardWidth(props.title, dims().width);
	const cardHeight = () => detailsCardHeight(visibleContent(), dims().height);
	const cardY = () =>
		Math.max(0, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const lines = () => visibleContent().replace(/\s+$/, '').split('\n');
	const [scroll, setScroll] = createSignal(0);
	const usagePages = createMemo(() => {
		if (props.title !== 'Usage') return [props.content];
		const variants = props.content.split('\n---USAGE_VARIANT---\n');
		const variant =
			variants.length > 1
				? variants[
						Math.min(
							usageVariantIndex(cardWidth(), variants),
							variants.length - 1,
						)
					]
				: variants[0];
		return (variant ?? '').split('\n---USAGE_PAGE---\n');
	});
	const [usagePage, setUsagePage] = createSignal(0);
	const effectiveUsagePage = () =>
		Math.min(usagePage(), Math.max(0, usagePages().length - 1));
	const visibleContent = createMemo(
		() => usagePages()[effectiveUsagePage()] ?? usagePages()[0] ?? '',
	);
	// Like the composer's border glyphs, half-block caps draw within whole cells.
	// They provide symmetric half-cell visual insets, not fractional text layout.
	const headerPaddingY = () => (cardHeight() >= 7 ? 1 : 0);
	const headerHeight = () => 1 + headerPaddingY() * 2;
	const bodyHeight = () => Math.max(0, cardHeight() - headerHeight());
	const bodyPaddingY = () => (bodyHeight() >= 3 ? 1 : 0);
	const contentHeight = () => Math.max(1, bodyHeight() - bodyPaddingY() * 2);
	const bodyInset = () =>
		Math.min(detailsBodyInset(), Math.floor(cardWidth() / 3));
	const contentWidth = () => Math.max(1, cardWidth() - bodyInset() * 2);
	const overflowing = () => lines().length > contentHeight();
	const showCounter = () => overflowing() && contentHeight() >= 2;
	const visibleRows = () => contentHeight() - (showCounter() ? 1 : 0);
	const maxScroll = () => Math.max(0, lines().length - visibleRows());
	const effectiveScroll = () => Math.min(scroll(), maxScroll());
	const headerHint = () => {
		if (contentWidth() < 10) return '';
		if (props.title === 'Usage' && usagePages().length > 1) {
			const page = `[${effectiveUsagePage() + 1}/${usagePages().length}]`;
			return contentWidth() >= 68
				? `${page} ← older · → newer · ↑/↓ scroll · Esc close`
				: contentWidth() >= 28
					? `${page} ←/→ · Esc`
					: 'Esc';
		}
		return contentWidth() >= 48 ? '↑/↓ scroll · Esc close' : 'Esc';
	};
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

	const handleKey: Parameters<typeof useKeyboard>[0] = event => {
		if (event.name === 'escape') {
			props.onClose();
			return;
		}
		if (
			props.title === 'Usage' &&
			(event.name === 'left' || event.name === 'right')
		) {
			event.preventDefault();
			setUsagePage(() =>
				Math.max(
					0,
					Math.min(
						usagePages().length - 1,
						effectiveUsagePage() + (event.name === 'left' ? 1 : -1),
					),
				),
			);
			setScroll(0);
			return;
		}
		if (event.name === 'up') {
			setScroll(Math.max(0, effectiveScroll() - 1));
			return;
		}
		if (event.name === 'down') {
			setScroll(Math.min(maxScroll(), effectiveScroll() + 1));
			return;
		}
		if (event.name === 'pageup') {
			setScroll(Math.max(0, effectiveScroll() - 10));
			return;
		}
		if (event.name === 'pagedown') {
			setScroll(Math.min(maxScroll(), effectiveScroll() + 10));
		}
	};
	useKeyboard(handleKey);

	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();

	return (
		<box
			onMouseScroll={modalWheel(handleKey)}
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
			>
				<ModalHeader
					width={cardWidth()}
					title={props.title || 'Tool details'}
					hint={headerHint()}
					caps={Boolean(headerPaddingY())}
				/>
				<box
					flexDirection="column"
					height={bodyHeight()}
					flexShrink={0}
					overflow="hidden"
					paddingX={bodyInset()}
					paddingY={bodyPaddingY()}
				>
					<For
						each={lines()
							.slice(effectiveScroll(), effectiveScroll() + visibleRows())
							.map((line, index) => ({
								text: line,
								index: effectiveScroll() + index,
							}))}
					>
						{line =>
							props.title === 'Usage' &&
							/^(Su|Mo|Tu|We|Th|Fr|Sa)\s/.test(line.text) ? (
								<UsageCalendarLine line={line.text} width={cardWidth()} />
							) : (
								<box flexDirection="row" height={1}>
									<For each={colorLine(line.text)}>
										{segment => (
											<text fg={segment.fg} attributes={segment.attrs}>
												{segment.text}
											</text>
										)}
									</For>
								</box>
							)
						}
					</For>
					<Show when={showCounter()}>
						<text fg={colors().secondary} attributes={dim()}>
							{effectiveScroll() + visibleRows()}/{lines().length}
						</text>
					</Show>
				</box>
			</box>
		</box>
	);
}
