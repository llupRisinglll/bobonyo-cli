/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {For, Show} from 'solid-js';
import {colors} from '../theme';
import {themeColors} from '../highlight';
import {settledGlyphColor, type RowStatus} from '../row-highlight';
import {MarkdownBrief, type MarkdownBriefRenderer} from './markdown-brief';

/**
 * BASH tool row — the entire execution renders as ONE bordered entry:
 *
 *   ✦ ╭─ Bash ─────────────╮
 *     │ $ the command       │
 *     │ output lines        │
 *     ╰────────────────────╯
 *
 * The `✦` glyph stays OUTSIDE the box as the tool indicator (animated while
 * running, status-colored when settled). The border is drawn by OpenTUI's
 * layout engine, so wrapped command/output lines are ALWAYS contained — no
 * hand-drawn border chars that can misalign.
 */
export function BashToolRow(props: {
	/** Tokenized header chunks (the `$ command` line). */
	header: Array<{text: string; fg?: unknown; attributes?: number}>;
	/** Tokenized output lines. */
	body: Array<Array<{text: string; fg?: unknown; attributes?: number}>>;
	status: RowStatus;
	glyph: '✦' | '⚙';
	hovered: boolean;
	/** Model brief rendered ONCE above the box (part of this tool entry). */
	brief?: string;
	/** Batch marker: this box is part of a briefed batch (share the glyph). */
	batchBriefed?: boolean;
	/** Markdown renderer bits for the pre-tool brief (formatted, not raw). */
	md: MarkdownBriefRenderer;
	onRef?: (element: unknown) => void;
}) {
	const dim = () => createTextAttributes({dim: true});
	const glyph = settledGlyphColor(
		props.glyph ?? '✦',
		props.status,
		themeColors(colors()),
	);
	const tint = RGBA.fromHex(colors().secondary);
	const hoverBg = RGBA.fromValues(tint.r, tint.g, tint.b, 0.24);
	return (
		<box flexDirection="column" ref={props.onRef}>
			<box height={1} />
			{/* Pre-tool brief, integrated with the tool entry: `✦ I will
			    check X` above the box — part of the SAME block, so hover/
			    click cover it too. */}
			<Show when={props.brief && props.brief.trim()}>
				<MarkdownBrief
					text={props.brief ?? ''}
					glyph={glyph}
					hovered={props.hovered}
					md={props.md}
				/>
			</Show>
			<box flexDirection="row">
				{/* Glyph OUTSIDE the border (blinks live, status-colored done). */}
				<Show when={!props.brief && !props.batchBriefed}>
					<text fg={glyph} attributes={props.glyph === '⚙' ? dim() : undefined}>
						{(props.glyph ?? '✦') + ' '}
					</text>
				</Show>
				{/* With a brief, the box indents to the brief's text column
				    (`✦ ` = 2 cols) so the border lines up under the brief. */}
				<Show when={props.brief || props.batchBriefed}>
					<box width={2} />
				</Show>
				{/* The bordered box: border + title drawn by OpenTUI, so all
				    wrapped content stays inside by construction. */}
				<box
					flexGrow={1}
					flexShrink={1}
					minWidth={0}
					border
					borderStyle="rounded"
					borderColor={colors().secondary}
					backgroundColor={props.hovered ? hoverBg : undefined}
				>
					{/* Command line: the header chunks carry `$ ` + the
					    bash-highlighted command. */}
					<box flexDirection="row">
						<text>
							<For each={props.header}>
								{c => (
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
					{/* Output lines: secondary, never competes with the
					    command. */}
					<For each={props.body}>
						{line => (
							<box flexDirection="row">
								<text>
									<For each={line}>
										{c => (
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
			</box>
		</box>
	);
}
