/** @jsxImportSource @opentui/solid */
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {For} from 'solid-js';
import {createTextAttributes, RGBA} from '@opentui/core';
import {ModalHeader, modalWheel} from './modal-header';
import {colors} from '../theme';

export interface StatusRow {
	label: string;
	value: string;
	/** Optional value color override (e.g. mode error/warning). */
	valueFg?: 'text' | 'error' | 'warning' | 'success' | 'secondary';
}

/**
 * `/status` MODAL (parity: the settings modal surface), a translucent
 * backdrop over the chat history with a centered card listing every status
 * detail the app tracks. Esc closes; the input box stays visible below.
 */
export function StatusModal(props: {rows: StatusRow[]; onClose: () => void}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	// AUTO-CLOSE GUARD: ignore the opening click's mouse-UP on the backdrop.
	// Time-window based, NOT a one-shot boolean — the flag got consumed by
	// the opening release and swallowed the first real outside click
	// (click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;
	const cardWidth = () => Math.min(76, Math.max(1, dims().width - 2));
	const cardY = () => statusCardY(dims().height, cardHeight());
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const contentWidth = () => Math.max(1, cardWidth() - 4);
	const labelWidth = () =>
		Math.min(36, Math.max(20, ...props.rows.map(row => row.label.length + 2)));
	const valueWidth = () => Math.max(1, contentWidth() - labelWidth());
	const wrappedValue = (value: string): string[] =>
		wrapStatusValue(value, valueWidth());
	const cardHeight = () =>
		Math.min(
			Math.max(1, dims().height - 2),
			props.rows.reduce(
				(total, row) => total + wrappedValue(row.value).length,
				0,
			) + 6,
		);
	const valueFg = (kind: StatusRow['valueFg']) => {
		switch (kind) {
			case 'error':
				return colors().error;
			case 'warning':
				return colors().warning;
			case 'success':
				return colors().success;
			case 'secondary':
				return colors().secondary;
			default:
				return colors().text;
		}
	};
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const handleKey: Parameters<typeof useKeyboard>[0] = event => {
		if (event.name === 'escape') {
			props.onClose();
			return;
		}
		// All other keys are owned by the modal, they must not leak to the
		// input box / history behind it.
		return;
	};
	useKeyboard(handleKey);
	return (
		<box
			onMouseScroll={modalWheel(handleKey)}
			position="absolute"
			left={0}
			top={0}
			width={dims().width}
			// FULL-SCREEN backdrop: the input box stays visible BEHIND the
			// tint (dimmed, not hidden).
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
			>
				<ModalHeader
					width={cardWidth()}
					title={'Status'}
					hint={'Esc close'}
					caps={dims().height >= 9}
				/>
				<box
					flexDirection="column"
					flexGrow={1}
					minHeight={0}
					overflow="hidden"
					paddingX={Math.min(1, Math.floor(cardWidth() / 3))}
					paddingY={dims().height >= 9 ? 1 : 0}
				>
					<box height={1} />
					<For each={props.rows}>
						{row => (
							<For each={wrappedValue(row.value)}>
								{(line, index) => (
									<box flexDirection="row" height={1}>
										<text width={labelWidth()} fg={colors().secondary}>
											{index() === 0 ? `${row.label}:` : ''}
										</text>
										<text fg={valueFg(row.valueFg)}>{line}</text>
									</box>
								)}
							</For>
						)}
					</For>
				</box>
			</box>
		</box>
	);
}

/** Center the status card after async row updates, but keep tiny panes usable. */
export function statusCardY(
	viewportHeight: number,
	cardHeight: number,
): number {
	return Math.max(1, Math.floor((viewportHeight - cardHeight) / 2));
}

/** Wrap status values to the available value column, including long URLs. */
function wrapStatusValue(value: string, width: number): string[] {
	const lines: string[] = [];
	for (const source of value.split('\n')) {
		if (!source) {
			lines.push('');
			continue;
		}
		for (let start = 0; start < source.length;) {
			let end = Math.min(source.length, start + width);
			if (end < source.length) {
				const breakAt = source.lastIndexOf(' ', end);
				if (breakAt > start) end = breakAt;
			}
			lines.push(source.slice(start, end).trimEnd());
			start = source[end] === ' ' ? end + 1 : end;
		}
	}
	return lines.length > 0 ? lines : [''];
}
