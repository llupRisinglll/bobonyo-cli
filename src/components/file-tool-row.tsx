/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {For, Show} from 'solid-js';
import {colors} from '../theme';
import {themeColors} from '../highlight';
import {settledGlyphColor, type RowStatus} from '../row-highlight';
import {MarkdownBrief, type MarkdownBriefRenderer} from './markdown-brief';

/**
 * FILE-WRITE / EDIT tool row (Write / Edit / diff previews).
 *
 * These render as PLAIN components (with the same leading breakline as every
 * other tool row) instead of the markdown pipeline — markdown's `renderNode`
 * path strips inter-block space tokens, so a markdown-rendered file row
 * glues directly under the previous message with NO gap.
 *
 * Content lines arrive pre-tokenized (header + numbered code preview or the
 * old→new diff), so syntax colors are preserved while the row owns its
 * breakline and hover highlight.
 */
export function FileToolRow(props: {
	header: Array<{
		text: string;
		fg?: unknown;
		bg?: unknown;
		attributes?: number;
	}>;
	body: Array<
		Array<{text: string; fg?: unknown; bg?: unknown; attributes?: number}>
	>;
	status: RowStatus;
	glyph: '✦' | '⚙';
	hovered: boolean;
	/** Model brief rendered ONCE above the row (part of this tool entry). */
	brief?: string;
	/** Batch marker: part of a briefed batch (share the glyph/indent). */
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
	const briefed = () => Boolean(props.brief && props.brief.trim());
	const compactBriefTree = () =>
		briefed() &&
		props.header
			.map(chunk => chunk.text)
			.join('')
			.replace(/^[✦⚙]\s*/, '')
			.trimStart()
			.startsWith('└ ');
	const indentContent = () =>
		(briefed() || props.batchBriefed) && !compactBriefTree();
	return (
		<box flexDirection="column" ref={props.onRef}>
			{/* Leading breakline (parity: every other tool row). */}
			<box height={1} />
			{/* Pre-tool brief, integrated with the row: `✦ I will check X`
			    above the content — same entry, same hover region. */}
			<Show when={briefed()}>
				<MarkdownBrief
					text={props.brief ?? ''}
					glyph={glyph}
					hovered={props.hovered}
					md={props.md}
				/>
			</Show>
			<Show when={props.header.length > 0}>
				<box
					flexDirection="row"
					backgroundColor={props.hovered ? hoverBg : undefined}
				>
					{/* With a brief, the row indents to the brief's text
					    column (`✦` + the 2-col gap = 3 cols) and the header
					    chunk's own glyph is stripped — one glyph per batch. */}
					<Show when={indentContent()}>
						<box width={3} />
					</Show>
					<text>
						<For each={props.header}>
							{(c, index) => {
								const text =
									index() === 0 && (briefed() || props.batchBriefed)
										? compactBriefTree()
											? c.text.replace(/^[✦⚙]\s/, '')
											: c.text.replace(/^[✦⚙]\s*/, '')
										: c.text;
								if (!text) return null;
								return (
									<span
										style={{
											fg: c.fg as never,
											bg: c.bg as never,
											attributes: c.attributes,
										}}
									>
										{text}
									</span>
								);
							}}
						</For>
					</text>
				</box>
			</Show>
			<For each={props.body}>
				{line => (
					<box
						flexDirection="row"
						backgroundColor={props.hovered ? hoverBg : undefined}
					>
						<Show when={indentContent()}>
							<box width={3} />
						</Show>
						<text>
							<For each={line}>
								{c => (
									<span
										style={{
											fg: c.fg as never,
											bg: c.bg as never,
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
