/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createSignal} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';

/**
 * First-run TRUST dialog (codex-inspired). A centered MODAL with explicit
 * Yes/No options — never the free-text prompt row, which read like the chat
 * input was ready. The directory is explained up front (read/write + run
 * commands), the title uses the WARNING color (a caution, not a chat
 * prompt), and Yes is the default like codex's `[Y/n]`. Esc/No declines
 * (the app must not run against an untrusted directory).
 */
export function TrustModal(props: {
	directory: string;
	onTrust: () => void;
	onDecline: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const [choice, setChoice] = createSignal<'yes' | 'no'>('yes');
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const cardWidth = () => Math.min(64, Math.max(52, dims().width - 8));
	const cardHeight = 11;
	const cardY = () => Math.max(2, Math.floor((dims().height - cardHeight) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight;

	const confirm = (value: 'yes' | 'no'): void => {
		if (value === 'yes') props.onTrust();
		else props.onDecline();
	};

	useKeyboard(event => {
		if (event.name === 'up' || event.name === 'left') {
			setChoice('yes');
			return true;
		}
		if (event.name === 'down' || event.name === 'right') {
			setChoice('no');
			return true;
		}
		if (event.name === 'return' || event.name === 'y') {
			confirm('yes');
			return true;
		}
		if (event.name === 'n') {
			confirm('no');
			return true;
		}
		if (event.name === 'escape') {
			// Esc = decline: the app must NOT keep running against an
			// untrusted directory.
			props.onDecline();
			return true;
		}
		// Every other key is owned by the dialog, nothing leaks to the chat.
		return true;
	});

	const optionRow = (value: 'yes' | 'no', label: string, key: string) => {
		const active = choice() === value;
		return (
			<box
				flexDirection="row"
				height={1}
				backgroundColor={active ? activeRow().bg : undefined}
				{...({
					onMouseMove: () => setChoice(value),
					onMouseUp: () => confirm(value),
				} as any)}
			>
				<text
					width={2}
					fg={active ? activeRow().fg : colors().secondary}
				>
					{active ? '❯' : ' '}
				</text>
				<text
					fg={active ? activeRow().fg : colors().text}
					attributes={active ? bold() : undefined}
				>
					{label}
				</text>
				<text width={2} />
				<text fg={colors().secondary} attributes={dim()}>
					{key}
				</text>
			</box>
		);
	};

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
						props.onDecline();
					}
				},
			} as any)}
		>
			<box
				width={cardWidth()}
				height={cardHeight}
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().warning} attributes={bold()}>
						⚠ Trust this directory?
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc decline
					</text>
				</box>
				<box height={1} />
				<text fg={colors().text}>
					bobonyo can read and write files and run commands here:
				</text>
				<text fg={colors().secondary} attributes={dim()}>
					{props.directory}
				</text>
				<box height={1} />
				{optionRow('yes', 'Yes, trust this directory', 'y')}
				{optionRow('no', 'No, do not trust', 'n')}
				<box height={1} />
				<text fg={colors().secondary} attributes={dim()}>
					↑/↓ select · Enter confirm · Esc decline
				</text>
			</box>
		</box>
	);
}
