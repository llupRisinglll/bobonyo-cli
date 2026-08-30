/** @jsxImportSource @opentui/solid */
import {createTextAttributes} from '@opentui/core';
import {For, Show} from 'solid-js';
import type {LiveRowSegments} from '../live-tool-row';
import {colors} from '../theme';
import {glyphBlinkOn, spinnerFrame} from '../state';
import {BashToolRow} from './bash-tool-row';
import {FileToolRow} from './file-tool-row';
import {MarkdownBrief, type MarkdownBriefRenderer} from './markdown-brief';
import {themeColors} from '../highlight';
import {settledGlyphColor} from '../row-highlight';
import {
	TRANSCRIPT_GLYPH_GAP,
	TRANSCRIPT_CONTENT_COLUMN,
} from '../transcript-layout';

/**
 * FOOLPROOF live tool-row renderer — the ONLY way running tool rows render.
 *
 * Every row is tokenized ONCE per throttled update by `liveRowSegments` with
 * the SAME tokenizers the settled rows use, then rendered here as PLAIN
 * text cells (never `<markdown>`): OpenTUI repaints only the cells that
 * changed. The old markdown path re-parsed the whole node per update, which
 * was the flicker. The glyph is a separate blinking cell so blink frames
 * never re-tokenize anything.
 *
 * Spacing parity: each row renders a leading BREAKLINE (blank row), exactly
 * like the settled transcript's blank rows between blocks, so the live
 * layout is identical while running and when done.
 *
 * This component deliberately imports NO markdown element. A developer who
 * needs a different live row must change THIS file, and the regression
 * guards in `regression-guards.spec.ts` fail the build if it ever does.
 */
export function LiveToolRows(props: {
	rows: Array<
		LiveRowSegments & {
			lang?: string;
			glyph?: '✦' | '⚙';
			glyphTone?: 'status' | 'muted' | 'text';
			brief?: string;
			batchBriefed?: boolean;
			agentAggregate?: boolean;
		}
	>;
	/** Markdown renderer bits for the pre-tool brief (formatted, not raw). */
	md: MarkdownBriefRenderer;
	width?: number;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	return (
		<For each={props.rows}>
			{row => (
				<box flexDirection="column">
					<Show when={row.lang === 'inforow'}>
						<box height={1} />
						<text
							fg={
								row.glyphTone === 'text'
									? colors().text
									: row.glyphTone === 'muted'
										? colors().secondary
										: settledGlyphColor(
												row.glyph!,
												'running',
												themeColors(colors()),
											)
							}
						>
							{row.glyph}
						</text>
						<box width={TRANSCRIPT_GLYPH_GAP} />
						<text fg={colors().text}>
							<For each={row.header}>{chunk => chunk.text}</For>
							<For each={row.body}>
								{line => (
									<>
										{'\n'}
										<For each={line}>{chunk => chunk.text}</For>
									</>
								)}
							</For>
						</text>
					</Show>
					{/* RUNNING bash rows stream INSIDE the same bordered box
					    the settled row uses (the border is drawn by OpenTUI,
					    so streamed/wrapped content always stays inside). */}
					<Show when={row.lang === 'bashrow'}>
						<BashToolRow
							header={row.header}
							body={row.body}
							status="running"
							glyph="✦"
							hovered={false}
							brief={row.brief}
							batchBriefed={row.batchBriefed}
							md={props.md}
							width={props.width}
						/>
					</Show>
					<Show when={row.lang === 'filerow' || row.lang === 'filediff'}>
						<FileToolRow
							header={row.header}
							body={row.body}
							status="running"
							glyph="✦"
							hovered={false}
							brief={row.brief}
							batchBriefed={row.batchBriefed}
							md={props.md}
						/>
					</Show>
					<Show
						when={
							row.lang !== 'bashrow' &&
							row.lang !== 'filerow' &&
							row.lang !== 'filediff' &&
							row.lang !== 'inforow'
						}
					>
						{/* Leading breakline ONLY for the generic path: the
						    bash/file row components (BashToolRow,
						    FileToolRow) render their OWN leading breakline
						    (parity with their settled renderers). A
						    breakline here AND in the component doubled the
						    blank row while running — the "extra breakline"
						    that vanished when the row settled. */}
						<box height={1} />
						<Show when={row.brief && row.brief.trim()}>
							{/* Pre-tool brief (parity: the settled row and the
							    bash/file rows render it through the SAME
							    markdown pipeline; a running generic row must
							    paint identically to its settled form). */}
							<MarkdownBrief
								text={row.brief ?? ''}
								glyph={settledGlyphColor('✦', 'running', themeColors(colors()))}
								hovered={false}
								md={props.md}
							/>
						</Show>
						<box flexDirection="row">
							{/* Blinking secondary glyph, width-stable (the
							    hidden frame keeps a space). HIDDEN for
							    briefed/batch rows — the brief line carries
							    the entry's single glyph (bash/file parity). */}
							<Show
								when={
									(!row.brief || row.lang === 'agentrow') && !row.batchBriefed
								}
							>
								<text fg={colors().secondary} attributes={dim()}>
									{glyphBlinkOn(spinnerFrame()) ? '✦' : ' '}
								</text>
								<box width={TRANSCRIPT_GLYPH_GAP} />
							</Show>
							{/* Briefed/batch rows indent to the brief's text
							    column (col 3: `✦` + 2-col gap) — width 3, the
							    bash/file rows use the same box. */}
							<Show
								when={
									(row.brief && row.lang !== 'agentrow') || row.batchBriefed
								}
							>
								<box width={TRANSCRIPT_CONTENT_COLUMN} />
							</Show>
							{/* ONE text renderable per header/body line,
							    styled SPANS for the per-chunk colors. The
							    old per-cell <text> gave every chunk its own
							    native TextBuffer/TextBufferView/SyntaxStyle
							    handle set — running rows stream updates that
							    churn those handles, and with many settled
							    rows the handle table exhausts ("Failed to
							    create SyntaxStyle"). Same pixels, ~10x fewer
							    handles. */}
							<text>
								<For each={row.header}>
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
						<For each={row.body}>
							{line => (
								<box flexDirection="row">
									{/* Body chunks carry a two-column branch lead;
									    one fixed spacer keeps its visible content at
									    the same column as every row header. */}
									<box width={TRANSCRIPT_CONTENT_COLUMN - 2} />
									<text>
										<Show
											when={
												row.agentAggregate &&
												line.some(chunk => chunk.text.includes('agent:'))
											}
										>
											<span style={{fg: colors().secondary as never}}>
												{glyphBlinkOn(spinnerFrame() + agentBlinkPhase(line))
													? '✦'
													: ' '}{' '}
											</span>
										</Show>
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
					</Show>
				</box>
			)}
		</For>
	);
}
/** Stable blink phase per reviewer, so aggregate rows animate independently. */
function agentBlinkPhase(line: Array<{text: string}>): number {
	const value = line.map(chunk => chunk.text).join('');
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return Math.abs(hash) % 8;
}
