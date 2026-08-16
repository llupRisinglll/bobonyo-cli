/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {For} from 'solid-js';
import {colors} from '../theme';

/**
 * COMPLETED attention modal.
 *
 * A centered success card that appears AFTER a task finishes while the user
 * is idle (no mouse movement for the idle window) — the user is away and
 * needs the attention grab. ANY activity dismisses it:
 *
 * - a mouse move / click / wheel anywhere (the user came back),
 * - any key — WITHOUT claiming the key (no preventDefault/stopPropagation),
 *   so it keeps flowing to the input and the user can immediately type the
 *   next prompt.
 *
 * The input box and status line stay visible below (parity: every modal
 * overlays only the history region); the card is centered over the
 * transcript.
 */
export function CompletionPopup(props: {
	message: string;
	onDismiss: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const cardWidth = () => Math.min(56, Math.max(44, dims().width - 8));
	/**
	 * The completion line can carry ` · `-joined stat segments (tokens,
	 * cache rate). Each segment becomes its OWN line so a long message never
	 * wraps mid-segment and crowds the dismiss hint; the card grows to fit
	 * title + hint + every segment with a gap between each.
	 */
	const messageParts = () =>
		props.message
			.split(' · ')
			.map(part => part.trim())
			.filter(Boolean);
	const cardHeight = () =>
		Math.min(dims().height - 2, Math.max(8, messageParts().length * 2 + 5));
	const cardY = () =>
		Math.max(2, Math.floor((dims().height - cardHeight()) / 2));
	useKeyboard(() => {
		// Any key dismisses the attention modal — the key is NOT claimed
		// (no preventDefault/stopPropagation), so it continues to the input.
		props.onDismiss();
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
			backgroundColor={RGBA.fromInts(0, 0, 0, 140)}
			{...({
				// The user came back: ANY mouse activity dismisses.
				onMouseMove: () => props.onDismiss(),
				onMouseDown: () => props.onDismiss(),
				onMouseUp: () => props.onDismiss(),
				onMouseScroll: () => props.onDismiss(),
			} as any)}
		>
			<box
				width={cardWidth()}
				height={cardHeight()}
				backgroundColor={colors().base}
				borderStyle="rounded"
				borderColor={colors().primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				alignItems="center"
			>
				<text fg={colors().primary} attributes={bold()}>
					✓ COMPLETED
				</text>
				<box height={1} />
				{/* The completion line ("✦ Worked for …") sits CENTERED, ONE
				    segment per line (each followed by a gap) — a long message
				    with token/cache stats stays readable and never crowds the
				    dismiss hint. */}
				<For each={messageParts()}>
					{part => (
						<box flexDirection="column" alignItems="center">
							<text fg={colors().text}>{part}</text>
							<box height={1} />
						</box>
					)}
				</For>
				<box flexGrow={1} />
				{/* ONE combined dismiss hint: it already says both dismissal
				    paths (any key OR mouse movement), so no separate ESC/key
				    line is needed. */}
				<text fg={colors().secondary} attributes={dim()}>
					move the mouse or press any key to dismiss
				</text>
			</box>
		</box>
	);
}
