/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {For, Show} from 'solid-js';
import type {LiveRowSegments} from '../live-tool-row';
import {colors} from '../theme';
import {themeColors} from '../highlight';
import {settledGlyphColor, type RowStatus} from '../row-highlight';

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
	/** Model brief rendered ONCE above the row (part of this tool entry). */
	brief?: string;
	/** Batch marker: part of a briefed batch (share the glyph/indent). */
	batchBriefed?: boolean;
	onRef?: (element: unknown) => void;
}) {
	const dim = () => createTextAttributes({dim: true});
	const briefed = () => Boolean(props.brief && props.brief.trim());
	// Thought gears are ALWAYS secondary/dim (optional info); tool glyphs
	// follow the status (done = success green). The gear never turns green.
	const glyph = settledGlyphColor(
		props.glyph ?? '✦',
		props.status,
		themeColors(colors()),
	);
	const tint = RGBA.fromHex(colors().secondary);
	const hoverBg = RGBA.fromValues(tint.r, tint.g, tint.b, 0.24);
	return (
		<box flexDirection="column" ref={props.onRef}>
			{/* Leading breakline: parity with the settled blank rows between
			    blocks (user msg → blank → tool row). */}
			<box height={1} />
			{/* Pre-tool brief, integrated with the row: `✦ I will check X`
			    above the header — same entry, same hover region. */}
			<Show when={briefed()}>
				<box
					flexDirection="row"
					width={props.width}
					backgroundColor={props.hovered ? hoverBg : undefined}
				>
					<text fg={glyph}>✦ </text>
					<text>{props.brief}</text>
				</box>
			</Show>
			{/* HEADER line: status-colored glyph + name/detail chunks. The
			    header carries the SAME hover background as the body (the
			    whole bordered Bash entry is ONE hoverable/clickable region);
			    text colors stay untouched so readability is preserved. */}
			<box
				flexDirection="row"
				width={props.width}
				backgroundColor={props.hovered ? hoverBg : undefined}
			>
				{/* With a brief, the brief line carries the entry's single
				    glyph; the header indents to the brief's text column. */}
				<Show when={!briefed() && !props.batchBriefed}>
					<text
						fg={glyph}
						attributes={props.glyph === '⚙' ? dim() : undefined}
					>
						{(props.glyph ?? '✦') + ' '}
					</text>
				</Show>
				<Show when={briefed() || props.batchBriefed}>
					<box width={2} />
				</Show>
				{/* ONE text renderable for the whole header, styled SPANS for
				    the per-chunk colors. A per-cell <text> would give every
				    chunk its own native TextBuffer/TextBufferView/SyntaxStyle
				    handle set — with hundreds of settled rows that exhausts
				    OpenTUI's handle table and "Failed to create SyntaxStyle"
				    crashes the render after /undo. Same pixels, ~10x fewer
				    native handles. */}
				<text>
					<For each={props.segments.header}>
						{(c) => (
							<span
								style={{
									fg: c.fg as never,
									attributes: c.attributes,
								}}
							>
								{c.text}
							</span>
						)}
					</For>
				</text>
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
						<text>
							<For each={line}>
								{(c) => (
									<span
										style={{
											fg: c.fg as never,
											attributes: c.attributes,
										}}
									>
										{c.text}
									</span>
								)}
							</For>
						</text>
					</box>
				)}
			</For>
		</box>
	);
}
