/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {For} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {SUBAGENT_TYPES} from '../tools';

/**
 * Built-in AGENTS modal, the discoverable surface for the default agent
 * personalities (General / Explore). Lists each agent's label + instruction
 * in the same centered-card style as the model/resume pickers; Esc closes.
 * The actual spawning stays with the `agent` tool (the model delegates to
 * `general`/`explore`); this modal is where the user finds them.
 */
export function AgentsModal(props: {onClose: () => void}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const cardWidth = () => Math.min(76, Math.max(54, dims().width - 6));
	const cardHeight = () => {
		const available = Math.max(8, dims().height - 2);
		return Math.min(16, available);
	};
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const entries = Object.entries(SUBAGENT_TYPES);

	useKeyboard(event => {
		if (event.name === 'escape' || event.name === 'return') {
			props.onClose();
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
						Agents
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc close
					</text>
				</box>
				<box height={1} />
				<For each={entries}>
					{([name, agent]) => (
						<box
							flexDirection="column"
							backgroundColor={activeRow().bg}
							paddingX={1}
						>
							<text
								fg={activeRow().fg}
								attributes={bold()}
							>
								{`  ${agent.label} (${name})`}
							</text>
							<text
								fg={activeRow().fg}
								attributes={dim()}
							>
								{`    ${agent.instruction}`}
							</text>
						</box>
					)}
				</For>
				<box height={1} />
				<text fg={colors().secondary} attributes={dim()}>
					The model delegates to these agents via the `agent` tool.
				</text>
			</box>
		</box>
	);
}
