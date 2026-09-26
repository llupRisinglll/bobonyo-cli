/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createSignal, For} from 'solid-js';
import {colors} from '../theme';
import {codexResetLabel, type CodexResetCredit} from '../codex-limits';

export function UsageResetModal(props: {
	credits: CodexResetCredit[];
	onSelect: (credit: CodexResetCredit) => void;
	onClose: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [index, setIndex] = createSignal(0);
	const options = () => [...props.credits, null];
	useKeyboard(event => {
		event.preventDefault();
		if (event.name === 'escape') return props.onClose();
		if (event.name === 'up')
			setIndex(value => (value - 1 + options().length) % options().length);
		if (event.name === 'down')
			setIndex(value => (value + 1) % options().length);
		if (event.name === 'return') {
			const selected = options()[index()];
			if (selected) props.onSelect(selected);
			else props.onClose();
		}
		return true;
	});
	const formatExpiry = (seconds?: number) =>
		seconds == null
			? 'No expiration'
			: `Expires ${codexResetLabel(seconds)} ${new Date(seconds * 1000).getFullYear()}.`;
	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width={dimensions().width}
			height={dimensions().height}
			zIndex={3100}
			alignItems="center"
			paddingTop={Math.max(1, Math.floor((dimensions().height - 8) / 2))}
			backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
		>
			<box
				width={Math.min(76, Math.max(52, dimensions().width - 8))}
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
			>
				<text
					fg={colors().primary}
					attributes={createTextAttributes({bold: true})}
				>
					Usage limit resets
				</text>
				<text>
					{props.credits.length} usage limit reset
					{props.credits.length === 1 ? '' : 's'} available.
				</text>
				<box height={1} />
				<For each={options()}>
					{(credit, optionIndex) => (
						<text
							fg={optionIndex() === index() ? colors().primary : colors().text}
						>
							{optionIndex() === index() ? '› ' : '  '}
							{optionIndex() + 1}.{' '}
							{credit
								? `${credit.title}  ${formatExpiry(credit.expiresAt)}`
								: 'Cancel'}
						</text>
					)}
				</For>
				<box height={1} />
				<text fg={colors().secondary}>
					Press enter to confirm or esc to go back
				</text>
			</box>
		</box>
	);
}
