/** @jsxImportSource @opentui/solid */
import {
	type Renderable,
	type RenderNodeContext,
	type SyntaxStyle,
	type TreeSitterClient,
} from '@opentui/core';
import {colors} from '../theme';
import {TRANSCRIPT_GLYPH_GAP} from '../transcript-layout';

/**
 * The markdown renderer bits a tool row needs to render its pre-tool brief
 * through the SAME markdown pipeline the replies use (`<markdown>` with the
 * transcript's syntax style + custom node renderers).
 *
 * The brief is the model's narration BEFORE a tool call ("I'll check X"),
 * and the model writes real markdown in it (`**bold**`, `` `code` ``,
 * lists). Rendering it as a plain `<text>` leaked the raw `**`/backticks;
 * this node formats it inline — while the row is LIVE and once it settles.
 *
 * The brief is STATIC (set when the tool call lands, never re-streamed), so
 * a markdown node here never re-parses per tick — the live-row flicker
 * guard (plain text cells for the streaming BODY) is untouched.
 */
export type BriefRenderNode = (
	token: {type: string; text?: string; lang?: string},
	context: RenderNodeContext,
) => Renderable | undefined | null;

export interface MarkdownBriefRenderer {
	/** Reactive transcript syntax style (the theme memo). */
	syntaxStyle: () => SyntaxStyle;
	/** The history's custom node renderer (tool rows, code blocks, …). */
	renderNode: BriefRenderNode;
	treeSitter: TreeSitterClient | undefined;
}

/**
 * ONE markdown-formatted brief row: `✦ <markdown text>` — the same glyph +
 * padded-container shape a reply uses, so the brief nests under the tool
 * entry with real markdown formatting. The row background is the tool
 * hover highlight (settings-row parity: the whole entry highlights).
 */
export function MarkdownBrief(props: {
	text: string;
	/** Resolved glyph color (status-aware, like the row glyph). */
	glyph: unknown;
	hovered: boolean;
	md: MarkdownBriefRenderer;
}) {
	return (
		<box flexDirection="row">
			<text fg={props.glyph as never}>✦</text>
			{/* REAL 2-column gap after the diamond (reply parity: the reply
			    container pads its content 2 columns after `✦`). A trailing
			    space inside the text cell gets trimmed by the renderer, so
			    the gap is a real spacer box — `✦ ` (one trailing space)
			    rendered the text ONE column too close to the diamond. */}
			<box width={TRANSCRIPT_GLYPH_GAP} />
			<box flexGrow={1} minWidth={0}>
				<markdown
					content={props.text}
					streaming={false}
					fg={colors().text}
					syntaxStyle={props.md.syntaxStyle()}
					internalBlockMode="top-level"
					renderNode={props.md.renderNode}
					treeSitterClient={props.md.treeSitter}
					tableOptions={{style: 'grid', borders: true, widthMode: 'content'}}
				/>
			</box>
		</box>
	);
}
