/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createSignal, For} from 'solid-js';
import {colors} from '../theme';
import {codexResetLabel, type CodexResetCredit} from '../codex-limits';
import {ModalHeader, modalWheel} from './modal-header';

export function UsageResetModal(props: {
	credits: CodexResetCredit[];
	onSelect: (credit: CodexResetCredit) => void;
	onClose: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [index, setIndex] = createSignal(0);
	const options = () => [...props.credits, null];
	const handleKey: Parameters<typeof useKeyboard>[0] = event => {
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
	};
	useKeyboard(handleKey);
	const cardWidth = () => Math.min(76, Math.max(1, dimensions().width - 2));
	const cardHeight = () =>
		Math.min(Math.max(1, dimensions().height - 2), options().length + 9);
	const formatExpiry = (seconds?: number) =>
		seconds == null
			? 'No expiration'
			: `Expires ${codexResetLabel(seconds)} ${new Date(seconds * 1000).getFullYear()}.`;
	return (
		<box
			onMouseScroll={modalWheel(handleKey)}
			position="absolute"
			left={0}
			top={0}
			width={dimensions().width}
			height={dimensions().height}
			zIndex={3100}
			alignItems="center"
			paddingTop={Math.max(
				0,
				Math.floor((dimensions().height - cardHeight()) / 2),
			)}
			backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
		>
			<box
				width={cardWidth()}
				height={cardHeight()}
				backgroundColor={colors().base}
				overflow="hidden"
			>
				<ModalHeader
					width={cardWidth()}
					title="Usage limit resets"
					caps={dimensions().height >= 9}
				/>
				<box
					flexDirection="column"
					flexGrow={1}
					minHeight={0}
					paddingX={1}
					paddingY={dimensions().height >= 9 ? 1 : 0}
				>
					<text>
						{props.credits.length} usage limit reset
						{props.credits.length === 1 ? '' : 's'} available.
					</text>
					<box height={1} />
					<For each={options()}>
						{(credit, optionIndex) => (
							<text
								fg={
									optionIndex() === index() ? colors().primary : colors().text
								}
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
		</box>
	);
}
