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
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {
	activeAgents,
	activeEndpoint,
	expandedBlocks,
	gearGlyph,
	hoverRow,
	liveOutputs,
	messages,
	mode,
	reasoning,
	running,
	setHoverRow,
	setThoughtExpanded,
	setToolsExpanded,
	spinnerFrame,
	streaming,
	thinkingElapsed,
	settingsOpen,
	commandsOpen,
	statusOpen,
	modelOpen,
	agentsOpen,
	resumeOpen,
	titleShape,
	workingDots,
	formatElapsed,
	thoughtExpanded,
	toggleToolBlock,
	toolsExpanded,
	setDetailsOpen,
	setDetailsTitle,
	setDetailsContent,
	detailsOpen,
	type ChatMessage,
} from '../state';
import {markdownSyntaxStyleFor} from '../syntax';
import {displayToolName, isFileWriteTool, toolFamily} from '../tools';
import {
	fence,
	formatOutputTail,
	formatToolEntry,
	rowLanguage,
} from '../tool-display';
import {liveRowSegments, type LiveRowSegments} from '../live-tool-row';
import {LiveToolRows} from './live-tool-rows';
import {SettledToolRow} from './settled-tool-row';
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
import {historyFillWidth} from '../history-width';
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
]);
/**
 * Expanded per-call entries of every multi-call compact block, keyed by block
 * key. Clicking an expandable tally opens the DETAILS MODAL with these
 * entries (scrollable) instead of toggling in place.
 */
const compactDetails = new Map<string, string>();

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
export function History(props: {height?: number}) {
	const renderer = useRenderer();
	const dim = () => createTextAttributes({dim: true});
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
				onChunks: () =>
					tokenizeToolRow(token.text ?? '', status, colors()),
			}),
		bashrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeBashRow(token.text ?? '', status, colors()),
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
				onChunks: () =>
					tokenizeDiffRow(token.text ?? '', status, colors()),
			}),
		agentrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeAgentRow(token.text ?? '', status, colors()),
			}),
		grouprow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeToolRow(token.text ?? '', status, colors()),
			}),
		thought: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeThought(token.text ?? '', status, colors()),
			}),
		usermsg: (token) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeUserMessage(
						token.text ?? '',
						colors(),
						historyFillWidth(terminalDimensions().width ?? 80),
						// The fence language suffix carries the REAL
						// attachment token numbers (`a13` = #1 + #3), so only
						// genuine [Image #N]/[Text #N] tokens get colored.
						String(token.lang ?? '').split(':')[2] ?? '',
					),
			}),
		commandrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeCommandRow(token.text ?? '', status, colors()),
			}),
		taskrow: (token, status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeTaskRow(token.text ?? '', status, colors()),
			}),
		// Error rows (`⚠ …`) render in the error color.
		errorrow: (token, _status) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () => tokenizeErrorRow(token.text ?? '', colors()),
			}),
		warningrow: (token) =>
			new CodeRenderable(renderer as unknown as RenderContext, {
				content: token.text ?? '',
				filetype: 'txt',
				syntaxStyle: syntaxStyle(),
				onChunks: () =>
					tokenizeWarningRow(token.text ?? '', colors()),
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

	// C1: PageUp/PageDn scroll the transcript by one viewport (wheel is
	// handled natively by the scrollbox). Sticky-bottom re-engages on the
	// next content append. While a modal (settings) is open the modal owns
	// the keys, scrolling the history behind it would be a leak.
	useKeyboard(event => {
		if (
			settingsOpen() ||
			commandsOpen() ||
			statusOpen() ||
			modelOpen() ||
			agentsOpen() ||
			detailsOpen() ||
			resumeOpen()
		) {
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
		ref: {screenY: number} | null;
		start: number;
		rows: number;
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
	const settledBlocks = createMemo(() => {
		// Reading the width here (a signal) makes the memo re-run on terminal
		// resize; the marker below then CHANGES the doc so OpenTUI re-creates
		// the full-row-bg code blocks instead of keeping the old-width chunks.
		const fillWidth = historyFillWidth(terminalDimensions().width ?? 80);
		const parts: Array<{
			text: string;
			key?: string;
			kind: 'md' | 'reply';
		}> = [];
		const pushBlock = (
			text: string,
			key?: string,
			kind: 'md' | 'reply' = 'md',
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
				key,
				kind,
			});
		};
		const all = messages();
		// Welcome block (parity: nanocoder shows a welcome message on an
		// empty conversation instead of a blank transcript). SYSTEM logs
		// (e.g. `Session renamed to "x"`) carry a `kind` and must NOT hide
		// the banner — only real conversation rows do.
		if (!hasConversation(all) && !running()) {
			pushBlock(
				buildWelcomeBanner(
					titleShape(),
				),
			);
		}
		for (let i = 0; i < all.length; i++) {
			const message = all[i]!;
			if (message.role === 'user') {
				// Triggered commands/skills render TWO rows: the ORIGINAL
				// typed command as a normal user message (`/worktree purpose:
				// hello world`), then the tool-style block
				// (`✦ Triggered a Command(name)` + body preview + `+N more
				// lines`) so the user sees what they typed AND what was
				// injected.
				if (message.command) {
					const key = `command-${i}`;
					if (message.command.original) {
						pushBlock(
							fence(
								'usermsg',
								'done',
								`❯ ${message.command.original}`,
							),
						);
					}
					const rendered = renderCommandBlock(message.command, key);
					pushBlock(rendered.text, rendered.blockKey);
					continue;
				}
				// User messages render as a surface-filled `❯ content` block
				// (parity: nanocoder's arrow-style UserMessage background),
				// capped at USER_PREVIEW_LINES with a clickable
				// `+N more lines` footer that opens the full text.
				const userKey = `user-${i}`;
				const userBlock = renderUserBlock(message, userKey);
				pushBlock(userBlock.text, userBlock.blockKey);
			} else if (message.role === 'tool') {
				// RUNNING tool rows render in the LIVE region (their output
				// streams). Including them here would re-read liveOutputs,
				// re-run the whole settled memo on every output tick, and
				// re-render every block (the tool-call flicker).
				if (message.running) continue;
				// Collect the maximal run of consecutive tool calls, then group
				// same-family calls into compact blocks (expanding per-call).
				const run: ChatMessage[] = [message];
				while (i + 1 < all.length && all[i + 1]?.role === 'tool') {
					run.push(all[i + 1]!);
					i++;
				}
				for (const row of renderToolRun(run)) pushBlock(row.text, row.blockKey);
			} else if (message.kind === 'info') {
				pushBlock(renderInfoRow(message.content, `info-${i}`), `info-${i}`);
			} else if (message.kind === 'warning') {
				// Warning rows (e.g. the vision-fallback indicator) render in
				// the theme WARNING (yellow) color.
				pushBlock(fence('warningrow', 'done', message.content));
			} else if (message.error) {
				pushBlock(fence('errorrow', 'done', `⚠ ${message.error}`));
			} else {
				if (message.reasoning) {
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
		const blocks: Array<
			| {kind: 'md'; parts: Array<{text: string; key?: string}>}
			| {kind: 'reply'; parts: Array<{text: string; key?: string}>}
			| {
					kind: 'tool';
					part: {text: string; key?: string};
					segments: LiveRowSegments;
					status: RowStatus;
					glyph: '✦' | '⚙';
			  }
		> = [];
		for (const part of parts) {
			if (part.kind === 'reply') {
				blocks.push({kind: 'reply', parts: [part]});
				continue;
			}
			const fenceMatch = /^```+([^:\n]+):([^:\n]+)\n+([\s\S]*?)\n+```+$/.exec(
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
					// Same tokenizer path the LIVE rows use: identical colors,
					// spacing and syntax highlighting while running and done.
					segments: liveRowSegments(
						(fenceMatch[3] ?? '').replace(/^\n/, ''),
						lang,
						status,
						colors(),
						fillWidth,
					),
				});
				continue;
			}
			const last = blocks[blocks.length - 1];
			if (last?.kind === 'md') {
				last.parts.push(part);
			} else {
				blocks.push({kind: 'md', parts: [part]});
			}
		}

		const docLines: Array<{text: string; key?: string}> = [];
		// Rendered-row index: fence markers (` ```lang ` openers/closers) are
		// consumed by the markdown parser and never render as rows, so the
		// click/hover row → doc line mapping must skip them.
		const renderIndex: number[] = [];
		const ranges: Array<{key: string; start: number; end: number}> = [];
		let block: {key: string; start: number} | null = null;
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
			const partList =
				group.kind === 'tool' ? [group.part] : group.parts;
			partList.forEach((part, index) => {
				// A block is EXPANDABLE only when it actually hides content (a
				// `+N more lines` footer) or is currently expanded.
				const hasFooter = /\+(\d+) (more )?lines?/.test(part.text);
				const expandable =
					part.key !== undefined &&
					(hasFooter || Boolean(expandedBlocks()[part.key]));
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
				ref: null,
				start,
				// Replies render a leading blank row (breakline before the
				// response) and tool blocks too (breakline before the block),
				// so those blocks are one row taller.
				rows:
					renderIndex.length -
					start +
					(group.kind === 'reply' || group.kind === 'tool' ? 1 : 0),
			});
		});
		lineMap = renderIndex.map(index => docLines[index]?.key);
		renderText = renderIndex.map(index => docLines[index]?.text ?? '');
		blockRanges = ranges;
		currentBlock = block;
		baseRowCount = renderIndex.length;
		return blocks;
	});
	/**
	 * LIVE region, computed on the ticker signals ONLY so the settled blocks
	 * stay untouched. The THOUGHT and the STREAMING REPLY are separate nodes:
	 * the reply renders in the SAME glyph-row container as settled replies,
	 * so the formatting/indentation is identical while rendering and when
	 * done (real-time consistency).
	 */
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
	createEffect(() => {
		const timer = setInterval(() => {
			setThrottledStreaming(streaming());
			setThrottledReasoning(reasoning());
			setThrottledToolOutputs(liveOutputs());
		}, 150);
		return () => clearInterval(timer);
	});
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
		const rows: Array<LiveRowSegments & {toolId?: string}> = [];
		for (const message of messages()) {
			if (message.role === 'tool' && message.running && message.tool) {
				const streamed = message.toolId
					? outputs[message.toolId]
					: undefined;
				const output =
					streamed !== undefined
						? streamed
						: (message.tool.output ?? '');
				// Plain text (no fence, no blink swap): `✦ Name(detail)`
				// header + `  └   ` body, exactly like the settled row.
				const raw = formatToolEntry(
					{...message.tool, output},
					false,
					'running',
					true,
				);
				rows.push({
					toolId: message.toolId,
					...liveRowSegments(
						raw,
						rowLanguage(message.tool.name),
						'running',
						colors(),
						historyFillWidth(terminalDimensions().width ?? 80),
					),
				});
			}
		}
		return rows;
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
			if (!entry.ref) continue;
			const top = entry.ref.screenY;
			if (event.y >= top && event.y < top + entry.rows) {
				return entry.start + (event.y - top);
			}
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
		if (
			settingsOpen() ||
			commandsOpen() ||
			statusOpen() ||
			modelOpen() ||
			agentsOpen() ||
			detailsOpen() ||
			resumeOpen()
		)
			return;
		const row = rowForEvent(event);
		if (row < 0) return;
		// A click anywhere inside a tool/thought CONTAINER toggles it (the
		// whole block, header, `└` output, footer, is the hit target).
		// Plain transcript text (user rows, replies, diagnostics) has no
		// block and is NOT clickable. A tight ±1 window absorbs minor
		// scrollbox drift without pre-emptively toggling blocks 2+ rows away.
		const range = [row - 1, row, row + 1]
			.map(r => blockRanges.find(candidate => r >= candidate.start && r <= candidate.end))
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
		if (
			settingsOpen() ||
			statusOpen() ||
			modelOpen() ||
			agentsOpen() ||
			resumeOpen()
		)
			return;
		const row = rowForEvent(event);
		if (row < 0) return;
		if (row !== hoverRow()) setHoverRow(row);
		// The CONTAINER under the cursor (drift-tolerant) drives the
		// persistent background highlight.
		const block =
			[row - 1, row, row + 1]
				.map(r =>
					blockRanges.find(
						candidate => r >= candidate.start && r <= candidate.end,
					),
				)
				.find(candidate => candidate && candidate.key !== 'live') ?? null;
		const key = block?.key ?? null;
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
	return (
		// biome-ignore lint/suspicious/noExplicitAny: runtime-valid mouse prop
		<scrollbox
			ref={element => {
				scrollRef = element;
			}}
			flexGrow={1}
			flexShrink={1}
			minHeight={0}
			height={props.height ?? '100%'}
			// RIGHT gap so the scrollbar never overlaps text (the LEFT gap is
			// per-REPLY, rendered as a padded container below).
			paddingRight={2}
			stickyScroll
			stickyStart="bottom"
			{...({
				onMouseDown: handleMouseDown,
				onMouseUp: handleMouseUp,
				onMouseMove: handleMouseMove,
				onMouseOut: handleMouseOut,
			} as any)}
		>
			{/* SETTLED blocks: the `each` reference stays IDENTICAL while
			    streaming (OpenTUI's For re-renders every child when the each
			    array reference changes, which was the flash cause), so the
			    settled transcript never repaints. Replies render with the
			    glyph OUTSIDE the container (aligned with tool glyphs at
			    column 1) and the markdown inside a box starting after `✦ `. */}
			<For each={settledBlocks()}>
				{(block, index) => {
					const setRef = (element: unknown): void => {
						blockRefs[index()]!.ref = element as never;
					};
					// TOOL/THOUGHT blocks render as PLAIN COMPONENTS: the
					// hover highlight is a per-row background INSIDE the row
					// (parity: the settings rows), so there is no overlay
					// geometry to compute and the hit target never changes
					// under the cursor — hover sticks.
					if (block.kind === 'tool') {
						return (
							<SettledToolRow
								onRef={setRef}
								segments={block.segments}
								status={block.status}
								glyph={block.glyph}
								hovered={
									block.part.key === hoveredBlock()
								}
								width={historyFillWidth(
									terminalDimensions().width ?? 80,
								)}
							/>
						);
					}
					const contentFor = () =>
						block.parts
							.map(part => part.text)
							.join('\n\n');
					if (block.kind === 'reply') {
						return (
						<box flexDirection="column">
							{/* Breakline before every response (parity: the
							    original's reply margin). */}
							<box height={1} />
							<box flexDirection="row">
								<text
									fg={colors().secondary}
									attributes={dim()}
								>
									✦
								</text>
								{/* The content box carries its OWN left gap:
								    the glyph sits at column 1 (aligned with
								    tool glyphs) and the text starts two cells
								    later, so a reply NEVER renders glued to
								    the glyph (`✦The`) and wrapped lines stay
								    inside the container. */}
								<box flexGrow={1} paddingLeft={2}>
									<markdown
										ref={setRef}
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
							</box>
						</box>
						);
					}
					return (
						<markdown
							ref={setRef}
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
					);
				}}
			</For>
			{/* LIVE THOUGHT: PLAIN TEXT (no markdown re-parse) so the thinking
			    block can never flicker while reasoning streams. The leading
			    breakline matches the settled blank row before the block. */}
			<Show when={liveThoughtHeader()}>
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
				<LiveToolRows rows={liveToolRows()} />
			</Show>
			{/* LIVE REPLY: rendered in the SAME glyph-row container as a
			    settled reply, so the indentation and markdown formatting are
			    identical while streaming and when done. */}
			<Show when={liveReplyText()}>
				<box flexDirection="row">
					<text
						fg={colors().secondary}
						attributes={dim()}
					>
						✦
					</text>
					<box flexGrow={1} paddingLeft={2}>
						<markdown
							ref={element => {
								liveReplyRef = element as never;
							}}
							content={liveReplyText()}
							streaming={running()}
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
				</box>
			</Show>
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
		.map((piece, index) =>
			(index === 0 ? THOUGHT_BODY_LEAD : THOUGHT_BODY_CONT) + piece,
		)
		.join('\n');
}

/**
 * Settled Thought block, `⚙ Thought (Ns)` header with a `└` preview of the
 * FIRST rendered lines (head once settled), expandable via Ctrl+R. The body
 * uses the same `  └   ` container as tool rows, and the text is pre-wrapped
 * to the chat width so wrapped lines stay inside the indentation.
 */
function settledThought(
	reasoningText: string,
	durationSec: number | undefined,
	key: string,
	width: number,
): string {
	const header = `⚙ Thought${durationSec ? ` (${durationSec}s)` : ''}`;
	const body = wrapThoughtBody(reasoningText, width);
	const lines = body.split('\n');
	const expanded = expandedBlocks()[key] ?? thoughtExpanded();
	const tokens = Math.max(1, Math.ceil(reasoningText.length / 4));
	if (expanded || lines.length <= PREVIEW_LINES) {
		return fence(
			'thought',
			'done',
			`${header}\n${body}\n~${tokens} tokens`,
		);
	}
	const preview = lines.slice(0, PREVIEW_LINES).join('\n');
	return fence(
		'thought',
		'done',
		`${header}\n${preview}\n` +
			`     … +${lines.length - PREVIEW_LINES} more lines\n` +
			`~${tokens} tokens`,
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
	return (
		`${header}\n${preview}\n` +
		`  … +${script.length - 2} more lines`
	);
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
 * Render a run of consecutive tool calls: same-family calls collapse into ONE
 * compact block (`✦ Ran Bash ×3` / `✦ Ran WebSearch ×2 and WebFetch`), while
 * unrelated tools and file-write tools keep their own rows. Ctrl+O toggles
 * between the compacted header and the individual call entries.
 */
function renderToolRun(run: ChatMessage[]): Array<{text: string; blockKey?: string}> {
	const blocks: ChatMessage[][] = [];
	for (const message of run) {
		const name = message.tool?.name ?? '';
		// File-write tools and AGENTS keep their own rows (nanocoder:
		// subagents render one compact entry per delegated agent, never a
		// single `×N` tally).
		// File-write tools, AGENTS and VISUALIZATIONS keep their own rows:
		// a chart/table must render as-is (compacting two `visualize` calls
		// would bury the chart behind a `+N lines` footer).
		if (
			isFileWriteTool(name) ||
			name === 'agent' ||
			name === 'visualize' ||
			name === 'list_background_tasks'
		) {
			blocks.push([message]);
			continue;
		}
		const family = toolFamily(name);
		const last = blocks[blocks.length - 1];
		const lastFamily =
			last && last[0]?.tool ? toolFamily(last[0].tool.name) : null;
		if (
			last &&
			lastFamily === family &&
			!isFileWriteTool(last[0]?.tool?.name ?? '') &&
			last[0]?.tool?.name !== 'agent' &&
			last[0]?.tool?.name !== 'visualize' &&
			last[0]?.tool?.name !== 'list_background_tasks'
		) {
			last.push(message);
		} else {
			blocks.push([message]);
		}
	}
	return blocks.flatMap(block => {
		if (block.length === 1) {
			const key = block[0]!.toolId ?? block[0]!.tool?.name ?? `block-${Date.now()}`;
			// Expanded details for the modal (collapsed output caps at 3
			// lines; clicking the `+N` footer opens the full scrollable view).
			if (block[0]!.tool) {
				compactDetails.set(
					key,
					formatToolEntry(
						{
							...block[0]!.tool,
							output: liveOutput(block[0]!),
						},
						true,
						'done',
						true,
					),
				);
			}
			return [{text: singleToolRow(block[0]!, key), blockKey: key}];
		}
		const key =
			block[0]!.toolId ?? block[0]!.tool?.name ?? `block-${Date.now()}`;
		// Stash the EXPANDED per-call entries for the details modal (plain
		// text, no outer fences) — clicking the tally opens this content.
		compactDetails.set(
			key,
			block
				.map(message =>
					message.tool
						? formatToolEntry(
								{...message.tool, output: liveOutput(message)},
								true,
								'done',
								true,
							)
						: message.content,
				)
				.join('\n\n'),
		);
		return [{text: compactToolBlock(block, key), blockKey: key}];
	});
}

/**
 * Triggered-command block (custom commands / skills / subscribe auto-
 * triggers), tool-row format: `✦ Triggered a Command(name)` header, the
 * injected body preview (FIRST 10 lines) under a `  └   ` container, and a
 * `+N more lines` footer. Clicking the block opens the full body in the
 * details modal (same expand mechanism as the tool rows). Only the word
 * `Command` is primary; the rest is secondary (parity: tool rows).
 */
const COMMAND_PREVIEW_LINES = 10;
/** User messages are capped for display; the footer opens the full text. */
const USER_PREVIEW_LINES = 12;

export function renderCommandBlock(
	command: NonNullable<ChatMessage['command']>,
	key: string,
): {text: string; blockKey: string} {
	const body = command.body.trim();
	compactDetails.set(key, body);
	const lines = body.split('\n');
	const expanded = expandedBlocks()[key] ?? toolsExpanded();
	const preview = expanded
		? lines
		: lines.slice(0, COMMAND_PREVIEW_LINES);
	const bodyText = preview
		.map((line, index) => `${index === 0 ? '  └   ' : '      '}${line}`)
		.join('\n');
	const hidden = lines.length - preview.length;
	const footer = hidden > 0 ? `\n     … +${hidden} more lines` : '';
	const header = `✦ Triggered a ${command.kind === 'skill' ? 'Skill' : 'Command'}(${command.name})`;
	return {
		text: fence('commandrow', 'done', `${header}\n${bodyText}${footer}`),
		blockKey: key,
	};
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
	compactDetails.set(key, content);
	const keys = Object.keys(message.attachments ?? {}).join('');
	const hidden = lines.length - USER_PREVIEW_LINES;
	const preview = hidden > 0 ? lines.slice(0, USER_PREVIEW_LINES) : lines;
	const text = preview.join('\n') + (hidden > 0 ? `\n     … +${hidden} more lines` : '');
	return {
		text: fence('usermsg', 'done', `❯ ${text}`, keys ? `a${keys}` : ''),
		blockKey: key,
	};
}

function singleToolRow(message: ChatMessage, key: string): string {
	if (!message.tool) return message.content;
	if (message.tool.name === 'agent') return agentRow(message);
	const status: RowStatus = message.running
		? 'running'
		: message.tool.name === 'execute_bash' && message.kind === 'info'
			? 'bg'
			: 'done';
	// Settled rows never blink (running rows stream in the LIVE region, which
	// owns the blink) — reading spinnerFrame here would re-run the whole
	// settled memo every tick and re-render every block (the flicker loop).
	const blinkOn = true;
	return formatToolEntry(
		{...message.tool, output: liveOutput(message)},
		expandedBlocks()[key] ?? toolsExpanded(),
		status,
		false,
		blinkOn,
	);
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
	const lines = output.replace(/\s+$/, '').split('\n').filter(line => line !== '');
	const running = message.running === true;
	const status = running ? 'running' : 'completed';
	const first = lines[0] ?? '';
	const hidden = lines.length - 1;
	const stats = message.toolStats;
	const statsText = [
		stats?.toolCalls ? `${stats.toolCalls} tool ${stats.toolCalls === 1 ? 'call' : 'calls'}` : '',
		stats?.durationSec ? `${stats.durationSec}s` : '',
	].filter(Boolean).join(' · ');
	const footer = hidden > 0
		? `\n     … +${hidden} more line${hidden === 1 ? '' : 's'}${statsText ? ` · ${statsText}` : ''}`
		: statsText
			? `\n     ${statsText}`
			: '';
	const statusKind: RowStatus = running ? 'running' : 'done';
	// Settled agent rows never blink (running agents stream live).
	const blinkOn = true;
	const header = running && !blinkOn
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
		return liveOutputs()[message.toolId] ?? message.tool?.output ?? '';
	}
	return message.tool?.output ?? '';
}

function compactToolBlock(calls: ChatMessage[], key: string): string {
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const message of calls) {
		const name = message.tool?.name ?? '';
		if (!counts.has(name)) order.push(name);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const entriesText = order
		.map((name, index) => {
			const count = counts.get(name) ?? 1;
			const label = `${displayToolName(name)}${count > 1 ? ` ×${count}` : ''}`;
			const separator =
				index === 0
					? ''
					: index === order.length - 1 && order.length > 1
						? ' and '
						: ', ';
			return `${separator}${label}`;
		})
		.join('');
	const header = `✦ Ran ${entriesText}`;

	const expanded = expandedBlocks()[key] ?? toolsExpanded();
	if (expanded) {
		const entries = calls
			.map(message =>
				message.tool
					? formatToolEntry(
							{...message.tool, output: liveOutput(message)},
							true,
							'done',
							true,
						)
					: message.content,
			)
			.join('\n\n');
		return fence('grouprow', 'done', `${header}\n\n${entries}`);
	}

	const lastWithTool = [...calls].reverse().find(message => message.tool);
	const tail = lastWithTool
		? formatOutputTail(liveOutput(lastWithTool), false)
		: '';
	// Universal footer: the collapsed tally hides the individual call
	// entries behind `+N more lines` (no keyboard hint, the footer IS the
	// expand affordance).
	const footer = `\n     … +${calls.length} more line${calls.length === 1 ? '' : 's'}`;
	const row = tail ? `${header}\n${tail}${footer}` : `${header}${footer}`;
	return fence('grouprow', 'done', row);
}
