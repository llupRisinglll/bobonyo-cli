/** @jsxImportSource @opentui/solid */
import {createTextAttributes} from '@opentui/core';
import {colors} from '../theme';

export interface ActivityIndicatorProps {
	backgroundCount: number;
	agentCount: number;
	goalActive: boolean;
	onOpen: () => void;
}

/** Sticky top-right summary for running autonomous work. */
export function ActivityIndicator(props: ActivityIndicatorProps) {
	return (
		<box
			position="absolute"
			top={1}
			right={2}
			zIndex={2500}
			border
			borderStyle="rounded"
			borderColor={colors().primary}
			backgroundColor={colors().base}
			paddingX={2}
			paddingY={0}
			{...({onMouseUp: props.onOpen} as any)}
		>
			<text
				fg={colors().primary}
				attributes={createTextAttributes({bold: true})}
			>
				bg: {props.backgroundCount} · agents: {props.agentCount}
				{props.goalActive ? ' · goal: active' : ''}
			</text>
			<text
				fg={colors().secondary}
				attributes={createTextAttributes({dim: true})}
			>
				/ps · click
			</text>
		</box>
	);
}
