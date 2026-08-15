/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {EFFORT_LEVELS} from './model-modal';

/**
 * Standalone EFFORT picker (opened by bare `/effort`): choose Default (the
 * model's catalog effort) or minimal/low/medium/high for the ACTIVE model.
 * Same options as the model modal's post-selection effort step; every key
 * is owned by the modal.
 */
export function EffortModal(props: {
	model: string;
	provider: string;
	currentEffort?: string;
	defaultEffort?: string;
	onSelect: (level: string) => void;
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	const options = [
		{
			id: 'default',
			label: props.defaultEffort
				? `Default (${props.defaultEffort})`
				: 'Default',
		},
		...EFFORT_LEVELS.map(level => ({id: level, label: level})),
	];
	const initialIndex = props.currentEffort
		? Math.max(
				0,
				options.findIndex(option => option.id === props.currentEffort),
			)
		: 0;
	const [index, setIndex] = createSignal(initialIndex);

	const cardWidth = () => Math.min(64, Math.max(52, dims().width - 8));
	// Autofit: the card is exactly as tall as its content (13 rows), clamped
	// to the window so a short terminal never overflows.
	const cardHeight = Math.min(13, Math.max(10, dims().height - 2));
	const cardY = () => Math.max(2, Math.floor((dims().height - cardHeight) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight;

	useKeyboard(event => {
		if (event.name === 'up' || event.name === 'down') {
			setIndex(prev => {
				const next = event.name === 'down' ? prev + 1 : prev - 1;
				return Math.max(0, Math.min(options.length - 1, next));
			});
			return true;
		}
		if (event.name === 'return') {
			props.onSelect(options[index()]!.id);
			return true;
		}
		if (event.name === 'escape') {
			props.onClose();
			return true;
		}
		return true;
	});

	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width={dims().width}
			height={dims().height}
			zIndex={3050}
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
				height={cardHeight}
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						Select effort
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc close
					</text>
				</box>
				<box height={1} />
				<text fg={colors().text}>{props.model}</text>
				<text fg={colors().secondary} attributes={dim()}>
					{props.provider}
				</text>
				<box height={1} />
				<For
					each={(() => {
						const sel = index();
						return options.map((option, idx) => ({
							option,
							active: idx === sel,
						}));
					})()}
				>
					{({option, active}) => (
						<box
							flexDirection="row"
							height={1}
							backgroundColor={active ? activeRow().bg : undefined}
							{...({
								onMouseMove: () => setIndex(options.indexOf(option)),
								onMouseUp: () => props.onSelect(option.id),
							} as any)}
						>
							<text
								fg={active ? activeRow().fg : colors().text}
								attributes={active ? bold() : undefined}
							>
								{active ? '❯ ' : '  '}
								{option.label}
							</text>
						</box>
					)}
				</For>
				<box height={1} />
				<text fg={colors().secondary} attributes={dim()}>
					↑/↓ select · Enter choose · Esc close
				</text>
			</box>
		</box>
	);
}
