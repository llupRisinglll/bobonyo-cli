/** @jsxImportSource @opentui/solid */
import {readdirSync} from 'node:fs';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {createTextAttributes} from '@opentui/core';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {
	COMMAND_DESCRIPTIONS,
	commandNames,
	customCommandNames,
} from '../commands';
import {loadCustomCommands, loadSkills} from '../custom';
import {insertMention, listProjectFiles, mentionToken} from '../mentions';
import {expandTextPlaceholders, processPaste} from '../attachments';
import {estimateTokens} from '../tokenize';
import {wrapDescription} from '../description-wrap';
import {wrapText, wrapTextDetailed} from '../text-wrap';
import {
	activeEndpoint,
	busy,
	cancelling,
	completionMessage,
	context,
	contextPercent,
	exitConfirm,
	gearGlyph,
	historyIndex,
	input,
	mode,
	pendingApproval,
	pendingPrompt,
	promptHistory,
	pendingQueue,
	retryingAttempt,
	setWorkingTipVisible,
	setPendingQueue,
	setExitConfirm,
	settingsOpen,
	statusOpen,
	modelOpen,
	agentsOpen,
	detailsOpen,
	resumeOpen,
	sessionId,
	spinnerFrame,
	SPINNER_FRAMES,
	streaming,
	turnElapsed,
	workingDots,
	loadingDots,
	glyphBlinkOn,
	formatElapsed,
	startupLoading,
	setHistoryIndex,
	setInput,
	setMode,
	setPendingApproval,
	setPendingPrompt,
	tasks,
} from '../state';
import {CHALK_GREY, colors} from '../theme';
import {loadSettings, saveSettings} from '../settings';
import {activeRowPalette} from '../row-highlight';

/**
 * Input row, parity with nanocoder's prompt line: `❯ <value>▌` plus a busy
 * hint. ↑/↓ navigate prompt history (draft preserved), typing `/` opens a
 * fuzzy command-suggestion menu (Tab completes), and Enter submits, chat
 * messages queue while busy, slash commands act immediately.
 */
export function InputBox(props: {
	onSubmit: (
		value: string,
		attachments?: Record<string, string>,
	) => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const [draft, setDraft] = createSignal('');
	// ---- Cursor-aware input editing --------------------------------------
	// The input tracks a cursor index (parity: Ink's TextInput). Arrow keys
	// move it; attachment tokens (`[Image #N]` / `[Text #N]`) and a leading
	// `/command` are ATOMIC, arrows/backspace jump over them instead of
	// landing inside the token.
	const [cursorPos, setCursorPos] = createSignal(0);
	const insertAtCursor = (text: string): void => {
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		setInput(value.slice(0, c) + text + value.slice(c));
		setCursorPos(c + text.length);
	};
	const setInputAt = (value: string, cursor = value.length): void => {
		setInput(value);
		setCursorPos(Math.min(Math.max(0, cursor), value.length));
	};
	const deleteBeforeCursor = (): void => {
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c === 0) return;
		const len = tokenEndingAt(value, c) ?? 1;
		setInput(value.slice(0, c - len) + value.slice(c));
		setCursorPos(c - len);
	};
	// Fast-erase (parity: opencode): holding Backspace accelerates, deleting
	// up to 4 chars per repeat once the key has been held for a while.
	let backspaceHold = 0;
	const handleBackspace = (): void => {
		backspaceHold += 1;
		const extra = Math.min(3, Math.floor(backspaceHold / 10));
		for (let i = 0; i <= extra; i++) deleteBeforeCursor();
	};
	const deleteAfterCursor = (): void => {
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c >= value.length) return;
		const len = tokenStartingAt(value, c) ?? 1;
		setInput(value.slice(0, c) + value.slice(c + len));
	};
	const moveCursorLeft = (): void => {
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c === 0) return;
		const len = tokenEndingAt(value, c) ?? 1;
		setCursorPos(c - len);
	};
	const moveCursorRight = (): void => {
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c >= value.length) return;
		const len = tokenStartingAt(value, c) ?? 1;
		setCursorPos(c + len);
	};
	/** Ctrl+Left: jump to the start of the previous word (parity: the
	 *  original nanocoder text-input, readline Alt+B semantics). */
	const moveCursorPrevWord = (): void => {
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		setCursorPos(snapOutOfAtomicToken(value, moveToPrevWord(value, c), 'left'));
	};
	/** Ctrl+Right: jump to just past the next word (readline Alt+F). */
	const moveCursorNextWord = (): void => {
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		setCursorPos(snapOutOfAtomicToken(value, moveToNextWord(value, c), 'right'));
	};
	/**
	 * Move the caret one VISUAL line up/down inside a multiline input
	 * (column preserved, clamped to the target line). Returns false when the
	 * caret is already on the FIRST (up) / LAST (down) line, the caller then
	 * falls through to history navigation (parity: ink-text-input's
	 * onEdgeArrow + the original's multiline PR).
	 */
	const moveCursorVertical = (direction: 'up' | 'down'): boolean => {
		const info = cursorInfo();
		const lines = wrapped();
		if (lines.length < 2) return false;
		const target =
			direction === 'up' ? info.line - 1 : info.line + 1;
		if (target < 0 || target >= lines.length) return false;
		setCursorPos(offsetForLine(lines, target, info.column));
		return true;
	};
	const [selectedQueued, setSelectedQueued] = createSignal(-1);
	const [selectedCompletion, setSelectedCompletion] = createSignal(0);
	const [mentionSelected, setMentionSelected] = createSignal(0);
	const [pasteAttachments, setPasteAttachments] = createSignal<
		Record<string, string>
	>({});
	// Terminal paste: image paths → `[Image #N]`, long text → `[Text #N]`
	// (parity: nanocoder attachments; the tokens keep the input compact).
	usePaste((event: {bytes: Uint8Array}) => {
		const text = new TextDecoder().decode(event.bytes);
		const {text: compact, attachments} = processPaste(
			text,
			pasteAttachments(),
		);
		setPasteAttachments(attachments);
		insertAtCursor(compact);
	});
	/** Submit with `[Text #N]` expanded back to the real pasted content. */
	const submitExpanded = (value: string): void => {
		props.onSubmit(
			expandTextPlaceholders(value, pasteAttachments()),
			pasteAttachments(),
		);
	};

	// Some terminals/herdr clients send the DELETE key sequence (`ESC[3~`,
	// parsed as `delete`) for the physical Backspace key. The input is
	// single-line with the cursor at the end, so both must delete backward.
	const isDeleteKey = (name: string): boolean =>
		name === 'backspace' || name === 'delete';
	/** Preserve letter case: OpenTUI reports `S` as `{name:'s', shift:true}`. */
	const typedChar = (event: {name: string; shift?: boolean}): string => {
		const char = event.name;
		if (char.length !== 1) return '';
		if (event.shift && /^[a-z]$/.test(char)) return char.toUpperCase();
		return char;
	};

	// Bottom-border model/ctx label (parity: nanocoder's `╰─ model · ctx ~N% ─╯`).
	// The MODEL name is primary-bold; `[effort]` and ` · ctx ~N%` stay
	// secondary, two colors, so it renders as an overlay on the border line.
	const corner = createMemo(() => {
		const model = activeEndpoint().model;
		const effort = activeEndpoint().effort;
		const window = activeEndpoint().contextWindow;
		const text =
			context().reduce(
				(total, message) => total + (message.content ?? ''),
				'',
			) + streaming();
		const percent =
			window > 0
				? Math.min(
						100,
						Math.round(
							(estimateTokens(text, model) / window) * 100,
						),
					)
				: 0;
		return {
			// ONLY the model NAME is primary, the effort badge and ctx stay
			// secondary (parity: `deepseek-v4-flash[medium] · ctx ~N%`).
			model,
			effort: effort ? `[${effort}]` : '',
			// NON-BREAKING spaces: they paint as real cells over the border
			// dashes, so the corner needs NO background rectangle (a plain
			// space is a transparent cell that would let the dash show
			// through as `─·─ctx`).
			ctx: `\u00A0·\u00A0ctx\u00A0~${percent}%\u00A0`,
		};
	});
	const completions = createMemo(() => {
		const value = input();
		if (!value.startsWith('/') || value.includes(' ')) return [];
		const name = value.slice(1);
		const items: Array<{
			name: string;
			kind: 'command' | 'skill';
			description: string;
			// `[Command]`/`[Skill]` tag, only NON-built-in entries carry one
			// (the built-ins would be noisy); renders BEFORE the description.
			prefix: string;
		}> = [];
		for (const command of commandNames()) {
			// `/quit` is an ALIAS of `/exit`, only suggest `/exit` (parity:
			// only the canonical command is suggested).
			if (command === 'quit') continue;
			items.push({
				name: command,
				kind: 'command',
				description:
					COMMAND_DESCRIPTIONS[command] ??
					(command.startsWith('mock:')
						? 'Preview scenario'
						: 'Run command'),
				prefix: '',
			});
		}
		for (const command of loadCustomCommands()) {
			items.push({
				name: command.name,
				kind: 'command',
				description: command.description,
				prefix: '[Command]',
			});
		}
		for (const skill of loadSkills()) {
			items.push({
				name: `skill:${skill.name}`,
				kind: 'skill',
				description: skill.description,
				prefix: '[Skill]',
			});
		}
		if (!name) {
			return items
				.slice(0, 50)
				.map((item, index) => ({
					...item,
					active: selectedCompletion() === index,
				}));
		}
		// F1: fuzzy scoring, prefix matches win, then substring, then
		// character subsequence; ties stay in catalog order.
		const query = name.toLowerCase();
		// Typing `/qui…` suggests the canonical `/exit` (the alias).
		if (/^qui/.test(query) && !items.some(item => item.name === 'exit')) {
			items.push({
				name: 'exit',
				kind: 'command',
				description: COMMAND_DESCRIPTIONS['exit'] ?? 'Quit bobonyo',
				prefix: '',
			});
		}
		return items
			.map(item => ({
				item,
				// `/qui…` always surfaces the canonical `/exit` alias.
				score:
					/^qui/.test(query) && item.name === 'exit'
						? 100
						: fuzzyScore(query, item.name),
			}))
			.filter(entry => entry.score > 0)
			.sort((a, b) => b.score - a.score)
			// NO hard 6-item cap: ↑/↓ scroll through ALL matches through a
			// rendered WINDOW (parity: the list scrolls through every match).
			.slice(0, 50)
			// Fold the selection into the array, the reconciler's <For> only
			// re-renders when the `each` reference changes (mouse hover was
			// stale for the same reason).
			.map((entry, index) => ({
				...entry.item,
				active: selectedCompletion() === index,
			}));
	});
	// Rendered WINDOW of the completion list (6 rows), REVERSED so the
	// SELECTED item sits at the BOTTOM (bottom-anchored palette, the opposite
	// of top-down). ↑ walks FORWARD through the list (the content scrolls up),
	// ↓ walks back.
	const completionWindow = createMemo(() => {
		const all = completions();
		const visible = 6;
		const sel = Math.min(
			Math.max(0, selectedCompletion()),
			Math.max(0, all.length - 1),
		);
		const slice = all.slice(sel, sel + visible);
		return [...slice]
			.reverse()
			.map((item, offset) => ({
				...item,
				index: sel + (slice.length - 1 - offset),
			}));
	});
	// `@` file-mention suggestions (parity: the reference mentions files).
	const mentionFiles = createMemo(() => {
		const token = mentionToken(input());
		if (token === null) return [];
		const all = listProjectFiles();
		const q = token.toLowerCase();
		const scored = q
			? all
			.map(path => ({path, score: fuzzyScore(q, path)}))
			.filter(entry => entry.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 6)
			: all.slice(0, 6).map(path => ({path, score: 0}));
		// Fold the selection into the array, the reconciler's <For> only
		// re-renders when the `each` reference changes.
		return scored.map((entry, index) => ({
			path: entry.path,
			score: entry.score,
			active: mentionSelected() === index,
		}));
	});
	const relativePath = (path: string): string => {
		const cwd = process.cwd();
		return path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
	};
	// Box height grows with the command menu / task overlay (parity: the box
	// is prompt + one empty row by default, +1 per menu/task line while shown).
	const boxHeight = createMemo(() => {
		return computeInputBoxHeight(
			input(),
			terminalDimensions().width ?? 80,
			busy(),
			tasks().length,
			Boolean(pendingPrompt()),
			Boolean(pendingApproval()),
			cancelling(),
		);
	});
	// Wrapped input lines, the box grows with them (no text limit). The
	// wrap runs ONCE per frame: the visible lines AND the caret position are
	// derived from the SAME pass (wrapping twice per keystroke was the
	// hot-path waste, benchmarked in input-box.perf.spec.ts).
	const inputWidth = (): number =>
		Math.max(10, (terminalDimensions().width ?? 80) - 12);
	const wrapped = createMemo(() => wrapTextDetailed(input(), inputWidth()));
	const inputLines = createMemo(() => wrapped().map(entry => entry.text));
	// Caret position inside the WRAPPED rows (line + column), derived from
	// the raw-string cursor, never inside an atomic token.
	const cursorInfo = createMemo(() =>
		cursorPositionFromWrapped(wrapped(), cursorPos()),
	);
	// Known `/commands` (built-ins + custom + skills), built ONCE per frame,
	// NOT per tokenized line (the tokenizer runs once per input row).
	const knownCommands = createMemo(
		() =>
			new Set<string>([
				...commandNames(),
				...customCommandNames(),
				...loadSkills().map(skill => `skill:${skill.name}`),
			]),
	);
	// Active suggestion-row palette (info tint + guaranteed-readable fg).
	const activeRow = createMemo(() => activeRowPalette(colors()));
	const approval = createMemo(() => pendingApproval());
	const prompt = createMemo(() => pendingPrompt());
	// Cursor blink: the App ticker advances `spinnerFrame` every 100ms; the
	// caret toggles every 4 frames (400ms on/off, a standard terminal blink).
	// TYPING forces the caret VISIBLE and pauses the blink; a debounce timer
	// resumes blinking ~900ms after the last key.
	const [cursorForced, setCursorForced] = createSignal(false);
	let cursorForceTimer: ReturnType<typeof setTimeout> | null = null;
	const forceCursorVisible = (): void => {
		setCursorForced(true);
		if (cursorForceTimer) clearTimeout(cursorForceTimer);
		cursorForceTimer = setTimeout(() => setCursorForced(false), 900);
	};
	const cursorVisible = createMemo(
		() => cursorForced() || (spinnerFrame() >> 2) % 2 === 0,
	);
	// Dynamic tips appear once a turn has been Working for a while (parity:
	// codex/ rotate contextual hints instead of a static tip).
	const dynamicTip = createMemo(() => {
		const elapsed = turnElapsed();
		const tips = [
			'Tip: Type / for commands · @ to mention files',
			'Tip: Press ctrl+p for settings & commands',
			'Tip: Ctrl+C clears the input first, then exits',
		];
		const tip = elapsed < 10 ? '' : tips[Math.floor(elapsed / 8) % tips.length] ?? '';
		return tip;
	});

	useKeyboard(event => {
		// Any key pauses the caret blink (visible while typing, debounced).
		forceCursorVisible();
		// Reset the fast-erase hold counter whenever a non-backspace key
		// arrives (a fresh keypress means a fresh, deliberate press).
		if (!isDeleteKey(event.name)) backspaceHold = 0;
		const pendingText = prompt();
		if (pendingText) {
			if (event.name === 'escape') {
				// Esc cancels: value editors just dismiss, but prompts with an
				// explicit onCancel (e.g. the first-run trust gate) must NOT
				// silently continue, cancelling there declines trust (exit).
				pendingText.onCancel?.();
				setPendingPrompt(null);
			} else if (event.name === 'return') {
				const value = input().trim();
				pendingText.resolve(value);
				setInputAt('');
				setPendingPrompt(null);
			} else if (isDeleteKey(event.name)) {
				// Backspace deletes a WHOLE `[Image #N]`/`[Text #N]` token
				// instead of nibbling inside it (atomic blocks).
				const value = input();
				const token = value.match(/\[(?:Image|Text) #\d+\]$/);
				setInputAt(
					token ? value.slice(0, -token[0].length) : value.slice(0, -1),
				);
				setSelectedCompletion(0);
				setExitConfirm(false);
			} else if (event.name === 'space') {
				setInputAt(input() + ' ');
				setSelectedCompletion(0);
				setExitConfirm(false);
			} else {
				const char = typedChar(event);
				if (char && !event.ctrl && !event.meta) {
					setInputAt(input() + char);
				}
				setSelectedCompletion(0);
				setExitConfirm(false);
			}
			return;
		}
		// GAP-19: the settings/status MODALS own the keys while open (but a
		// value editor wizard opened FROM the panel must still receive
		// keystrokes, so prompts/approvals are handled above this gate).
		if (
			settingsOpen() ||
			statusOpen() ||
			modelOpen() ||
			agentsOpen() ||
			detailsOpen() ||
			resumeOpen()
		)
			return;
		// A6: Shift+Enter / Ctrl+J / a literal LF insert a newline AT THE
		// CURSOR, handled BEFORE the suggestion popups so a popup never
		// swallows the key (plain Enter still selects/completes/submits).
		const isReturnKey =
			event.name === 'return' || event.name === 'enter';
		const isLiteralNewline =
			(event.sequence === '\n' || event.raw === '\n') && !isReturnKey;
		if (
			(event.shift && isReturnKey) ||
			(event.ctrl && event.name === 'j') ||
			isLiteralNewline
		) {
			insertAtCursor('\n');
			setSelectedCompletion(0);
			setExitConfirm(false);
			return;
		}
		// `@` file-mention popup: ↑/↓ navigate, Enter inserts, Esc dismisses.
		const mentionMatches = mentionFiles();
		if (mentionMatches.length > 0 && !event.ctrl && !event.meta) {
			if (event.name === 'up') {
				setMentionSelected(prev => Math.max(0, prev - 1));
				return;
			}
			if (event.name === 'down') {
				setMentionSelected(prev =>
					Math.min(mentionMatches.length - 1, prev + 1),
				);
				return;
			}
			if (event.name === 'return') {
				const item =
					mentionMatches[
						Math.min(mentionSelected(), mentionMatches.length - 1)
					];
				const token = mentionToken(input());
				if (item && token !== null) {
					const at = input().lastIndexOf('@');
					setInputAt(
						insertMention(input(), item.path, token),
						at + 1 + item.path.length + 1,
					);
				}
				setMentionSelected(0);
				return;
			}
			if (event.name === 'escape') {
				setInputAt(input().replace(/@[^\s]*$/, ''));
				setMentionSelected(0);
				return;
			}
		}
		// Command-completion popup: ↑/↓ navigate, Enter selects, Esc dismisses.
		const matches = completions();
		if (matches.length > 0 && !event.ctrl && !event.meta) {
			if (event.name === 'up') {
				// ↑ walks FORWARD through the list (bottom-anchored: the
				// selected item is at the bottom, navigation goes up).
				setSelectedCompletion(prev =>
					Math.min(matches.length - 1, prev + 1),
				);
				return;
			}
			if (event.name === 'down') {
				setSelectedCompletion(prev => Math.max(0, prev - 1));
				return;
			}
			if (event.name === 'return') {
				const item = matches[Math.min(selectedCompletion(), matches.length - 1)];
				if (item) {
					// Skills run immediately (`/skill:<name>` → submit the
					// skill body); commands complete or run like before.
					if (item.kind === 'skill') {
						setSelectedCompletion(0);
						submitExpanded(`/${item.name}`);
						return;
					}
					// Typing a full `/command` + Enter RUNS it; Enter on a
					// partial match completes it to the highlighted row.
					if (input() === `/${item.name}`) {
						setSelectedCompletion(0);
						submitExpanded(input());
						return;
					}
					setInputAt(`/${item.name} `);
				}
				return;
			}
			if (event.name === 'escape') {
				setInputAt('');
				setSelectedCompletion(0);
				return;
			}
		}
		const pending = approval();
		if (pending) {
			if (event.name === 'y' || event.name === 'Y') {
				pending.resolve(true);
				setPendingApproval(null);
			} else if (event.name === 'n' || event.name === 'N') {
				pending.resolve(false);
				setPendingApproval(null);
			}
			return;
		}
		// Queue navigation (parity: nanocoder), when busy with queued
		// messages and an empty input, ↑/↓ select a queued item instead of
		// walking prompt history.
		if (
			busy() &&
			input().length === 0 &&
			pendingQueue().length > 0 &&
			(event.name === 'up' || event.name === 'down')
		) {
			const index = selectedQueued();
			if (event.name === 'up') {
				if (index < 0) {
					// Nothing above the queue, fall through to history.
				} else {
					setSelectedQueued(index - 1);
					return;
				}
			} else {
				if (index >= pendingQueue().length - 1) {
					return;
				}
				setSelectedQueued(index + 1);
				return;
			}
		}
		if (event.name === 'up') {
			// Multiline input: ↑ moves the caret up a VISUAL line; only on
			// the FIRST line does it fall through to history (parity: the
			// original's multiline PR + ink-text-input onEdgeArrow).
			if (moveCursorVertical('up')) return;
			const history = promptHistory();
			if (history.length === 0) return;
			const index = historyIndex();
			if (index === -1) {
				setDraft(input());
				// Recall the NEWEST entry first, then walk back (parity: the
				// original starts at history.length - 1).
				setHistoryIndex(history.length - 1);
				setInputAt(history[history.length - 1] ?? '');
			} else if (index > 0) {
				const next = index - 1;
				setHistoryIndex(next);
				setInputAt(history[next] ?? '');
			} else {
				// At the oldest entry: restore the saved draft.
				setHistoryIndex(-1);
				setInputAt(draft());
			}
			return;
		}
		if (event.name === 'down') {
			// Multiline input: ↓ moves the caret down a VISUAL line; only on
			// the LAST line does it fall through to history.
			if (moveCursorVertical('down')) return;
			const history = promptHistory();
			if (history.length === 0) return;
			const index = historyIndex();
			if (index === -1) return;
			if (index >= history.length - 1) {
				// At the newest entry: restore the saved draft.
				setHistoryIndex(-1);
				setInputAt(draft());
			} else {
				const next = index + 1;
				setHistoryIndex(next);
				setInputAt(history[next] ?? '');
			}
			return;
		}
		// Cursor movement: ←/→ walk the string but JUMP over atomic tokens
		// (`[Image #N]` / `[Text #N]` / a leading `/command`) so the caret
		// never lands inside a block; Home/End jump to the ends.
		if (event.name === 'left') {
			// Ctrl+Left jumps WORD-WISE (parity: the original nanocoder
			// text-input); plain ← still walks char-by-char over tokens.
			if (event.ctrl) moveCursorPrevWord();
			else moveCursorLeft();
			return;
		}
		if (event.name === 'right') {
			if (event.ctrl) moveCursorNextWord();
			else moveCursorRight();
			return;
		}
		if (event.name === 'home') {
			setCursorPos(0);
			return;
		}
		if (event.name === 'end') {
			setCursorPos(input().length);
			return;
		}
		if (event.name === 'tab') {
			// Shift+Tab cycles the approval mode (yolo → normal → plan →
			// auto-accept → yolo), parity with the original's mode toggle.
			if (event.shift) {
				const ORDER: Array<'yolo' | 'normal' | 'plan' | 'auto-accept'> = [
					'yolo',
					'normal',
					'plan',
					'auto-accept',
				];
				const current = mode();
				const next =
					ORDER[(ORDER.indexOf(current as (typeof ORDER)[number]) + 1) % ORDER.length] ??
					'yolo';
				setMode(next);
				saveSettings({...loadSettings(), mode: next});
				return;
			}
			const matches = completions();
			if (matches.length > 0) {
				// Tab uses the HIGHLIGHTED row (same as Enter), not the first
				// fuzzy match, otherwise arrow navigation + Tab picks the
				// wrong command.
				const item =
					matches[Math.min(selectedCompletion(), matches.length - 1)];
				setInputAt(`/${item!.name} `);
				return;
			}
			// A6: Tab in `!` mode completes file paths from cwd.
			if (input().startsWith('!')) {
				const current = input();
				const token = current.split(/\s+/).pop() ?? '';
				const entries = readdirSync(process.cwd()).filter(entry =>
					entry.startsWith(token),
				);
				if (entries.length === 1) {
					setInputAt(
						current.slice(0, current.length - token.length) +
							entries[0] +
							' ',
					);
				}
			}
			return;
		}
		if (isReturnKey) {
			// Enter on a selected queued item loads it back into the input
			// for editing (and removes it from the queue).
			const queuedIndex = selectedQueued();
			if (queuedIndex >= 0 && queuedIndex < pendingQueue().length) {
				const value = pendingQueue()[queuedIndex]?.value ?? '';
				setInputAt(value);
				setPendingQueue(prev => prev.filter((_, index) => index !== queuedIndex));
				setSelectedQueued(-1);
				return;
			}
			const value = input().trim();
			if (!value) return;
			submitExpanded(value);
			return;
		}
		if (isDeleteKey(event.name)) {
			// Del on a selected queued item removes it.
			const queuedIndex = selectedQueued();
			if (
				queuedIndex >= 0 &&
				queuedIndex < pendingQueue().length &&
				input().length === 0
			) {
				setPendingQueue(prev => prev.filter((_, index) => index !== queuedIndex));
				setSelectedQueued(prev =>
					prev >= pendingQueue().length - 1
						? pendingQueue().length - 2
						: prev,
				);
				return;
			}
			// Backspace deletes at the CURSOR, a whole atomic token when the
			// cursor sits at its end, otherwise one char, ACCELERATING while
			// held (parity: opencode's fast-erase).
			handleBackspace();
			setExitConfirm(false);
			return;
		}
		if (event.name === 'space') {
			insertAtCursor(' ');
			setExitConfirm(false);
			return;
		}
		const char = typedChar(event);
		if (char && !event.ctrl && !event.meta) {
			insertAtCursor(char);
			setExitConfirm(false);
		}
	});

	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	return (
		<box flexDirection="column">
			{/* Working indicator: FIXED above the input box (parity with
			    nanocoder's live region, never scrolled away). */}
			<Show when={busy()}>
				<box height={1}>
					<text
						fg={
							retryingAttempt() > 0
								? colors().warning
								: colors().primary
						}
					>
						{gearGlyph(spinnerFrame())} Working{workingDots(spinnerFrame())} ·{' '}
						({formatElapsed(turnElapsed())})
						{retryingAttempt() > 0
							? ` · retrying (${retryingAttempt()})`
							: ''}{' '}
						· Esc to cancel
						{/* ONE line: the rotating tip rides the SAME row as the
						    Working/Esc indicator, no redundant second line,
						    and the tips never mention Esc again (it's already
						    on the line; duplication confuses). */}
						{dynamicTip() ? ` · ${dynamicTip()}` : ''}
					</text>
				</box>
			</Show>
			{/* Post-open lazy-load indicator: ONE ROW PER service, each with
			    a BLINKING secondary ✦ glyph + ANIMATED dots, clearing
			    independently as its scan finishes (MCP/LSP/skills load at
			    different speeds). */}
			<Show when={startupLoading().length > 0 && !busy()}>
				<For each={startupLoading()}>
					{(item) => (
						<box height={1} flexDirection="row">
							{/* Width-stable glyph cell: the hidden blink
							    frame keeps a space so nothing shifts. */}
							<text
								fg={colors().secondary}
								attributes={dim()}
							>
								{glyphBlinkOn(spinnerFrame()) ? '✦' : ' '}{' '}
							</text>
							<text
								fg={colors().secondary}
								attributes={dim()}
							>
								{item.label}
								{loadingDots(spinnerFrame())}
							</text>
						</box>
					)}
				</For>
			</Show>
			{/* Static completion line above the input (parity: the Working
			    indicator slot, diamond glyph + secondary). */}
			<Show when={completionMessage()}>
				<box height={1}>
					<text fg={colors().secondary}>{completionMessage()}</text>
				</box>
			</Show>
			{/* modal-style exit confirmation: the first Ctrl+C/Esc with an
			    empty input shows this line; the next press exits. */}
			<Show when={exitConfirm()}>
				<box height={1}>
					<text fg={colors().warning} attributes={bold()}>
						Press Ctrl+C again to exit · resume with `bobonyo --resume{' '}
						{sessionId()}`
					</text>
				</box>
			</Show>
			{/* Queued messages: a persistent block ABOVE the input while busy
			    (parity: nanocoder's queuedBlock, it must stay visible, not
			    scroll away with the transcript). */}
			<Show when={pendingQueue().length > 0}>
				<box
					flexDirection="column"
					height={pendingQueue().length + 1}
				>
					<text fg={colors().secondary}>
						Queued messages (↑/↓ select, Enter edit, Del remove):
					</text>
					<For each={pendingQueue()}>
						{(message, index) => (
							<text
								fg={
									selectedQueued() === index()
										? colors().info
										: colors().primary
								}
								attributes={
									selectedQueued() === index()
										? createTextAttributes({bold: true})
										: undefined
								}
								>
									{selectedQueued() === index() ? '▸ ' : '  '}
									(queued) {message.value}
								</text>
						)}
					</For>
				</box>
			</Show>
			{/* `@` file-mention popup, same bordered-list + mouse style as the
			    command suggestions. */}
			<Show when={mentionFiles().length > 0}>
				<box
					border
					borderStyle="rounded"
					borderColor={colors().primary}
					flexDirection="column"
					height={mentionFiles().length + 2}
				>
					<For each={mentionFiles()}>
						{(item, index) => {
							const active = item.active;
							return (
							<box
								flexDirection="row"
								height={1}
								backgroundColor={active ? activeRow().bg : undefined}
								{...({
									onMouseUp: () => {
										const token = mentionToken(input());
										if (token !== null) {
											const at = input().lastIndexOf('@');
											setInputAt(
												insertMention(input(), item.path, token),
												at + 1 + item.path.length + 1,
											);
										}
										setMentionSelected(0);
									},
									onMouseMove: () => setMentionSelected(index()),
								} as any)}
							>
								<text
									fg={active ? activeRow().fg : colors().text}
									attributes={active ? bold() : undefined}
								>
									{active ? '❯ ' : '  '}
									@
									{relativePath(item.path)}
								</text>
							</box>
							);
						}}
					</For>
				</box>
			</Show>
			{/* Command-completion popup (modal-style): a BORDERLESS list
			    above the input while `/` is being typed. ↑/↓ scroll through
			    ALL matches via the rendered window; each row is a command
			    column + a wrapped description column (up to 2 lines) with
			    the `[Command]`/`[Skill]` tag BEFORE the description. */}
			<Show when={completions().length > 0}>
				<box
					flexDirection="column"
					height={completionWindow().length * 2}
				>
					<For each={completionWindow()}>
						{(item) => {
							const active = item.active;
							const descWidth = Math.max(
								24,
								terminalDimensions().width - 42,
							);
							const descLines = wrapDescription(
								item.description,
								descWidth,
							);
							return (
							// The WHOLE row is the hover/click target (parity:
							// the settings rows, hover navigates, click picks).
							<box
								flexDirection="column"
								height={descLines.length}
								backgroundColor={active ? activeRow().bg : undefined}
								{...({
									onMouseUp: () => {
										setSelectedCompletion(item.index);
										if (item.kind === 'skill') {
											submitExpanded(`/${item.name}`);
										} else if (input() === `/${item.name}`) {
											submitExpanded(input());
										} else {
											setInputAt(`/${item.name} `);
										}
										setSelectedCompletion(0);
									},
									onMouseMove: () =>
										setSelectedCompletion(item.index),
								} as any)}
							>
								<box flexDirection="row" height={1}>
									<text
										width={2}
										fg={active ? activeRow().fg : colors().secondary}
										attributes={active ? bold() : undefined}
									>
										{active ? '❯ ' : '  '}
									</text>
									<text
										width={30}
										fg={active ? activeRow().fg : colors().text}
										attributes={active ? bold() : undefined}
									>
										/{item.name}
									</text>
									{item.prefix ? (
										<text
											width={item.prefix.length + 1}
											fg={
												active
													? activeRow().fg
													: colors().primary
											}
											attributes={active ? bold() : undefined}
										>
											{item.prefix}
										</text>
									) : (
										<></>
									)}
									<text
										fg={
											active
												? activeRow().fg
												: colors().secondary
										}
										attributes={active ? bold() : dim()}
									>
										{descLines[0] ?? ''}
									</text>
								</box>
								<Show when={descLines.length > 1}>
									<text
										fg={active ? activeRow().fg : colors().secondary}
										attributes={active ? bold() : dim()}
									>
										{'   '}
										{descLines[1] ?? ''}
									</text>
								</Show>
							</box>
							);
						}}
					</For>
				</box>
			</Show>
			<box position="relative" height={boxHeight()} width="100%">
				<box
					border
					borderStyle="rounded"
					borderColor={colors().secondary}
					paddingLeft={1}
					flexDirection="column"
					height={boxHeight()}
				>
			<Show when={prompt()}>
				<text fg={colors().primary} attributes={bold()}>
					{prompt()?.question ?? ''}: {input()}▌
				</text>
				<box height={1} />
				<text fg={colors().secondary}>Press Esc to cancel</text>
			</Show>
			<Show when={approval()}>
				<text fg={colors().error} attributes={bold()}>
					Approve ✦ {approval()?.name ?? ''}(
						{approval()?.detail ?? ''}
					)? (y/n)
				</text>
				<box height={1} />
				<text fg={colors().secondary}>Press Esc to cancel</text>
			</Show>
			<Show when={!approval() && !prompt()}>
				{/* A7/C9: live task-list overlay. The HEADER is the CURRENT task
				    (animated spinner), not a hardcoded "tasks:" label; when the
				    turn settles every item is marked finished. */}
				<Show when={tasks().length > 0}>
					<Show when={busy() && tasks().some(task => task.running)}>
						<text fg={colors().primary}>
							{SPINNER_FRAMES[spinnerFrame() % SPINNER_FRAMES.length]}{' '}
							{tasks().find(task => task.running)?.title ??
								tasks()[0]?.title}
						</text>
					</Show>
					<text fg={colors().secondary} attributes={dim()}>
						{tasks()
							.filter(task => !task.running)
							.slice(0, 4)
							.map(
								task =>
									`${task.done ? '✓' : '○'} ${task.title}`,
							)
							.join(' · ')}
						{tasks().filter(task => !task.running).length > 4
							? ' …'
							: ''}
					</text>
				</Show>
				{/* Multi-line input: each WRAPPED line gets its own row (the
				    box grows with the text, no fixed single-row limit). */}
				<For each={inputLines()}>
					{(line, index) => (
						<box flexDirection="row">
							<text fg={colors().primary} attributes={bold()}>
								{index() === 0 ? `${colors().promptChar ?? '❯'} ` : '  '}
							</text>
							{/* The caret line splits at the cursor column (prefix
							    + caret + suffix); other lines render whole.
							    `<Show>` keeps the split REACTIVE, a plain
							    `last` const captured by the For callback stays
							    stale when the input grows, painting a second
							    caret on the previous line (Shift+Enter bug). */}
							<Show
								when={index() === cursorInfo().line}
								fallback={
									<For
										each={tokenizeInputLine(line, knownCommands())}
									>
										{(segment) => (
											<text
												fg={
													segment.token
														? colors().primary
														: colors().text
												}
											>
												{segment.text}
											</text>
										)}
									</For>
								}
							>
								<For
									each={tokenizeInputLine(
										line.slice(
											0,
											caretIndexFor(
												line,
												cursorInfo().column,
											),
										),
										knownCommands(),
									)}
								>
									{(segment) => (
										<text
											fg={
												segment.token
													? colors().primary
													: colors().text
											}
										>
											{segment.text}
										</text>
									)}
								</For>
								{/* BOX-BACKGROUND caret (parity: opencode): the
								    cell under the cursor is ALWAYS rendered
								    (the char at the cursor, or the LAST char at
								    end-of-line, or a space on an empty line),
								    highlighted when visible and PLAIN when
								    hidden, so the line width NEVER changes and
								    the text never shifts or adds a space. */}
								<text
									bg={
										cursorVisible()
											? activeRow().bg
											: undefined
									}
									fg={
										cursorVisible()
											? activeRow().fg
											: undefined
									}
								>
									{cursorVisible()
										? (line[
												caretIndexFor(
													line,
													cursorInfo().column,
												)
											] ?? ' ')
										: (line[
												caretIndexFor(
													line,
													cursorInfo().column,
												)
											] ?? ' ')}
								</text>
								<For
									each={tokenizeInputLine(
										line.slice(
											caretIndexFor(
												line,
												cursorInfo().column,
											) + 1,
										),
										knownCommands(),
									)}
								>
									{(segment) => (
										<text
											fg={
												segment.token
													? colors().primary
													: colors().text
											}
										>
											{segment.text}
										</text>
									)}
								</For>
							</Show>
							<Show
								when={
									index() === inputLines().length - 1 &&
									input().length === 0
								}
							>
								<text fg={CHALK_GREY}>/ commands, ! bash, ↑/↓ history</text>
							</Show>
						</box>
					)}
				</For>
				<Show when={cancelling() && !busy()}>
					<text fg={colors().secondary}>Press Esc to cancel</text>
				</Show>
			</Show>
				</box>
				{/* Two-tone corner overlay on the bottom border line: the model
				    name is primary-bold, the effort badge + ctx stay secondary
				    (bottomTitle is a single-color string, so this replaces it). */}
				<box
					position="absolute"
					top={boxHeight() - 1}
					right={1}
					flexDirection="row"
				>
					<text fg={colors().primary} attributes={bold()}>
						{corner().model}
					</text>
					<text fg={colors().secondary}>{corner().effort}</text>
					<text fg={colors().secondary}>{corner().ctx}</text>
				</box>
			</box>
		</box>
	);
}

/**
 * Input-box total height (borders included) for a given input/menu/busy
 * state, shared with the App so the chat history can size itself to the
 * remaining terminal rows.
 */
export function computeInputBoxHeight(
	inputText: string,
	terminalWidth: number,
	isBusy: boolean,
	tasksCount: number,
	promptActive = false,
	approvalActive = false,
	isCancelling = false,
): number {
	// Prompt/approval wizards occupy 3 interior rows: question/approval line,
	// an empty spacer, and the "Press Esc to cancel" hint.
	if (promptActive || approvalActive) return 3 + 2;
	// The input GROWS with its wrapped lines, long text no longer clips.
	let interior = Math.max(
		1,
		wrapText(inputText, Math.max(10, terminalWidth - 12)).length,
	);
	// Task overlay: running header + list while busy, list-only when settled.
	if (tasksCount > 0) interior += isBusy ? 2 : 1;
	// Cancelling row (`Press Esc to cancel` while the abort unwinds).
	if (isCancelling && !isBusy) interior += 1;
	return interior + 2; // top + bottom borders
}

/**
 * Command-completion popup height (borders + match rows), the popup renders
 * ABOVE the input box, so the App subtracts it from the history height.
 */
export function completionPopupHeight(
	inputText: string,
	width = 100,
): number {
	if (!inputText.startsWith('/') || inputText.includes(' ')) return 0;
	const name = inputText.slice(1);
	const all: string[] = [
		...commandNames(),
		...customCommandNames(),
		...loadSkills().map(skill => `skill:${skill.name}`),
	];
	const matches: Array<{command: string; score: number}> = name
		? all
				.map(command => ({command, score: fuzzyScore(name.toLowerCase(), command)}))
				.filter(entry => entry.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 50)
		: all.slice(0, 6).map(command => ({command, score: 1}));
	if (matches.length === 0) return 0;
	const windowed = matches.slice(0, 6);
	// Borderless + windowed: each suggestion renders up to 2 lines (wrapped
	// description), so the popup height is the SUM of the row line counts.
	const descWidth = Math.max(24, width - 42);
	const custom = new Map(
		loadCustomCommands().map(command => [command.name, command.description]),
	);
	return windowed.reduce((sum, entry) => {
		const description =
			COMMAND_DESCRIPTIONS[entry.command] ??
			custom.get(entry.command) ??
			(entry.command.startsWith('mock:')
				? 'Preview scenario'
				: 'Run command');
		return sum + wrapDescription(description, descWidth).length;
	}, 0);
}

/** `@` file-mention popup height (borders + match rows). */
export function mentionPopupHeight(inputText: string): number {
	const token = mentionToken(inputText);
	if (token === null) return 0;
	const all = listProjectFiles();
	const q = token.toLowerCase();
	const matches = q
		? all.filter(path => fuzzyScore(q, path) > 0).slice(0, 6)
		: all.slice(0, 6);
	return matches.length > 0 ? matches.length + 2 : 0;
}

/**
 * Split an input line into normal text + PRIMARY tokens: `[Image #N]` /
 * `[Text #N]` attachment blocks and KNOWN `/commands` ANYWHERE in the line
 * (parity: openclaude highlights a real command even mid-message). An
 * unknown `/word` stays plain, only commands that actually exist get the
 * primary color.
 */
export function tokenizeInputLine(
	line: string,
	known?: Set<string>,
): Array<{text: string; token: boolean}> {
	const parts: Array<{text: string; token: boolean}> = [];
	// The component passes a frame-cached set; tests omit it (built on call).
	const knownSet =
		known ??
		new Set<string>([
			...commandNames(),
			...customCommandNames(),
			...loadSkills().map(skill => `skill:${skill.name}`),
		]);
	let cursor = 0;
	for (const match of line.matchAll(
		/\[(?:Image|Text) #\d+\]|\/[^\s]*/g,
	)) {
		const at = match.index ?? 0;
		if (at > cursor) {
			parts.push({text: line.slice(cursor, at), token: false});
		}
		const token = match[0];
		const isCommand =
			token.startsWith('/') && knownSet.has(token.slice(1));
		parts.push({
			text: token,
			token: isCommand || /^\[(?:Image|Text) #\d+\]$/.test(token),
		});
		cursor = at + token.length;
	}
	if (cursor < line.length) parts.push({text: line.slice(cursor), token: false});
	return parts.length > 0 ? parts : [{text: line, token: false}];
}

/**
 * The cell the box-background caret occupies: the char under the cursor, or
 * a TRAILING cell AFTER the last char when the cursor is at the end (a
 * highlighted space, standard block-cursor position). The caret cell always
 * renders (highlighted when visible, plain when hidden) so the input text
 * NEVER changes width or moves.
 */
export function caretIndexFor(line: string, column: number): number {
	if (column < line.length) return column;
	return line.length;
}

/**
 * Atomic input tokens (their raw [start, end) ranges): ONLY the bracketed
 * attachment blocks (`[Image #N]` / `[Text #N]`). Arrow keys/backspace jump
 * over these as ONE unit so the caret never lands inside a block, a
 * `/command` stays ordinary text (deletes/jumps char-by-char).
 */
export function atomicTokens(
	value: string,
): Array<{start: number; end: number}> {
	const tokens: Array<{start: number; end: number}> = [];
	for (const match of value.matchAll(/\[(?:Image|Text) #\d+\]/g)) {
		tokens.push({
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		});
	}
	return tokens;
}

/**
 * Ctrl+Left WORD-JUMP target (parity: the original nanocoder text-input,
 * readline Alt+B): skip whitespace (spaces + newlines) backward, then the
 * word backward. Newlines count as whitespace, so the jump crosses line
 * boundaries in a multiline input. Pure, unit-tested.
 */
export function moveToPrevWord(value: string, offset: number): number {
	let i = offset;
	// Skip whitespace (spaces + newlines) backward, then word backward
	while (i > 0 && (value[i - 1] === ' ' || value[i - 1] === '\n')) i--;
	while (i > 0 && value[i - 1] !== ' ' && value[i - 1] !== '\n') i--;
	return i;
}

/**
 * Ctrl+Right WORD-JUMP target (readline Alt+F): skip the word forward, then
 * the following whitespace (spaces + newlines). Pure, unit-tested.
 */
export function moveToNextWord(value: string, offset: number): number {
	let i = offset;
	// Skip word forward, then whitespace (spaces + newlines) forward
	while (i < value.length && value[i] !== ' ' && value[i] !== '\n') i++;
	while (i < value.length && (value[i] === ' ' || value[i] === '\n')) i++;
	return i;
}

/**
 * If a word-jump target lands STRICTLY INSIDE an atomic token, snap it to
 * the token's start ('left') or end ('right') so the caret never splits a
 * `[Image #N]` / `[Text #N]` block (parity: the original's
 * snapOutOfPlaceholder). Pure, unit-tested.
 */
export function snapOutOfAtomicToken(
	value: string,
	offset: number,
	direction: 'left' | 'right',
): number {
	for (const token of atomicTokens(value)) {
		if (offset > token.start && offset < token.end) {
			return direction === 'left' ? token.start : token.end;
		}
	}
	return offset;
}

/** Length of an atomic token whose END sits exactly at `cursor`, else null. */
export function tokenEndingAt(value: string, cursor: number): number | null {
	for (const token of atomicTokens(value)) {
		if (token.end === cursor) return token.end - token.start;
	}
	return null;
}

/** Length of an atomic token whose START sits exactly at `cursor`, else null. */
export function tokenStartingAt(value: string, cursor: number): number | null {
	for (const token of atomicTokens(value)) {
		if (token.start === cursor) return token.end - token.start;
	}
	return null;
}

/**
 * Map a raw-input cursor offset to the rendered (line, column) inside the
 * wrapped input rows, the caret paints at this position.
 */
export function cursorPosition(
	text: string,
	cursor: number,
	width: number,
): {line: number; column: number} {
	return cursorPositionFromWrapped(wrapTextDetailed(text, width), cursor);
}

/**
 * Map a raw cursor offset to the rendered (line, column) from an
 * ALREADY-wrapped layout, the hot path wraps once and reuses it here.
 */
export function cursorPositionFromWrapped(
	wrapped: Array<{text: string; start: number}>,
	cursor: number,
): {line: number; column: number} {
	if (wrapped.length === 0) return {line: 0, column: 0};
	const last = wrapped[wrapped.length - 1]!;
	const total = last.start + last.text.length;
	const target = Math.min(Math.max(0, cursor), total);
	for (let i = 0; i < wrapped.length; i++) {
		const entry = wrapped[i]!;
		if (
			// STRICT `<` at the line end: a wrapped line that keeps its
			// trailing space ends at start+len, but the NEXT raw char belongs
			// to the following line, so the caret must land there instead of
			// snapping back to the trailing space.
			target < entry.start + entry.text.length ||
			i === wrapped.length - 1
		) {
			return {
				line: i,
				column: Math.max(
					0,
					Math.min(target - entry.start, entry.text.length),
				),
			};
		}
	}
	return {
		line: wrapped.length - 1,
		column: wrapped[wrapped.length - 1]!.text.length,
	};
}

/**
 * Raw-input offset for a caret placed at (line, column) in the WRAPPED rows
 * (column clamped to the line length), used by ↑/↓ vertical movement.
 */
export function offsetForLine(
	wrapped: Array<{text: string; start: number}>,
	line: number,
	column: number,
): number {
	if (wrapped.length === 0) return 0;
	const entry = wrapped[Math.min(Math.max(0, line), wrapped.length - 1)]!;
	return entry.start + Math.min(Math.max(0, column), entry.text.length);
}

/** F1: 100 prefix, 50 substring, 20 per sequential-char subsequence. */
function fuzzyScore(query: string, command: string): number {
	const target = command.toLowerCase();
	if (target.startsWith(query)) return 100;
	if (target.includes(query)) return 50;
	let score = 0;
	let cursor = 0;
	for (const char of query) {
		const at = target.indexOf(char, cursor);
		if (at === -1) return 0;
		score += 20;
		cursor = at + 1;
	}
	return score;
}
