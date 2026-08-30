/** @jsxImportSource @opentui/solid */
import {
	createTextAttributes,
	getTreeSitterClient,
	type RenderNodeContext,
	type Renderable,
	type TreeSitterClient,
} from '@opentui/core';
import {createMemo} from 'solid-js';
import type {JSX} from 'solid-js';
import {colors} from '../theme';
import {markdownSyntaxStyleFor} from '../syntax';
import {TRANSCRIPT_GLYPH_GAP} from '../transcript-layout';

/** Shared assistant-reply row used by main and child transcripts. */
export function TranscriptReply(props: {
	content: string;
	streaming?: boolean;
	renderNode?: (
		token: any,
		context: RenderNodeContext,
	) => Renderable | null | undefined;
	treeSitter?: TreeSitterClient;
	onRef?: (element: unknown) => void;
}): JSX.Element {
	const dim = () => createTextAttributes({dim: true});
	const syntaxStyle = createMemo(() => markdownSyntaxStyleFor(colors()));
	let treeSitter = props.treeSitter;
	if (!treeSitter) {
		try {
			treeSitter = getTreeSitterClient();
		} catch {
			treeSitter = undefined;
		}
	}
	return (
		<box flexDirection="column">
			<box height={1} />
			<box flexDirection="row">
				<text fg={colors().secondary} attributes={dim()}>
					✦
				</text>
				<box width={TRANSCRIPT_GLYPH_GAP} />
				<box flexGrow={1} minWidth={0}>
					<markdown
						ref={props.onRef}
						content={props.content}
						streaming={props.streaming ?? false}
						fg={colors().text}
						syntaxStyle={syntaxStyle()}
						internalBlockMode="top-level"
						renderNode={props.renderNode}
						treeSitterClient={treeSitter}
						tableOptions={{style: 'grid', borders: true, widthMode: 'content'}}
					/>
				</box>
			</box>
		</box>
	);
}
