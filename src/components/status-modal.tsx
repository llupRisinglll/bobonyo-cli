/** @jsxImportSource @opentui/solid */
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {For} from 'solid-js';
import {createTextAttributes, RGBA} from '@opentui/core';
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
export function StatusModal(props: {
	rows: StatusRow[];
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	// AUTO-CLOSE GUARD: ignore the opening click's mouse-UP on the backdrop.
	// Time-window based, NOT a one-shot boolean — the flag got consumed by
	// the opening release and swallowed the first real outside click
	// (click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;
	const cardWidth = () => Math.min(76, Math.max(52, dims().width - 8));
	const cardY = () => Math.max(2, Math.floor(dims().height / 4));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const cardHeight = () => props.rows.length + 4;
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
	useKeyboard(event => {
		if (event.name === 'escape') {
			props.onClose();
			return;
		}
		// All other keys are owned by the modal, they must not leak to the
		// input box / history behind it.
		return;
	});
	return (
		<box
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
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						Status
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc close
					</text>
				</box>
				<box height={1} />
				<For each={props.rows}>
					{(row) => (
						<box flexDirection="row" height={1}>
							<text width={18} fg={colors().secondary}>
								{row.label}
							</text>
							<text fg={valueFg(row.valueFg)}>{row.value}</text>
						</box>
					)}
				</For>
			</box>
		</box>
	);
}
