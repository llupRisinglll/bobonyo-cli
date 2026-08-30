/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {colors} from '../theme';

export interface ActivityIndicatorProps {
	backgroundCount: number;
	agentCount: number;
	goalActive: boolean;
	onOpen: () => void;
}

/** Sticky top-right summary for running autonomous work. */
export function ActivityIndicator(props: ActivityIndicatorProps) {
	const translucentBase = () => {
		const base = colors().base;
		if (/^#[0-9a-f]{6}$/i.test(base)) {
			const color = RGBA.fromHex(base);
			color.a = 210;
			return color;
		}
		return base;
	};
	const summary = () =>
		[
			props.backgroundCount > 0 ? `bg: ${props.backgroundCount}` : '',
			props.agentCount > 0 ? `agents: ${props.agentCount}` : '',
			props.goalActive ? 'goal: active' : '',
		]
			.filter(Boolean)
			.join(' · ');
	return (
		<box
			position="absolute"
			top={1}
			right={2}
			zIndex={2500}
			border
			borderStyle="rounded"
			borderColor={colors().primary}
			backgroundColor={translucentBase()}
			paddingX={2}
			paddingY={0}
			{...({onMouseUp: props.onOpen} as any)}
		>
			<text
				fg={colors().primary}
				attributes={createTextAttributes({bold: true})}
			>
				{summary()}
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
