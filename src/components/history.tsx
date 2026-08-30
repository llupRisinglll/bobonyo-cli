/** @jsxImportSource @opentui/solid */
import {
	CodeRenderable,
	RGBA,
	createTextAttributes,
	getTreeSitterClient,
	type RenderNodeContext,
	type MouseEvent,
	type RenderContext,
	type ScrollBoxRenderable,
	type TreeSitterClient,
	createMarkdownCodeBlockRenderer,
} from '@opentui/core';
import {useKeyboard, useRenderer, useTerminalDimensions} from '@opentui/solid';
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from 'solid-js';
import {
	activeAgents,
	activeAgentRuns as globalActiveAgentRuns,
	activeEndpoint,
	expandedBlocks,
	gearGlyph,
	hoverRow,
	thinkingMode,
	liveOutputs as globalLiveOutputs,
	messages as globalMessages,
	mode,
	reasoning as globalReasoning,
	running as globalRunning,
	setHoverRow,
	setThoughtExpanded,
	setToolsExpanded,
	spinnerFrame,
	streaming as globalStreaming,
	thinkingElapsed,
	turnElapsed,
	titleShape,
	workingDots,
	formatElapsed,
	thoughtExpanded,
	toggleToolBlock,
	toolsExpanded,
	setDetailsOpen,
	setDetailsTitle,
	setDetailsContent,
	anyModalOpen,
	compacting,
	compactingLabel,
	type ChatMessage,
} from '../state';
import {markdownSyntaxStyleFor} from '../syntax';
import {activityGroupForTool, formatActivityMessages} from '../activity-groups';
import {
	fence,
	formatOutputTail,
	formatToolEntry,
	rowLanguage,
} from '../tool-display';
import {
	liveRowSegments,
	shouldRenderRunningToolMessage,
	type LiveRowSegments,
} from '../live-tool-row';
import {stableSettledBlocks, type SettledBlock} from '../settled-block-cache';
import {
	disabledScroll,
	resolveScrollAcceleration,
} from '../scroll-acceleration';
import {formatCount, formatDuration} from '../format';
import {LiveToolRows} from './live-tool-rows';
import {SettledToolRow} from './settled-tool-row';
import {BashToolRow} from './bash-tool-row';
import {FileToolRow} from './file-tool-row';
import {TranscriptReply} from './transcript-reply';
import {formatSubagentCompactTail} from '../subagent-tail';
import type {MarkdownBriefRenderer} from './markdown-brief';
import {
	tokenizeAgentRow,
	tokenizeBanner,
	tokenizeBashRow,
	tokenizeDiffRow,
	tokenizeFileDiff,
	tokenizeFileRow,
	tokenizeErrorRow,
	tokenizeStatusRow,
	tokenizeThought,
	tokenizeTaskRow,
	tokenizeToolRow,
	tokenizeCommandRow,
	tokenizeWarningRow,
	tokenizeUserMessage,
	type RowStatus,
} from '../row-highlight';
import {colors} from '../theme';
import {buildBannerBox, hasConversation} from '../banner';
import {historyFillWidth, toolRowFillWidth} from '../history-width';
import {wrapText} from '../text-wrap';

const PREVIEW_LINES = 3;
/**
 * Fence languages rendered as PLAIN COMPONENTS (`SettledToolRow`) instead
 * of markdown. These are the hover/click targets; markdown's text buffer is
 * hostile to mouse events (hit-target changes on hover + row-wide bg bleed),
 * so anything interactive must be a component. File previews, user messages,
 * warnings and replies keep the markdown pipeline.
 */
const COMPONENT_ROW_LANGS = new Set([
	'toolrow',
	'bashrow',
	'diffrow',
	'agentrow',
	'grouprow',
	'thought',
	'taskrow',
	'commandrow',
	'filerow',
	'filediff',
]);

/**
 * Pure hit-test for one settled block: map a terminal row to a DOC row
 * inside the block's span. Uses the ACTUAL laid-out height (the pre-tool
 * brief and the bash box borders render rows absent from docLines) and
 * CLAMPS into the block's doc span so those extra rows never spill into
 * the next block — that misalignment broke hover/click below every
 * briefed entry (visible on resume). Pure + unit-tested.
 */
export function hitTestBlock(
	entry: {
		ref: {screenY: number; height?: number} | null;
		start: number;
		rows: number;
	},
	y: number,
): number | null {
	if (!entry.ref) return null;
	const top = entry.ref.screenY;
	const height = entry.ref.height ?? entry.rows;
	if (y < top || y >= top + height) return null;
	return Math.min(
		entry.start + Math.max(0, y - top),
		entry.start + Math.max(0, entry.rows - 1),
	);
}

/** Pick deepest matching entry when native bounds overlap during layout. */
export function pickHoveredEntry<
	T extends {ref: {screenY: number; height?: number} | null; key: string},
>(entries: T[], y: number): T | null {
	let picked: T | null = null;
	for (const entry of entries) {
		if (
			hitTestBlock({...entry, start: 0, rows: Number.MAX_SAFE_INTEGER}, y) ===
			null
		)
			continue;
		if (!picked || entry.ref!.screenY >= picked.ref!.screenY) picked = entry;
	}
	return picked;
}

type RenderToken = {type: string; text?: string; lang?: string};

/**
 * Welcome banner, a simple Codex/Claude-style box with the small mascot art
 * on the left (parity: the user's requested `★ ╭◕‿◕╮ ╰───╯`), showing the
 * name/version, model, directory and permissions.
 */
function buildWelcomeBanner(titleShape: string): string {
	const model = activeEndpoint().model;
	const permissions = mode() === 'yolo' ? 'YOLO mode' : `${mode()} mode`;
	return (
		'```banner\n' +
		buildBannerBox({
			titleShape,
			model,
			permissions,
			cwd: process.cwd(),
		}) +
		'```\n\n' +
		'  Tip: Press **ctrl+p** for settings & commands · type **/** for commands · **@** to mention files'
	);
}

/** Extract `<path>` from a row's first line (`✦ Write <path>`). */
function rowPath(text: string): string {
	const line = text.split('\n')[0] ?? '';
	return line.replace(/^[✦⚙]\s*[A-Za-z ]+?\s+/, '').trim();
}

/**
 * C11: ` ```diff ` fences render through OpenTUI's native DiffRenderable,
 * added/removed lines get green/red backgrounds with colored +/- signs,
 * matching nanocoder's DiffView look while the code keeps its own syntax
 * colors. Non-diff fences keep the default code rendering.
 */
/**
 * Chat history as ONE reactive document rendered by the real OpenTUI
 * `<markdown>` renderable. The OpenTUI 0.4.5 solid reconciler corrupts
 * multi-element rows on rapid async updates (verified live), so the whole
 * transcript is derived in a memo and streamed into a single markdown node,
 * headings/lists/code/tables format live while the stream grows, and the
 * settled transcript is byte-identical in shape.
 */
export function attachmentMarkerFromLanguage(language: string): string {
	return language.match(/(?:^|:)a([^:]*)/)?.[1] ?? '';
}

export interface HistoryProps {
	height?: number;
	width?: number;
	/** Optional transcript sources for embedded child conversations. */
	messages?: () => ChatMessage[];
	running?: () => boolean;
	streaming?: () => string;
	reasoning?: () => string;
	liveOutputs?: () => Record<string, string>;
	activeAgentRuns?: typeof globalActiveAgentRuns;
	/** Embedded views omit welcome UI and do not consume modal navigation keys. */
	embedded?: boolean;
	/**
	 * Terminal-like input placement: reports the REAL rendered content
	 * height (banner + transcript rows, measured from the laid-out scrollbox
	 * children) so the parent can size the history to min(content, cap) and
	 * let the input ride below the banner, sliding down as the conversation
	 * grows until it sticks at the bottom.
	 */
	onContentHeight?: (height: number) => void;
}

export function History(props: HistoryProps) {
	const renderer = useRenderer();
	const messages = props.messages ?? globalMessages;
	const running = props.running ?? globalRunning;
	const streaming = props.streaming ?? globalStreaming;
	const reasoning = props.reasoning ?? globalReasoning;
	const liveOutputs = props.liveOutputs ?? globalLiveOutputs;
	const activeAgentRuns = props.activeAgentRuns ?? globalActiveAgentRuns;
	// Details belong to this mounted transcript only. Rebuilding the settled
	// view clears stale session/compaction entries instead of retaining full
	// tool output and reasoning in a process-global map forever.
	const compactDetails = new Map<string, string>();
	const hoverTint = RGBA.fromHex(colors().secondary);
	const hoverBackground = RGBA.fromValues(
		hoverTint.r,
		hoverTint.g,
		hoverTint.b,
		0.24,
	);
	const dim = () => createTextAttributes({dim: true});
	const replyWidth = () =>
		props.width === undefined ? undefined : Math.max(1, props.width - 3);
	// OpenTUI's built-in tree-sitter grammars (ts/js/md) highlight fenced
	// code blocks, attach the client so ` ```typescript ` previews get real
	// syntax colors instead of a hand-rolled tokenizer. In the COMPILED
	// binary the grammar WASM files can't be resolved from node_modules,
	// fall back to a no-op client so the app still runs (plain code blocks).
	let treeSitter: TreeSitterClient | undefined;
	try {
		treeSitter = getTreeSitterClient();
	} catch {
		treeSitter = {
			highlightOnce: async () => ({highlights: []}),
		} as unknown as TreeSitterClient;
	}
	const terminalDimensions = useTerminalDimensions();
	// The container (tool/thought block) under the cursor, its rows get a
	// persistent background highlight and it toggles on click.
	const [hoveredBlock, setHoveredBlock] = createSignal<string | null>(null);
	let hoveredBlockRef: string | null = null;
	let scrollRef: ScrollBoxRenderable | null = null;
	let lineMap: Array<string | undefined> = [];
	let renderText: string[] = [];
	let blockRanges: Array<{key: string; start: number; end: number}> = [];
	let currentBlock: {key: string; start: number} | null = null;
	const syntaxStyle = createMemo(() => markdownSyntaxStyleFor(colors()));
	// Code preview CodeRenderable: built-in tree-sitter + line-number recolors.
	const codePreview = (token: RenderToken, filetype: string): CodeRenderable =>
		new CodeRenderable(renderer as unknown as RenderContext, {
			content: token.text ?? '',
			filetype,
			syntaxStyle: syntaxStyle(),
			treeSitterClient: treeSitter,
			onChunks: chunks =>
				chunks.map(chunk => {
					// A chunk that is ONLY a line number (`  1 `) becomes
					// secondary, it's the preview gutter, not a code number.
					if (/^\s*\d+\s*$/.test(chunk.text)) {
						return {...chunk, fg: RGBA.fromHex(colors().secondary)};
					}
					return chunk;
				}),
		});
	const diffCodeBlockRenderer = createMarkdownCodeBlockRenderer({
		diff: token =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text,
				filetype: 'diff',
				syntaxStyle: syntaxStyle(),
			}),
		banner: token =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text,
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeBanner(token.text ?? '', colors()),
			}),
	});
	/** Custom tool-row renderers, tokenize the row into themed chunks. */
	const rowRenderers: Record<
		string,
		(token: RenderToken, status: RowStatus) => CodeRenderable
	> = {
		toolrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeToolRow(token.text ?? '', status, colors()),
			}),
		bashrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeBashRow(token.text ?? '', status, colors()),
			}),
		filerow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeFileRow(
						token.text ?? '',
						rowPath(token.text ?? ''),
						status,
						colors(),
						historyFillWidth(terminalDimensions().width ?? 80),
					),
			}),
		filediff: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeFileDiff(
						token.text ?? '',
						rowPath(token.text ?? ''),
						status,
						colors(),
						historyFillWidth(terminalDimensions().width ?? 80),
					),
			}),
		diffrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeDiffRow(token.text ?? '', status, colors()),
			}),
		agentrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeAgentRow(token.text ?? '', status, colors()),
			}),
		grouprow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeToolRow(token.text ?? '', status, colors()),
			}),
		thought: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeThought(token.text ?? '', status, colors()),
			}),
		usermsg: token =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeUserMessage(
						token.text ?? '',
						colors(),
						historyFillWidth(terminalDimensions().width ?? 80),
						// Find attachment metadata explicitly. Resize metadata may
						// precede it (`w120:a13`), so positional parsing is wrong.
						attachmentMarkerFromLanguage(String(token.lang ?? '')),
					),
			}),
		commandrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeCommandRow(token.text ?? '', status, colors()),
			}),
		taskrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeTaskRow(token.text ?? '', status, colors()),
			}),
		// Error rows (`⚠ …`) render in the error color.
		errorrow: (token, _status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeErrorRow(token.text ?? '', colors()),
			}),
		warningrow: token =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeWarningRow(token.text ?? '', colors()),
			}),
		// `/status` block: custom fenced row so the `model[effort]` brackets
		// survive, the markdown/tree-sitter pipeline parses a bare `[x]` as
		// a link-ish token and drops the brackets.
		statusrow: (token, _status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeStatusRow(token.text ?? '', colors()),
			}),
		// Real-language code previews: built-in tree-sitter highlights, with
		// the leading LINE NUMBERS re-colored to secondary (they're parsed as
		// `number` tokens otherwise and would render success-green).
		typescript: token => codePreview(token, 'typescript'),
		javascript: token => codePreview(token, 'javascript'),
		markdown: token => codePreview(token, 'markdown'),
	};
	// NOTE: OpenTUI 0.4.5 only applies `markup.heading` to TABLE headers;
	// regular heading blocks render unstyled. A manual TextRenderable for
	// heading tokens caused layout instability in the single-markdown stream
	// (the welcome line rendered as an interleaved "Welcomeetoonanocoder-…"
	// artifact), so headings keep the default rendering for now.
	const renderNode = (token: RenderToken, context: RenderNodeContext) => {
		const lang = String(token.lang ?? '');
		const parts = lang.split(':');
		const kind = parts[0] ?? lang;
		const status = (parts[1] ?? 'done') as RowStatus;
		const custom = rowRenderers[kind];
		if (custom) {
			try {
				return custom(token, status);
			} catch (error) {
				return undefined;
			}
		}
		return diffCodeBlockRenderer?.(
			token as Parameters<NonNullable<typeof diffCodeBlockRenderer>>[0],
			context,
		);
	};
	// The pre-tool brief (model narration before a tool call) renders
	// through the SAME markdown pipeline as the replies — real markdown
	// formatting (`**bold**`, `` `code` ``, lists) — in the LIVE rows and
	// once settled. The brief is STATIC (never re-streamed), so the
	// markdown node can't re-parse per tick (the live flicker guard is
	// about the streaming BODY, which stays plain text cells).
	const briefMarkdown: MarkdownBriefRenderer = {
		syntaxStyle,
		renderNode,
		treeSitter,
	};
	// One source of truth for LIVE ownership. Global `running()` only means
	// the model turn continues; it does NOT mean every tool from that turn is
	// still live. Completed tools move straight to settled history while the
	// model keeps working. A live duplicate with the same id wins.
	const liveToolIds = createMemo(
		() =>
			new Set(
				messages()
					.filter(message => message.role === 'tool' && message.running)
					.map(message => message.toolId)
					.filter((id): id is string => Boolean(id)),
			),
	);

	// C1: PageUp/PageDn scroll the transcript by one viewport (wheel is
	// handled natively by the scrollbox). Sticky-bottom re-engages on the
	// next content append. While a modal (settings) is open the modal owns
	// the keys, scrolling the history behind it would be a leak.
	useKeyboard(event => {
		if (!props.embedded && anyModalOpen()) {
			// FOOLPROOF MODAL ISOLATION: global key listeners run BEFORE the
			// renderable handlers (the history scrollbox's native arrow-key
			// scrolling). preventDefault stops the key from reaching the
			// scrollbox, so arrow keys used to navigate a modal NEVER scroll
			// the chat behind it.
			event.preventDefault();
			return false;
		}
		if (event.name === 'pageup') {
			scrollRef?.scrollBy({x: 0, y: -1}, 'viewport');
			return true;
		}
		if (event.name === 'pagedown') {
			scrollRef?.scrollBy({x: 0, y: 1}, 'viewport');
			return true;
		}
		return false;
	});
	// Rendered blocks: consecutive non-reply parts share ONE markdown node;
	// every REPLY gets its OWN padded node so the response content sits in a
	// container that can never break its left-side gap (the hard requirement:
	// responses never render at column 0, even when OpenTUI re-wraps text or
	// normalizes block constructs). Mouse mapping stays global via per-block
	// row offsets.
	const blockRefs: Array<{
		ref: {screenY: number; height?: number} | null;
		start: number;
		rows: number;
		key: string;
		/** The stable block this entry maps to (carry-over refs across memo
		 *  recomputes — see the memo below). */
		block?: SettledBlock;
	}> = [];
	/** Global rendered-row offset of the SETTLED content (live rows follow). */
	let baseRowCount = 0;
	/** The live streaming markdown node's ref (last block while running). */
	let liveThoughtRef: {screenY: number} | null = null;
	let liveReplyRef: {screenY: number} | null = null;
	/** Rendered line count of the live THOUGHT (the reply follows it). */
	let liveThoughtLines = 0;
	/**
	 * SETTLED blocks only: consecutive non-reply parts share ONE markdown
	 * node; every REPLY gets its OWN padded node. The memo reads NO ticker
	 * signals (spinnerFrame/thinkingElapsed), so during streaming the settled
	 * blocks keep IDENTITY and OpenTUI never re-renders them, the whole
	 * chatbox flashing with "christmas lights" was the settled blocks being
	 * rebuilt every 100ms tick.
	 */
	const settledBlockCache = new Map<string, SettledBlock>();
	const settledBlocks = createMemo(() => {
		compactDetails.clear();
		// Reading the width here (a signal) makes the memo re-run on terminal
		// resize; the marker below then CHANGES the doc so OpenTUI re-creates
		// the full-row-bg code blocks instead of keeping the old-width chunks.
		const fillWidth = historyFillWidth(terminalDimensions().width ?? 80);
		const parts: Array<{
			text: string;
			key?: string;
			kind: 'md' | 'reply';
			brief?: string;
		}> = [];
		let anonymousBlock = 0;
		const pushBlock = (
			text: string,
			key?: string,
			kind: 'md' | 'reply' = 'md',
			brief?: string,
		) => {
			parts.push({
				// Full-row-bg fences carry the current width in the opener,
				// a resize changes the marker → the markdown block re-parses →
				// the CodeRenderable re-highlights and onChunks pads to the
				// NEW width (without this the old padding lingered until any
				// other re-render).
				text: text.replace(
					/^(```+)(filediff|usermsg)(:[^:\n]+)/,
					(_match, fenceChar, kind, status) =>
						`${fenceChar}${kind}${status}:w${fillWidth}`,
				),
				key: key ?? `entry-${anonymousBlock++}`,
				kind,
				brief,
			});
		};
		const all = messages();
		// Keep latest task snapshot expanded per user turn. Earlier task
		// updates in same turn collapse; older turns retain their final list.
		const latestTaskMessages = new Set<ChatMessage>();
		let taskSeenInTurn = false;
		for (let index = all.length - 1; index >= 0; index--) {
			const candidate = all[index]!;
			if (candidate.role === 'user') {
				taskSeenInTurn = false;
				continue;
			}
			if (candidate.role !== 'tool' || candidate.tool?.name !== 'write_tasks')
				continue;
			if (!taskSeenInTurn && !candidate.running)
				latestTaskMessages.add(candidate);
			taskSeenInTurn = true;
		}
		const seenToolIds = new Set<string>();
		// Welcome block (parity: nanocoder shows a welcome message on an
		// empty conversation instead of a blank transcript). SYSTEM logs
		// (e.g. `Session renamed to "x"`) carry a `kind` and must NOT hide
		// the banner — only real conversation rows do.
		if (!props.embedded && !hasConversation(all) && !running()) {
			pushBlock(buildWelcomeBanner(titleShape()));
		}
		for (let i = 0; i < all.length; i++) {
			const message = all[i]!;
			if (message.role === 'user') {
				// Command/skill workflow bodies are model-only guidance. Transcript
				// shows only what user typed; never dump `Triggered a Command` plus
				// hundreds of hidden workflow lines into chat.
				if (message.command) {
					const visible = commandVisibleText(message.command, message.content);
					pushBlock(fence('usermsg', 'done', `❯ ${visible}`));
					continue;
				}
				// User messages render as a surface-filled `❯ content` block
				// (parity: nanocoder's arrow-style UserMessage background),
				// capped at USER_PREVIEW_LINES with a clickable
				// `+N more lines` footer that opens the full text.
				const userKey = `user-${i}`;
				compactDetails.set(userKey, message.content);
				const userBlock = renderUserBlock(message, userKey);
				pushBlock(userBlock.text, userBlock.blockKey);
			} else if (message.role === 'tool') {
				// review_changes is a fan-out coordinator. Its individual reviewer
				// calls are materialized as real agent tool rows; never paint the
				// coordinator's aggregate result as one fake row.
				if (message.tool?.name === 'review_changes') continue;
				// A tool id is unique per call. Defensive dedupe prevents a
				// stale live/settled transition or resume conversion from painting
				// the same command and pre-tool brief twice.
				if (message.toolId) {
					if (seenToolIds.has(message.toolId)) continue;
					seenToolIds.add(message.toolId);
				}
				// Row state owns placement; global running() only means model turn
				// continues. Completed commands stay visible during Working. A live
				// duplicate id wins, preventing simultaneous live + settled paint.
				if (
					message.running ||
					(message.toolId && liveToolIds().has(message.toolId))
				)
					continue;
				// Collect the maximal run of consecutive tool calls, then group
				// same-family calls into compact blocks (expanding per-call).
				const run: ChatMessage[] = [message];
				while (
					i + 1 < all.length &&
					all[i + 1]?.role === 'tool' &&
					!all[i + 1]?.running &&
					(!all[i + 1]?.toolId || !liveToolIds().has(all[i + 1]!.toolId!))
				) {
					run.push(all[i + 1]!);
					i++;
				}
				// Every tool row keeps its OWN brief: tool-loop rounds that
				// stream narration append CONSECUTIVE tool messages (no
				// separator when the round produced no reasoning), so a run
				// can span multiple rounds. Threading each rendered row's own
				// brief keeps every round's narration visible once settled —
				// the old run-wide `run[0]?.brief` dropped every brief after
				// the first tool message of the run.
				for (const row of renderToolRun(
					run,
					fillWidth,
					compactDetails,
					latestTaskMessages,
				)) {
					pushBlock(row.text, row.blockKey, 'md', row.brief);
				}
			} else if (message.kind === 'info') {
				pushBlock(renderInfoRow(message.content, `info-${i}`), `info-${i}`);
			} else if (message.kind === 'warning') {
				// Warning rows (e.g. the vision-fallback indicator) render in
				// the theme WARNING (yellow) color.
				pushBlock(fence('warningrow', 'done', message.content));
			} else if (message.error) {
				pushBlock(fence('errorrow', 'done', `⚠ ${message.error}`));
			} else {
				if (message.reasoning && thinkingMode() === 'show') {
					const thoughtKey = `thought-${i}`;
					// Full reasoning text for the DETAILS modal (collapsed
					// previews cap at PREVIEW_LINES=3; click opens the modal).
					compactDetails.set(thoughtKey, message.reasoning.trim());
					pushBlock(
						settledThought(
							message.reasoning,
							message.durationSec,
							thoughtKey,
							fillWidth,
						),
						thoughtKey,
					);
				}
				// Assistant replies carry the `✦` prefix as the left
				// indication (parity: nanocoder's assistant icon). `~✦~`
				// renders it DIM (the strikethrough style maps to dim).
				if (message.content) {
					pushBlock(
						// The `✦` glyph renders OUTSIDE the reply container
						// (aligned with tool glyphs); the content is plain.
						message.content,
						undefined,
						'reply',
					);
				}
			}
		}
		// TOOL/THOUGHT fences render as PLAIN COMPONENTS (SettledToolRow),
		// never markdown — markdown's text-buffer is hostile to mouse events
		// (hit-test changes on hover → the "hover doesn't stick" bug, and
		// buffer backgrounds bleed into every row). Everything else groups
		// into markdown nodes as before.
		const blocks: SettledBlock[] = [];
		for (const part of parts) {
			if (part.kind === 'reply') {
				blocks.push({kind: 'reply', parts: [part]});
				continue;
			}
			// The opener may carry the full-row-bg WIDTH marker
			// (`filediff:done:w84`) from pushBlock — tolerate it so the
			// block still classifies as a component TOOL row. Without this,
			// the Edit/diff row falls back to markdown and its nested
			// ` ```filediff ` fences render as leaked literal lines.
			const fenceMatch =
				/^```+([^:\n]+):([^:\n]+)(?::[^:\n]*)?\n+([\s\S]*?)\n+```+$/.exec(
					part.text,
				);
			if (fenceMatch && COMPONENT_ROW_LANGS.has(fenceMatch[1] ?? '')) {
				const lang = fenceMatch[1] ?? '';
				const status = (fenceMatch[2] ?? 'done') as RowStatus;
				blocks.push({
					kind: 'tool',
					part,
					status,
					glyph: lang === 'thought' ? '⚙' : '✦',
					brief: part.brief,
					batchBriefed: part.brief === ' ',
					// Same tokenizer path the LIVE rows use: identical colors,
					// spacing and syntax highlighting while running and done.
					// Briefed rows (FileToolRow) render a 3-wide indent box per
					// body row, so their fill budget shrinks by 3 — otherwise
					// the padded row overflows the renderable and the TERMINAL
					// wraps a phantom line after every diff row.
					segments: liveRowSegments(
						(fenceMatch[3] ?? '').replace(/^\n/, ''),
						lang,
						status,
						colors(),
						toolRowFillWidth(terminalDimensions().width ?? 80, part.brief),
					),
				});
				continue;
			}
			// Every transcript part gets its own block. Never merge entries:
			// markdown newline normalization can erase visual spacing.
			blocks.push({kind: 'md', parts: [part]});
		}

		const docLines: Array<{text: string; key?: string}> = [];
		// Rendered-row index: fence markers (` ```lang ` openers/closers) are
		// consumed by the markdown parser and never render as rows, so the
		// click/hover row → doc line mapping must skip them.
		const renderIndex: number[] = [];
		const ranges: Array<{key: string; start: number; end: number}> = [];
		let block: {key: string; start: number} | null = null;
		// stableSettledBlocks reuses UNCHANGED block objects so Solid's For
		// keeps their elements WITHOUT re-firing the ref callback. If we
		// reset every ref to null here, those kept elements lose their
		// hover/click hit-target on EVERY recompute — on resume (where most
		// blocks are cache hits from the previous conversation) only newly
		// created blocks stayed interactive. Carry the ref over when the
		// block object is unchanged: the element still exists and its
		// screenY/height are kept live by the layout engine.
		const stableBlocks = stableSettledBlocks(settledBlockCache, blocks);
		const prevRefsByBlock = new Map<
			SettledBlock,
			{screenY: number; height?: number} | null
		>();
		for (const entry of blockRefs) {
			if (entry.block) prevRefsByBlock.set(entry.block, entry.ref);
		}
		blockRefs.length = 0;
		blocks.forEach((group, groupIndex) => {
			const start = renderIndex.length;
			// Tool blocks render a leading BREAKLINE (parity: the blank rows
			// between settled blocks), counted here so the mouse mapping
			// stays aligned with the rendered rows.
			if (group.kind === 'tool') {
				docLines.push({text: '', key: group.part.key});
				renderIndex.push(docLines.length - 1);
			}
			const partList = group.kind === 'tool' ? [group.part] : group.parts;
			partList.forEach((part, index) => {
				// A block is EXPANDABLE only when it actually hides content (a
				// `+N more lines` footer) or is currently expanded. TOOL
				// blocks are ALWAYS interactive: the whole bordered entry
				// (Bash box, file diff, …) is one hoverable/clickable region,
				// not just the rows with a footer.
				const hasFooter = /\+(\d+) (more )?lines?/.test(part.text);
				const expandable =
					group.kind === 'tool' ||
					(part.key !== undefined &&
						(hasFooter || Boolean(expandedBlocks()[part.key])));
				// NO hoveredBlock() read here: the hover marker is applied
				// PER-ITEM in the For render below, so hovering never changes
				// this array's identity (OpenTUI's For re-renders EVERY child
				// when the each reference changes — that was the hover flicker).
				const isFenced = part.text.trimStart().startsWith('```');
				if (index > 0 && !isFenced) {
					docLines.push({text: ''});
					renderIndex.push(docLines.length - 1);
				}
				if (part.key) block = {key: part.key, start: -1};
				for (const line of part.text.split('\n')) {
					const isFenceMarker = /^\s*`{3,}/.test(line);
					docLines.push({text: line, key: part.key});
					if (!isFenceMarker) {
						if (block && block.start === -1) {
							block.start = renderIndex.length;
						}
						renderIndex.push(docLines.length - 1);
					}
				}
				if (block && expandable) {
					ranges.push({
						...block,
						start: Math.max(0, block.start),
						end: Math.max(0, renderIndex.length - 1),
					});
					block = null;
				} else {
					block = null;
				}
			});
			blockRefs.push({
				ref: prevRefsByBlock.get(stableBlocks[groupIndex]!) ?? null,
				start,
				key:
					group.kind === 'tool'
						? (group.part.key ?? `entry-${groupIndex}`)
						: (group.parts[0]?.key ?? `entry-${groupIndex}`),
				// Replies render a leading blank row (breakline before the
				// response) and tool blocks too (breakline before the block),
				// so those blocks are one row taller.
				// The pre-tool BRIEF renders an extra line above the row; the
				// bash box draws TOP/BOTTOM borders. rowForEvent prefers the
				// ACTUAL laid-out height, these counts are the pre-layout
				// fallback.
				rows:
					renderIndex.length -
					start +
					(group.kind === 'reply' || group.kind === 'tool' ? 1 : 0) +
					// The bordered bash box draws a TOP and BOTTOM border
					// around its content, so the click/hover range must span
					// two extra rows (the border is part of the entry).
					(group.kind === 'tool' && isBashBlock(group) ? 2 : 0) +
					// The model brief (when present) is one rendered line.
					(group.kind === 'tool' && group.brief && group.brief.trim() ? 1 : 0),
				block: stableBlocks[groupIndex],
			});
		});
		lineMap = renderIndex.map(index => docLines[index]?.key);
		renderText = renderIndex.map(index => docLines[index]?.text ?? '');
		blockRanges = ranges;
		currentBlock = block;
		baseRowCount = renderIndex.length;
		return stableBlocks;
	});

	/**
	 * LIVE region, computed on the ticker signals ONLY so the settled blocks
	 * stay untouched. The THOUGHT and the STREAMING REPLY are separate nodes:
	 * the reply renders in the SAME glyph-row container as settled replies,
	 * so the formatting/indentation is identical while rendering and when
	 * done (real-time consistency).
	 */
	// Throttle the STREAMING REPLY to ~7 updates/sec (the provider streams
	// per word, which would re-parse the live markdown 30+ times a second and
	// flicker). The settled reply is unaffected.
	const [throttledStreaming, setThrottledStreaming] = createSignal('');
	// Throttle the REASONING tail the same way (the thought block must not
	// re-parse per reasoning word either).
	const [throttledReasoning, setThrottledReasoning] = createSignal('');
	// Throttle RUNNING TOOL OUTPUT the same way: tool results stream per
	// chunk, so without a floor the live row would re-parse every chunk and
	// flicker. The settled rows read committed output, never this signal.
	const [throttledToolOutputs, setThrottledToolOutputs] = createSignal<
		Record<string, string>
	>({});
	const liveThoughtHeader = createMemo(() => {
		if (!running() || !throttledReasoning()) return '';
		return liveThinkingHeader(spinnerFrame(), thinkingElapsed());
	});
	const liveThoughtTail = createMemo(() => {
		if (!running() || !throttledReasoning()) return '';
		const width = historyFillWidth(terminalDimensions().width ?? 80);
		const tail = throttledReasoning()
			.replace(/\n+$/, '')
			.split('\n')
			.slice(-PREVIEW_LINES)
			.join('\n');
		return wrapThoughtBody(tail, width);
	});
	const throttleTimer = setInterval(() => {
		setThrottledStreaming(streaming());
		setThrottledReasoning(reasoning());
		setThrottledToolOutputs(liveOutputs());
	}, 150);
	onCleanup(() => clearInterval(throttleTimer));
	const liveReplyText = createMemo(() =>
		running() && throttledStreaming() ? throttledStreaming() : '',
	);
	// The streaming reply's glyph blinks (`~✦~` = dim via strikethrough).
	/**
	 * RUNNING tool rows, rendered in the live region with their streaming
	 * output (the settled memo skips them so it never re-runs mid-stream).
	 * Each row is tokenized with the SAME tokenizers the settled rows use
	 * (`status: 'running'`), so colors, syntax highlighting and spacing are
	 * IDENTICAL while streaming and when done. The chunks render as PLAIN
	 * text cells (never markdown), so OpenTUI only repaints changed cells —
	 * no re-parse, no flicker. The glyph is rendered separately (blinking),
	 * NOT part of these chunks.
	 */
	const liveToolRows = createMemo(() => {
		if (!running()) return [];
		const outputs = throttledToolOutputs();
		const seenToolIds = new Set<string>();
		const runningAgents = activeAgentRuns().filter(
			run => run.status === 'running',
		);
		const rows: Array<
			LiveRowSegments & {
				toolId?: string;
				lang?: string;
				brief?: string;
				batchBriefed?: boolean;
				agentAggregate?: boolean;
			}
		> = [];
		for (const run of runningAgents) {
			const width = historyFillWidth(terminalDimensions().width ?? 80);
			const tail = formatSubagentCompactTail(
				run.output,
				4,
				Math.max(20, width - 6),
			);
			const raw = `✦ Ran agent:${run.name}(${run.description}) running\n${tail}`;
			rows.push({
				toolId: run.id,
				lang: 'agentrow',
				...liveRowSegments(raw, 'agentrow', 'running', colors(), width),
			});
		}
		for (const message of messages()) {
			if (
				message.role === 'tool' &&
				message.running &&
				message.tool &&
				message.tool.name !== 'review_changes' &&
				shouldRenderRunningToolMessage(
					message.tool.name,
					runningAgents.length > 0,
				)
			) {
				if (message.toolId) {
					if (seenToolIds.has(message.toolId)) continue;
					seenToolIds.add(message.toolId);
				}
				const streamed = message.toolId ? outputs[message.toolId] : undefined;
				const output =
					streamed !== undefined ? streamed : (message.tool.output ?? '');
				// Plain text (no fence, no blink swap): `✦ Name(detail)`
				// header + `  └   ` body, exactly like the settled row.
				const raw = formatToolEntry(
					{
						...message.tool,
						output,
						briefed: Boolean(message.brief && message.brief.trim()),
					},
					false,
					'running',
					true,
					true,
					historyFillWidth(terminalDimensions().width ?? 80),
				);
				rows.push({
					toolId: message.toolId,
					lang: rowLanguage(message.tool.name),
					brief: message.brief,
					batchBriefed: message.brief === ' ',
					agentAggregate: message.tool.name === 'review_changes',
					...liveRowSegments(
						raw,
						rowLanguage(message.tool.name),
						'running',
						colors(),
						// Briefed file rows carry a 3-wide indent box per body
						// row — shrink the fill so they never overflow the
						// renderable (the phantom wrapped line per diff row).
						toolRowFillWidth(terminalDimensions().width ?? 80, message.brief),
					),
				});
			}
		}
		return rows;
	});
	/**
	 * Idle-history tip: rendered INSIDE the transcript (centered, with a
	 * leading breakline, transient) ONLY while a turn is running but nothing
	 * is painting in the history — e.g. the model is thinking in the
	 * background (hide-thinking on), or the provider is still warming up.
	 * As soon as reasoning/reply/tool rows stream, the tip disappears and
	 * the real content takes over.
	 */
	// Provider text preceding tool call is transferred into first tool's
	// `brief`. Throttled reply may retain previous value for 150ms; suppress
	// it whenever live tool owns that narration. One visual owner, always.
	const visibleLiveReplyText = createMemo(() =>
		liveToolRows().length > 0 ? '' : liveReplyText(),
	);
	const historyTip = createMemo(() => {
		// "Idle" = a turn is running but NOTHING is painting in the history:
		// no tool rows, no streaming reply, and — in hidden thinking mode —
		// no visible thought block either. (The live thought renders only
		// when thinkingMode is show/line; when hidden, thinking runs in the
		// background and the history is visually idle — exactly when the tip
		// should take the stage.)
		const idle =
			running() &&
			!liveToolRows().length &&
			!visibleLiveReplyText() &&
			!(thinkingMode() === 'show' && liveThoughtHeader());
		if (!idle) return '';
		const elapsed = turnElapsed();
		if (elapsed < 10) return '';
		const tips = [
			'Tip: Type / for commands · @ to mention files',
			'Tip: Press ctrl+p for settings & commands',
			'Tip: Ctrl+C clears the input first, then exits',
		];
		return tips[Math.floor(elapsed / 8) % tips.length] ?? '';
	});
	const lines = createMemo(() => renderText);

	/**
	 * Map a mouse event to a GLOBAL transcript row. The transcript renders as
	 * multiple markdown blocks (replies in padded containers), so the row is
	 * found by walking each block's terminal position and adding its global
	 * row offset.
	 */
	const rowForEvent = (event: MouseEvent): number => {
		for (const entry of blockRefs) {
			const row = hitTestBlock(entry, event.y);
			if (row !== null) return row;
		}
		// LIVE nodes follow the settled base (the reply comes after the
		// thought, so its rows include the thought's rendered lines).
		if (liveReplyRef && event.y >= liveReplyRef.screenY) {
			const top = liveReplyRef.screenY;
			return baseRowCount + liveThoughtLines + (event.y - top);
		}
		if (liveThoughtRef && event.y >= liveThoughtRef.screenY) {
			const top = liveThoughtRef.screenY;
			if (event.y >= top) {
				return baseRowCount + (event.y - top);
			}
		}
		return -1;
	};
	const entryForEvent = (
		event: MouseEvent,
	): {key: string; row: number} | null => {
		const entry = pickHoveredEntry(blockRefs, event.y);
		if (!entry) return null;
		const row = hitTestBlock(entry, event.y);
		return row === null ? null : {key: entry.key, row};
	};

	/**
	 * Mouse click-to-toggle with a DRAG GUARD (parity: nanocoder C16, every
	 * expandable toggles both ways). The modal/expand only fires on MOUSE-UP
	 * after a short delay — a fast click still opens instantly, but a
	 * DRAG (text selection) cancels it, so selecting text never pops the
	 * details modal.
	 */
	let clickStartX = 0;
	let clickStartY = 0;
	let clickTimer: ReturnType<typeof setTimeout> | null = null;
	let clickRange: {key: string; start: number; end: number} | null = null;

	const cancelPendingClick = () => {
		if (clickTimer) {
			clearTimeout(clickTimer);
			clickTimer = null;
		}
		clickRange = null;
	};

	const handleMouseDown = (event: MouseEvent) => {
		if (anyModalOpen()) return;
		const row = rowForEvent(event);
		if (row < 0) return;
		// A click anywhere inside a tool/thought CONTAINER toggles it (the
		// whole block, header, `└` output, footer, is the hit target).
		// Plain transcript text (user rows, replies, diagnostics) has no
		// block and is NOT clickable. A tight ±1 window absorbs minor
		// scrollbox drift without pre-emptively toggling blocks 2+ rows away.
		const range = [row - 1, row, row + 1]
			.map(r =>
				blockRanges.find(
					candidate => r >= candidate.start && r <= candidate.end,
				),
			)
			.find(candidate => candidate && candidate.key !== 'live');
		if (range) {
			// Record the press and WAIT for mouse-up (with a delay) before
			// opening/toggling: if the pointer moves (drag/selection), the
			// pending click is cancelled.
			clickStartX = event.x ?? 0;
			clickStartY = event.y ?? 0;
			clickRange = range;
			if (clickTimer) clearTimeout(clickTimer);
			clickTimer = setTimeout(() => {
				clickTimer = null;
				clickRange = null;
			}, 500);
		}
	};

	/** Fires the pending click ONLY if it was a click, not a drag. */
	const handleMouseUp = (event: MouseEvent) => {
		if (!clickRange) return;
		const moved =
			Math.abs((event.x ?? 0) - clickStartX) > 3 ||
			Math.abs((event.y ?? 0) - clickStartY) > 3;
		const range = clickRange;
		cancelPendingClick();
		if (moved) return;
		{
			// Compact tallies open the DETAILS MODAL (scrollable per-call
			// entries) instead of toggling in place, so a reader never has to
			// parse the whole expanded block inline. Clear the hover state so
			// no highlight lingers behind the modal.
			hoveredBlockRef = null;
			setHoveredBlock(null);
			const details = compactDetails.get(range.key);
			if (details) {
				setDetailsTitle(
					range.key.startsWith('user-')
						? 'User message'
						: range.key.startsWith('command-')
							? 'Triggered command'
							: (renderText[range.start] ?? 'Tool details'),
				);
				setDetailsContent(details);
				setDetailsOpen(true);
				return;
			}
			toggleToolBlock(range.key);
			return;
		}
	};

	// C13: hover, highlight the row under the cursor (moves + ▸ marker).
	const handleMouseMove = (event: MouseEvent) => {
		// DRAG GUARD: any pointer movement beyond a tiny threshold while a
		// click is pending means the user is dragging/selecting — cancel the
		// pending click so the modal never opens mid-drag.
		if (
			clickTimer &&
			(Math.abs((event.x ?? 0) - clickStartX) > 3 ||
				Math.abs((event.y ?? 0) - clickStartY) > 3)
		) {
			cancelPendingClick();
		}
		if (anyModalOpen()) return;
		const entry = entryForEvent(event);
		const row = entry?.row ?? rowForEvent(event);
		if (row < 0) return;
		if (row !== hoverRow()) setHoverRow(row);
		// Every settled entry has its own ref and bounds. Do not derive hover
		// from expandable markdown ranges: plain text blocks have no range,
		// and grouped tool ranges make later calls resolve to the first call.
		const key = entry?.key ?? null;
		if (key !== hoveredBlockRef) {
			hoveredBlockRef = key;
			setHoveredBlock(key);
		}
	};
	const handleMouseOut = (event?: MouseEvent) => {
		// An `out` event bubbles to the scrollbox whenever the HIT TARGET
		// changes — including when the hover OVERLAY appears under the cursor
		// (the pointer was over the markdown node, now it's over the overlay).
		// Clearing unconditionally would blink the hover off immediately.
		// Only clear when the pointer actually left the transcript: if the
		// event still maps to a transcript row, keep the hover.
		if (
			event &&
			typeof event.x === 'number' &&
			typeof event.y === 'number' &&
			rowForEvent(event) >= 0
		) {
			return;
		}
		setHoverRow(-1);
		hoveredBlockRef = null;
		setHoveredBlock(null);
	};
	// Measure the ACTUAL content height from the laid-out scrollbox children
	// (markdown wrapping included — estimates would drift and misplace the
	// input). Re-measures whenever the rendered content changes; the height
	// prop change itself does NOT retrigger this effect, so no loop.
	let lastContentHeight = -1;
	const measureContentHeight = (): void => {
		const box = scrollRef;
		if (!box || !props.onContentHeight) return;
		try {
			let total = 0;
			for (const child of box.content.getChildren()) {
				total += child.height ?? 0;
			}
			if (total !== lastContentHeight) {
				lastContentHeight = total;
				props.onContentHeight(total);
			}
		} catch {
			// A destroyed/unlaid-out child mid-resume must never crash the
			// app; the next tick re-measures.
		}
	};
	createEffect(() => {
		// Subscribe to every signal that changes the rendered content:
		// settled transcript, streaming reply, live tool output, thinking
		// tail, and the spinner ticker (drives the live region frames).
		void messages();
		void running();
		void streaming();
		void liveOutputs();
		void spinnerFrame();
		// Layout lands a tick after the render, so read heights after the
		// current event loop turn.
		setTimeout(measureContentHeight, 0);
	});
	const transcriptContent = () => (
		<>
			{/* SETTLED blocks: the `each` reference stays IDENTICAL while
			    streaming (OpenTUI's For re-renders every child when the each
			    array reference changes, which was the flash cause), so the
			    settled transcript never repaints. Replies render with the
			    glyph OUTSIDE the container (aligned with tool glyphs at
			    column 1) and the markdown inside a box starting after `✦ `. */}
			<For each={settledBlocks()}>
				{(block, index) => {
					const setRef = (element: unknown): void => {
						const entry = blockRefs.find(item => item.block === block);
						if (entry) entry.ref = element as never;
					};
					// TOOL/THOUGHT blocks render as PLAIN COMPONENTS: the
					// hover highlight is a per-row background INSIDE the row
					// (parity: the settings rows), so there is no overlay
					// geometry to compute and the hit target never changes
					// under the cursor — hover sticks.
					if (block.kind === 'tool') {
						// Bash entries render as ONE bordered box (native
						// OpenTUI border, so wrapped lines stay inside).
						if (
							block.status !== undefined &&
							block.glyph === '✦' &&
							isBashBlock(block)
						) {
							return (
								<box
									ref={setRef}
									width={historyFillWidth(terminalDimensions().width ?? 80)}
									backgroundColor={
										block.part.key === hoveredBlock()
											? hoverBackground
											: undefined
									}
								>
									<BashToolRow
										header={block.segments.header}
										body={block.segments.body}
										status={block.status}
										glyph={block.glyph}
										hovered={false}
										brief={block.brief}
										batchBriefed={block.batchBriefed}
										width={historyFillWidth(terminalDimensions().width ?? 80)}
										md={briefMarkdown}
									/>
								</box>
							);
						}
						// File-write/edit rows (Write / Edit / diff previews):
						// plain components with the leading breakline, so they
						// never glue under the previous message.
						if (block.status !== undefined && isFileRowBlock(block)) {
							return (
								<box
									ref={setRef}
									width={historyFillWidth(terminalDimensions().width ?? 80)}
									backgroundColor={
										block.part.key === hoveredBlock()
											? hoverBackground
											: undefined
									}
								>
									<FileToolRow
										header={block.segments.header}
										body={block.segments.body}
										status={block.status}
										glyph={block.glyph}
										hovered={false}
										brief={block.brief}
										batchBriefed={block.batchBriefed}
										md={briefMarkdown}
									/>
								</box>
							);
						}
						return (
							<box
								ref={setRef}
								width={historyFillWidth(terminalDimensions().width ?? 80)}
								backgroundColor={
									block.part.key === hoveredBlock()
										? hoverBackground
										: undefined
								}
							>
								<SettledToolRow
									segments={block.segments}
									status={block.status}
									glyph={block.glyph}
									hovered={false}
									brief={block.brief}
									batchBriefed={block.batchBriefed}
									briefUnindented={block.segments.header.some(chunk =>
										chunk.text.includes('agent:'),
									)}
									md={briefMarkdown}
									width={historyFillWidth(terminalDimensions().width ?? 80)}
								/>
							</box>
						);
					}
					const contentFor = () =>
						block.parts.map(part => part.text).join('\n\n');
					if (block.kind === 'reply') {
						return (
							<box
								ref={setRef}
								width={historyFillWidth(terminalDimensions().width ?? 80)}
								backgroundColor={
									block.parts[0]?.key === hoveredBlock()
										? hoverBackground
										: undefined
								}
							>
								<TranscriptReply
									content={contentFor()}
									renderNode={renderNode}
									treeSitter={treeSitter}
								/>
							</box>
						);
					}
					return (
						<box
							ref={setRef}
							width={historyFillWidth(terminalDimensions().width ?? 80)}
							flexDirection="column"
							backgroundColor={
								block.parts[0]?.key === hoveredBlock()
									? hoverBackground
									: undefined
							}
						>
							{/* Structural gap: every generic history entry owns one blank
							    row above it. Markdown never owns spacing. */}
							<box height={1} />
							<markdown
								content={contentFor()}
								streaming={false}
								fg={colors().text}
								syntaxStyle={syntaxStyle()}
								internalBlockMode="top-level"
								renderNode={renderNode}
								treeSitterClient={treeSitter}
								tableOptions={{
									style: 'grid',
									borders: true,
									widthMode: 'content',
								}}
							/>
						</box>
					);
				}}
			</For>
			{/* LIVE THOUGHT: PLAIN TEXT (no markdown re-parse) so the thinking
			    block can never flicker while reasoning streams. The leading
			    breakline matches the settled blank row before the block. */}
			<Show when={thinkingMode() === 'show' && liveThoughtHeader()}>
				<box
					ref={element => {
						liveThoughtRef = element as never;
						liveThoughtLines = 3;
					}}
					flexDirection="column"
				>
					<box height={1} />
					<text fg={colors().secondary} attributes={dim()}>
						{liveThoughtHeader()}
					</text>
					<text fg={colors().secondary} attributes={dim()}>
						{liveThoughtTail()}
					</text>
				</box>
			</Show>
			{/* RUNNING tool rows (streaming output) — their own node so the
			    settled blocks never re-render mid-stream. Rendered ONLY via
			    the LiveToolRows component (plain text cells, never markdown):
			    same syntax colors/spacing as settled rows, ZERO re-parse
			    flicker, and each row carries the settled leading breakline. */}
			<Show when={liveToolRows().length > 0}>
				<LiveToolRows
					rows={liveToolRows()}
					md={briefMarkdown}
					width={historyFillWidth(terminalDimensions().width ?? 80)}
				/>
			</Show>
			{/* LIVE REPLY: rendered in the SAME glyph-row container as a
			    settled reply, so the indentation and markdown formatting are
			    identical while streaming and when done. The leading breakline
			    matches the settled blank row before every response. */}
			<Show when={visibleLiveReplyText()}>
				<TranscriptReply
					content={visibleLiveReplyText()}
					streaming={running()}
					renderNode={renderNode}
					treeSitter={treeSitter}
					onRef={element => {
						liveReplyRef = element as never;
					}}
				/>
			</Show>
			{/* Idle-history tip: a TRANSIENT centered row at the bottom of the
			    transcript (breakline above so it never glues to the last
			    message), shown only while a turn runs but nothing streams.
			    It lives INSIDE the scrollbox so it scrolls with the history
			    and vanishes the moment real content renders. */}
			<Show when={historyTip()}>
				<box flexDirection="column">
					<box height={1} />
					<box flexDirection="row" justifyContent="center">
						<text fg={colors().secondary} attributes={dim()}>
							{historyTip()}
						</text>
					</box>
				</box>
			</Show>
			{/* Compacting indicator: a TRANSIENT centered row at the bottom of
			    the transcript (breakline above so it never glues to the last
			    message, animated dots, warning color — same shape as the
			    idle-history tip). Shows ONLY while an LLM context compaction
			    runs and disappears the moment it settles, so the compaction
			    never pollutes the chat history with a permanent row. It
			    lives INSIDE the scrollbox so it scrolls with the history and
			    never shifts the input/status line. */}
			<Show when={compacting()}>
				<box flexDirection="column">
					<box height={1} />
					<box flexDirection="row" justifyContent="center">
						<text fg={colors().warning} attributes={dim()}>
							{compactingLabel(spinnerFrame())}
						</text>
					</box>
				</box>
			</Show>
		</>
	);
	if (props.embedded) {
		return (
			<box
				width={props.width ?? '100%'}
				height={props.height ?? '100%'}
				flexDirection="column"
				minHeight={0}
			>
				{transcriptContent()}
			</box>
		);
	}
	return (
		// biome-ignore lint/suspicious/noExplicitAny: runtime-valid mouse prop
		<scrollbox
			width={props.width ?? '100%'}
			ref={element => {
				scrollRef = element;
			}}
			// NO flex-grow: the parent sizes us to min(content, cap), so the
			// input below stays adjacent to the content (terminal-like) until
			// the content fills the cap and the box pins at the bottom.
			flexGrow={0}
			flexShrink={1}
			minHeight={0}
			height={props.height ?? '100%'}
			// RIGHT gap so the scrollbar never overlaps text (the LEFT gap is
			// per-REPLY, rendered as a padded container below).
			paddingRight={2}
			stickyScroll
			stickyStart="bottom"
			// Mouse-wheel speed parity with opencode: 3× by default
			// (settings → scrollSpeed), so wheel scrolling feels as fast and
			// smooth as the reference CLI instead of the linear 1× default.
			// A MODAL freezes the wheel entirely (zero multiplier) so the
			// history never scrolls behind it.
			scrollAcceleration={
				!props.embedded && anyModalOpen()
					? disabledScroll
					: resolveScrollAcceleration()
			}
			{...({
				onMouseDown: handleMouseDown,
				onMouseUp: handleMouseUp,
				onMouseMove: handleMouseMove,
				onMouseOut: handleMouseOut,
			} as any)}
		>
			{transcriptContent()}
		</scrollbox>
	);
}

/** `  └   ` container lead (content starts at col 6, parity: tool rows). */
const THOUGHT_BODY_LEAD = '  └   ';
/** `      ` (6 spaces) continuation indent = the content column. */
const THOUGHT_BODY_CONT = '      ';

/**
 * LIVE thinking header: ANIMATED gear (⚙ ↔ ✦ in the SAME secondary color —
 * glyph animation, never a color blink) + spinner dots BEFORE the real-time
 * timer (parity: the Working indicator animates its glyph and dots). Pure,
 * unit-tested.
 */
export function liveThinkingHeader(
	frame: number,
	elapsedSeconds: number,
): string {
	return `${gearGlyph(frame)} Thinking ${workingDots(frame)} (${formatElapsed(elapsedSeconds)})`;
}

/**
 * The dynamic ONE-LINE thinking ticker rendered below the live thought
 * block: newlines are collapsed (never shown), and the text keeps scrolling
 * to the RIGHT — only the LATEST content that fits the window width after
 * the `  └ ` prefix is shown. Secondary color (parity: the tail). Pure,
 * unit-tested.
 */
export function liveThoughtOneLine(text: string, width: number): string {
	const max = Math.max(0, width - 4); // after `  └ `
	const flat = text.replace(/\s*\n\s*/g, ' ').trim();
	if (flat.length <= max) return flat;
	return flat.slice(flat.length - max);
}

/**
 * Wrap a thought's reasoning text to the chat width using the TOOL body
 * container format: the first line gets `  └   ` and EVERY continuation
 * (wrapped piece OR explicit newline) gets `      ` (6 spaces, the content
 * column), so long prose lines can never escape the `└` indentation
 * (parity: formatOutputTail's `  └   `/`      ` rows). Pure, unit-tested.
 */
export function wrapThoughtBody(text: string, width: number): string {
	if (!text.trim()) return '';
	const safe = Math.max(1, width);
	const contentWidth = Math.max(1, safe - THOUGHT_BODY_CONT.length);
	const wrapped: string[] = [];
	for (const line of text.replace(/\n+$/, '').split('\n')) {
		for (const piece of wrapText(line, contentWidth)) {
			wrapped.push(piece);
		}
	}
	if (wrapped.length === 0) return '';
	return wrapped
		.map(
			(piece, index) =>
				(index === 0 ? THOUGHT_BODY_LEAD : THOUGHT_BODY_CONT) + piece,
		)
		.join('\n');
}

/**
 * Settled Thought block, `⚙ Thought (Ns) · ~N tokens` header with a `└`
 * preview of the FIRST rendered lines (head once settled), expandable via
 * Ctrl+R. The body uses the same `  └   ` container as tool rows, and the
 * text is pre-wrapped to the chat width so wrapped lines stay inside the
 * indentation.
 */
export function settledThought(
	reasoningText: string,
	durationSec: number | undefined,
	key: string,
	width: number,
): string {
	const tokens = Math.max(1, Math.ceil(reasoningText.length / 4));
	const header =
		`⚙ Thought${durationSec ? ` (${formatDuration(durationSec)})` : ''}` +
		` · ~${formatCount(tokens)} tokens`;
	const body = wrapThoughtBody(reasoningText, width);
	const lines = body.split('\n');
	const expanded = expandedBlocks()[key] ?? thoughtExpanded();
	if (expanded || lines.length <= PREVIEW_LINES) {
		return fence('thought', 'done', `${header}\n${body}`);
	}
	const preview = lines.slice(0, PREVIEW_LINES).join('\n');
	return fence(
		'thought',
		'done',
		`${header}\n${preview}\n` +
			`     … +${lines.length - PREVIEW_LINES} more lines`,
	);
}

/**
 * Info rows: background-task completions are EXPANDABLE (C8), collapsed they
 * show the summary + first script lines with a `+N lines (ctrl + t to view
 * transcript)` footer; expanded (Ctrl+O / footer click) they show the full
 * script. Every other info row renders verbatim.
 */
export function renderInfoRow(content: string, key: string): string {
	if (content.startsWith('Background task completed')) {
		return renderBackgroundTaskRow(content, key);
	}
	if (!content.startsWith('Session:   ')) {
		return content;
	}
	// `/status` block (codex-like): render through a custom fenced row so the
	// `model[effort]` brackets survive (the markdown/tree-sitter pipeline
	// drops bare `[x]` groups). Everything else stays plain markdown.
	if (content.startsWith('Session:   ')) {
		return fence('statusrow', 'done', content);
	}
	const lines = content.replace(/\n+$/, '').split('\n');
	const header = lines[0] ?? '';
	const script = lines.slice(1);
	if (expandedBlocks()[key] ?? toolsExpanded()) {
		return `${header}\n${script.join('\n')}`;
	}
	if (script.length <= 2) return content;
	const preview = script.slice(0, 2).join('\n');
	return `${header}\n${preview}\n` + `  … +${script.length - 2} more lines`;
}

/**
 * Background task completion, tool-row format (parity: nanocoder's
 * BackgroundTaskCompleted component): `✦ Background task completed · exit N`
 * header, the script under a `  └   ` container (pre-wrapped so long
 * commands can never escape the indent), and a `… +N more lines` footer when
 * collapsed. Ctrl+O / click expands the full script.
 */
function renderBackgroundTaskRow(content: string, key: string): string {
	const lines = content.replace(/\n+$/, '').split('\n');
	const header = lines[0] ?? 'Background task completed';
	const script = lines.slice(1);
	const wrapWidth = 84;
	const wrapped: string[] = [];
	for (const line of script) {
		for (const piece of wordWrapForBackground(line, wrapWidth)) {
			wrapped.push(piece);
		}
	}
	const expanded = expandedBlocks()[key] ?? toolsExpanded();
	const visible = expanded ? wrapped : wrapped.slice(0, 3);
	const hidden = wrapped.length - visible.length;
	const body = visible
		.map((line, index) => `${index === 0 ? '  └   ' : '      '}${line}`)
		.join('\n');
	const footer = hidden > 0 ? `\n     … +${hidden} more lines` : '';
	// The header keeps the tool-row language so the tokenizer colors the
	// glyph green + the name white (only the tool name is primary).
	return fence('toolrow', 'done', `✦ ${header}\n${body}${footer}`);
}

/** Word wrap with hard-split for long words (URLs/paths/log lines). */
function wordWrapForBackground(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = '';
			}
			for (let i = 0; i < word.length; i += width) {
				lines.push(word.slice(i, i + width));
			}
			continue;
		}
		if (!current) {
			current = word;
		} else if (current.length + 1 + word.length <= width) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

/**
 * Group only activity-style tools into chronological trees. Exploration
 * calls share `Explored`, web calls share `Navigated Web`, and MCP calls
 * share one group per server. Every other tool remains standalone: file
 * mutations, agents, bash, tasks, skills, lifecycle tools, etc.
 *
 * A same-family block stays ONE batch only while it shares a single brief:
 * within one round the first call carries the real brief and later calls
 * carry the ' ' batch marker, but a tool message with its OWN real brief
 * belongs to a NEW round — grouping it into the previous round's tally
 * would silently drop that narration from the settled transcript.
 */
function groupToolRun(run: ChatMessage[]): ChatMessage[][] {
	const blocks: ChatMessage[][] = [];
	for (const message of run) {
		const name = message.tool?.name ?? '';
		const activity = activityGroupForTool(name);
		if (!activity) {
			blocks.push([message]);
			continue;
		}
		const last = blocks[blocks.length - 1];
		const lastActivity = last?.[0]?.tool
			? activityGroupForTool(last[0].tool.name)
			: null;
		const incomingBrief = message.brief;
		const groupBrief = last?.[0]?.brief;
		const sharesBatch =
			!incomingBrief ||
			incomingBrief === ' ' ||
			(groupBrief !== undefined && incomingBrief === groupBrief);
		if (last && lastActivity?.key === activity.key && sharesBatch) {
			last.push(message);
		} else {
			blocks.push([message]);
		}
	}
	return blocks;
}

/**
 * Per-row briefs for a settled tool run, mirroring `groupToolRun` exactly:
 * every row carries the brief of its own block, so briefs from CONSECUTIVE
 * ROUNDS all survive into the settled transcript (the ' ' batch marker and
 * undefined pass through for rows without their own narration). Exported
 * for the regression spec — the old run-wide `run[0]?.brief` dropped every
 * brief after the first tool message of a run.
 */
export function toolRunBriefs(run: ChatMessage[]): Array<string | undefined> {
	return groupToolRun(run).map(block => block[0]?.brief);
}

/**
 * Render a run of consecutive tool calls. Each rendered row carries its
 * OWN block's brief (for a compacted same-round batch that is the batch's
 * single brief; for single-call rows it is that call's brief), so later
 * rounds' narration is never swallowed by the first row of the run.
 */
export function renderToolRun(
	run: ChatMessage[],
	width: number,
	details: Map<string, string>,
	latestTaskMessages: Set<ChatMessage> = new Set(),
): Array<{text: string; blockKey?: string; brief?: string}> {
	return groupToolRun(run).flatMap(block => {
		const brief = block[0]?.brief;
		const activity = block[0]?.tool
			? activityGroupForTool(block[0].tool.name)
			: null;
		if (!activity) {
			const message = block[0]!;
			const compactTask =
				message.tool?.name === 'write_tasks' &&
				!latestTaskMessages.has(message);
			if (
				compactTask &&
				message.tool?.name === 'write_tasks' &&
				!message.brief?.trim()
			) {
				return [];
			}
			const key = message.toolId ?? message.tool?.name ?? `block-${Date.now()}`;
			// Expanded details for the modal (collapsed output caps at 3
			// lines; clicking the `+N` footer opens the full scrollable view).
			if (message.tool) {
				details.set(
					key,
					formatToolEntry(
						{
							...message.tool,
							output: liveOutput(message),
							compactTask,
						},
						true,
						'done',
						true,
						true,
						width,
					),
				);
			}
			return [
				{
					text: singleToolRow(message, key, width, compactTask),
					blockKey: key,
					brief,
				},
			];
		}
		const key =
			block[0]!.toolId ?? block[0]!.tool?.name ?? `block-${Date.now()}`;
		// Stash full per-call entries for the details modal. Main transcript
		// keeps only chronological action labels, never output tails or ×N.
		details.set(
			key,
			block
				.map(message =>
					message.tool
						? formatToolEntry(
								{
									...message.tool,
									output: liveOutput(message),
								},
								true,
								'done',
								true,
								true,
								width,
							)
						: message.content,
				)
				.join('\n\n'),
		);
		const tree = formatActivityMessages(activity, block, width);
		return [{text: fence('grouprow', 'done', tree), blockKey: key, brief}];
	});
}

/** Whether a settled tool block is a BASH row (rendered as a bordered box). */
function isBashBlock(block: SettledBlock): boolean {
	if (block.kind !== 'tool') return false;
	const fenceMatch = /^```+([^:\n]+):/.exec(block.part.text);
	return fenceMatch?.[1] === 'bashrow';
}

/** Whether a settled tool block is a FILE-WRITE/EDIT row (Write/Edit/diff). */
function isFileRowBlock(block: SettledBlock): boolean {
	if (block.kind !== 'tool') return false;
	const fenceMatch = /^```+([^:\n]+):/.exec(block.part.text);
	const lang = fenceMatch?.[1];
	return lang === 'filerow' || lang === 'filediff';
}

/** User messages are capped for display; footer opens full text. */
const USER_PREVIEW_LINES = 12;

/** Visible text for a command/skill invocation. Workflow body stays model-only. */
export function commandVisibleText(
	command: NonNullable<ChatMessage['command']>,
	fallback = '',
): string {
	return command.original?.trim() || fallback;
}

/**
 * User message block: `❯ content` on the surface background, capped to
 * USER_PREVIEW_LINES for display with a `+N more lines` footer. Clicking the
 * block opens the FULL text in the details modal (the cap matches the tool
 * rows, the background matches the original nanocoder's UserMessage).
 */
export function renderUserBlock(
	message: ChatMessage,
	key: string,
): {text: string; blockKey: string} {
	const content = message.content;
	const lines = content.replace(/\n+$/, '').split('\n');
	const keys = Object.keys(message.attachments ?? {}).join('');
	const hidden = lines.length - USER_PREVIEW_LINES;
	const preview = hidden > 0 ? lines.slice(0, USER_PREVIEW_LINES) : lines;
	const text =
		preview.join('\n') + (hidden > 0 ? `\n     … +${hidden} more lines` : '');
	return {
		text: fence('usermsg', 'done', `❯ ${text}`, keys ? `a${keys}` : ''),
		blockKey: key,
	};
}

function singleToolRow(
	message: ChatMessage,
	key: string,
	width: number,
	compactTask = false,
): string {
	if (!message.tool) return message.content;
	if (message.tool.name === 'agent') return agentRow(message);
	// review_changes output already contains one agent row per reviewer; keep
	// it in the agent tokenizer instead of generic tool grouping.
	if (message.tool.name === 'review_changes') {
		return fence(
			'agentrow',
			message.running ? 'running' : 'done',
			message.tool.output,
		);
	}
	const status: RowStatus = message.running
		? 'running'
		: message.tool.name === 'execute_bash' && message.kind === 'info'
			? 'bg'
			: 'done';
	// Settled rows never blink (running rows stream in the LIVE region, which
	// owns the blink) — reading spinnerFrame here would re-run the whole
	// settled memo every tick and re-render every block (the flicker loop).
	const blinkOn = true;
	const formatted = formatToolEntry(
		{
			...message.tool,
			output: liveOutput(message),
			briefed: Boolean(message.brief && message.brief.trim()),
			compactTask,
		},
		expandedBlocks()[key] ?? toolsExpanded(),
		status,
		false,
		blinkOn,
		width,
	);
	// File-write/edit previews (Write/Edit/diff) are ALREADY fenced by
	// formatToolEntry (` ```filerow ` / ` ```filediff `) — the settled memo
	// needs an OUTER fence to detect them as component tool rows (the gap +
	// hover + click). Wrap them so they render like every other tool row.
	return message.tool.name === 'write_file' ||
		message.tool.name === 'edit_file' ||
		message.tool.name === 'string_replace' ||
		message.tool.name === 'diff_edit'
		? fence(rowLanguage(message.tool.name), status, formatted)
		: formatted;
}

/**
 * Agent row (looks parity: nanocoder's compact agent entry), `✦ Ran
 * agent:name(task) completed` with a `└ ` output preview and a stats footer
 * `· N tool calls · Xs (ctrl-o to expand)`. While running the header reads
 * `(running)` and the tail streams.
 */
function agentRow(message: ChatMessage): string {
	const detail = message.tool?.detail ?? '';
	const output = liveOutput(message);
	const lines = output
		.replace(/\s+$/, '')
		.split('\n')
		.filter(line => line !== '');
	const running = message.running === true;
	const status = running ? 'running' : 'completed';
	const first = lines[0] ?? '';
	const hidden = lines.length - 1;
	const stats = message.toolStats;
	const statsText = [
		stats?.toolCalls
			? `${stats.toolCalls} tool ${stats.toolCalls === 1 ? 'call' : 'calls'}`
			: '',
		stats?.durationSec ? formatDuration(stats.durationSec) : '',
	]
		.filter(Boolean)
		.join(' · ');
	const footer =
		hidden > 0
			? `\n     … +${hidden} more line${hidden === 1 ? '' : 's'}${statsText ? ` · ${statsText}` : ''}`
			: statsText
				? `\n     ${statsText}`
				: '';
	const statusKind: RowStatus = running ? 'running' : 'done';
	// Settled agent rows never blink (running agents stream live).
	const blinkOn = true;
	const header =
		running && !blinkOn
			? `✦ Ran ${detail} ${status}`.replace(/^[✦⚙]/, ' ')
			: `✦ Ran ${detail} ${status}`;
	return fence(
		'agentrow',
		statusKind,
		// Header parity: `✦ Ran agent:explore(<task>) completed` (the detail
		// already carries the `agent:<type>(<task>)` shape).
		`${header}\n` + `  └  ${first}${footer}`,
	);
}

/** Live output for a running tool row; committed output once settled. */
function liveOutput(message: ChatMessage): string {
	if (message.running && message.toolId) {
		return globalLiveOutputs()[message.toolId] ?? message.tool?.output ?? '';
	}
	return message.tool?.output ?? '';
}
