/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {For} from 'solid-js';
import type {LiveRowSegments} from '../live-tool-row';
import {colors} from '../theme';
import {themeColors} from '../highlight';
import {glyphColor, type RowStatus} from '../row-highlight';

/**
 * SETTLED tool/thought row — rendered as plain OpenTUI components (boxes +
 * text cells), NOT through the markdown/text-buffer pipeline.
 *
 * This is what makes hover/click behave like the settings rows: the hover
 * highlight is a per-row `backgroundColor` on the BODY rows (the header line
 * never gets one), so there is no overlay geometry to compute and no hit
 * target that changes under the cursor (the "hover doesn't stick" bug). The
 * tokenized chunks are the same ones the old pipeline produced, so colors
 * and spacing are unchanged.
 */
export function SettledToolRow(props: {
	segments: LiveRowSegments;
	status: RowStatus;
	/** Row glyph (`✦` for tools, `⚙` for thoughts). */
	glyph?: '✦' | '⚙';
	hovered: boolean;
	width: number;
	onRef?: (element: unknown) => void;
}) {
	const dim = () => createTextAttributes({dim: true});
	const glyph = glyphColor(props.status, themeColors(colors()));
	const tint = RGBA.fromHex(colors().secondary);
	const hoverBg = RGBA.fromValues(tint.r, tint.g, tint.b, 0.24);
	return (
		<box flexDirection="column" ref={props.onRef}>
			{/* Leading breakline: parity with the settled blank rows between
			    blocks (user msg → blank → tool row). */}
			<box height={1} />
			{/* HEADER line: status-colored glyph + name/detail chunks. The
			    header NEVER carries the hover background. */}
			<box flexDirection="row">
				<text fg={glyph}>{(props.glyph ?? '✦') + ' '}</text>
				<For each={props.segments.header}>
					{(c) => (
						<text fg={c.fg as never} attributes={c.attributes}>
							{c.text}
						</text>
					)}
				</For>
			</box>
			{/* BODY rows: full-width background when hovered (parity: the
			    settings rows highlight the WHOLE row, not just the text). */}
			<For each={props.segments.body}>
				{(line) => (
					<box
						flexDirection="row"
						width={props.width}
						backgroundColor={props.hovered ? hoverBg : undefined}
					>
						<For each={line}>
							{(c) => (
								<text
									fg={c.fg as never}
									attributes={c.attributes}
								>
									{c.text}
								</text>
							)}
						</For>
					</box>
				)}
			</For>
		</box>
	);
}
