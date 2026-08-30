/** @jsxImportSource @opentui/solid */
import {readdirSync} from 'node:fs';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {createTextAttributes} from '@opentui/core';
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {
	COMMAND_DESCRIPTIONS,
	commandNames,
	customCommandNames,
} from '../commands';
import {loadCustomCommands, loadSkills} from '../custom';
import {
	insertMention,
	listProjectFiles,
	mentionPathText,
	mentionSearchToken,
	mentionToken,
} from '../mentions';
import {
	expandTextPlaceholders,
	processPaste,
	referencedImageAttachments,
} from '../attachments';
import {estimateTokens} from '../tokenize';
import {wrapText, wrapTextDetailed} from '../text-wrap';
import {
	activeEndpoint,
	anyModalOpen,
	busy,
	cancelling,
	completionMessage,
	completionTone,
	context,
	contextPercent,
	exitConfirm,
	gearGlyph,
	reasoning,
	thinkingMode,
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
	sessionId,
	spinnerFrame,
	SPINNER_FRAMES,
	streaming,
	thinkingActive,
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
} from '../state';
import {CHALK_GREY, colors} from '../theme';
import {loadSettings, saveSettings} from '../settings';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {liveThoughtOneLine} from './history';
import {historyFillWidth} from '../history-width';

/**
 * Hide-thinking indicator label: "Thinking…" ONLY while the model is in the
 * reasoning phase (reply text rendering ⇒ Working again). Pure, unit-tested.
 */
export function workingLabel(
	mode: 'hidden' | 'show' | 'line',
	thinking: boolean,
): string {
	return (mode === 'hidden' || mode === 'line') && thinking
		? 'Thinking'
		: 'Working';
}

/**
 * Whether the LINE-mode thinking ticker row is visible. It shows ONLY while
 * the model is ACTIVELY thinking (`thinkingActive`, true from the first
 * reasoning delta until text streams or the stream ends) — never during tool
 * execution or while idle, so a stale reasoning buffer can't leave a stuck
 * line or an empty gap above the input. The App subtracts this row from the
 * history-height cap so the input box never shifts down onto the status
 * line. Pure, unit-tested.
 */
export function lineTickerVisible(
	mode: 'hidden' | 'show' | 'line',
	isBusy: boolean,
	activelyThinking: boolean,
): boolean {
	return mode === 'line' && isBusy && activelyThinking;
}

/** Leading `!` enters direct-shell mode; marker becomes prompt glyph. */
export function isBashMode(value: string): boolean {
	return value.startsWith('!');
}

/** Shell marker is UI state, not duplicated inside editable command text. */
export function bashDisplayValue(value: string): string {
	return isBashMode(value) ? value.slice(1) : value;
}

/** Bash-mode label occupies one row above input border. */
export function bashModeIndicatorRows(value: string): number {
	return isBashMode(value) ? 1 : 0;
}

/** Printable character from OpenTUI key event, including shifted punctuation. */
export function typedInputChar(event: {name: string; shift?: boolean}): string {
	const char = event.name;
	if (char.length !== 1) return '';
	if (!event.shift) return char;
	const shiftedPunctuation: Record<string, string> = {
		'1': '!',
		'2': '@',
		'3': '#',
		'4': '$',
		'5': '%',
		'6': '^',
		'7': '&',
		'8': '*',
		'9': '(',
		'0': ')',
		'-': '_',
		'=': '+',
		'[': '{',
		']': '}',
		';': ':',
		"'": '"',
		',': '<',
		'.': '>',
		'/': '?',
	};
	return shiftedPunctuation[char] ?? char.toUpperCase();
}

/**
 * Whether an OpenTUI key event should count as the SUBMIT Enter.
 *
 * Real terminals deliver Enter as `\r` (`return`); herdr and some terminal
 * multiplexers deliver it as `\n` (`linefeed`) instead. A bare linefeed must
 * submit, NOT insert a literal newline — otherwise the typed prompt stays in
 * the box and the user sees "Enter does nothing" until they exit and resume.
 * Shift+Enter (multiline) is still handled separately before this check.
 * Pure, unit-tested.
 */
export function isSubmitKey(event: {
	name: string;
	sequence?: string;
	raw?: string;
	shift?: boolean;
	ctrl?: boolean;
	meta?: boolean;
}): boolean {
	return (
		event.name === 'return' ||
		event.name === 'enter' ||
		// herdr sends Enter as a bare linefeed (`\n`), never `\r`.
		(event.name === 'linefeed' && !event.shift && !event.ctrl && !event.meta)
	);
}
/**
 * Whether a key event should insert a literal newline (multiline input)
 * instead of submitting. Every terminal/emulator shape is covered:
 *  - herdr delivers Enter as a bare `linefeed`; a MODIFIED linefeed is
 *    Shift+Enter / Ctrl+Enter / Meta+Enter — insert, never submit.
 *  - real terminals deliver Shift+Enter / Ctrl+Enter as return+shift/ctrl.
 *  - xterm bare-LF paste shapes (`\n` in sequence/raw) that are not the
 *    herdr submit linefeed.
 * Pure, unit-tested (the per-pane Shift+Enter regression).
 */
export function isNewlineInsert(event: {
	name: string;
	sequence?: string;
	raw?: string;
	shift?: boolean;
	ctrl?: boolean;
	meta?: boolean;
}): boolean {
	// readline Ctrl+J always inserts a newline.
	if (event.ctrl && event.name === 'j') return true;
	// herdr: Enter = linefeed; Shift/Ctrl/Meta + linefeed = newline.
	if (event.name === 'linefeed') {
		return Boolean(event.shift || event.ctrl || event.meta);
	}
	// Real terminals: Shift+Enter / Ctrl+Enter on return/enter = newline.
	if (event.name === 'return' || event.name === 'enter') {
		return Boolean(event.shift || event.ctrl);
	}
	// Bare-LF shapes that are not herdr's submit linefeed (paste chunks).
	return event.sequence === '\n' || event.raw === '\n';
}

/**
 * Input row, parity with nanocoder's prompt line: `❯ <value>▌` plus a busy
 * hint. ↑/↓ navigate prompt history (draft preserved), typing `/` opens a
 * fuzzy command-suggestion menu (Tab completes), and Enter submits, chat
 * messages queue while busy, slash commands act immediately.
 */
export function InputBox(props: {
	onSubmit: (value: string, attachments?: Record<string, string>) => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const [draft, setDraft] = createSignal('');
	// ---- Cursor-aware input editing --------------------------------------
	// The input tracks a cursor index (parity: Ink's TextInput). Arrow keys
	// move it; attachment tokens (`[Image #N]` / `[Text #N]`) and a leading
	// `/command` are ATOMIC, arrows/backspace jump over them instead of
	// landing inside the token.
	const [cursorPos, setCursorPos] = createSignal(input().length);
	// Keep desired column across short/blank lines. Without this, moving up
	// through a blank row clamps to column 0 permanently, so next ↑ lands on
	// the `L` of previous line instead of original column.
	let verticalGoalColumn: number | null = null;
	const resetVerticalGoal = (): void => {
		verticalGoalColumn = null;
	};
	// App-level actions (/undo, command insertion, resume helpers) can replace
	// input without knowing local caret. Treat those writes like terminal
	// paste targets: caret belongs at end. Local edits mark their own value so
	// this effect never overrides deliberate cursor movement.
	let locallyWrittenInput = input();
	const writeInput = (value: string): void => {
		locallyWrittenInput = value;
		setInput(value);
	};
	createEffect(() => {
		const value = input();
		if (value === locallyWrittenInput) return;
		locallyWrittenInput = value;
		setCursorPos(value.length);
	});
	const insertAtCursor = (text: string): void => {
		resetVerticalGoal();
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		writeInput(value.slice(0, c) + text + value.slice(c));
		setCursorPos(c + text.length);
	};
	const setInputAt = (value: string, cursor = value.length): void => {
		writeInput(value);
		setCursorPos(Math.min(Math.max(0, cursor), value.length));
	};
	const deleteBeforeCursor = (): void => {
		resetVerticalGoal();
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c === 0) return;
		const len = tokenEndingAt(value, c) ?? 1;
		writeInput(value.slice(0, c - len) + value.slice(c));
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
		resetVerticalGoal();
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c >= value.length) return;
		const len = tokenStartingAt(value, c) ?? 1;
		writeInput(value.slice(0, c) + value.slice(c + len));
	};
	const moveCursorLeft = (): void => {
		resetVerticalGoal();
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c === 0) return;
		const len = tokenEndingAt(value, c) ?? 1;
		setCursorPos(c - len);
	};
	const moveCursorRight = (): void => {
		resetVerticalGoal();
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		if (c >= value.length) return;
		const len = tokenStartingAt(value, c) ?? 1;
		setCursorPos(c + len);
	};
	/** Ctrl+Left: jump to the start of the previous word (parity: the
	 *  original nanocoder text-input, readline Alt+B semantics). */
	const moveCursorPrevWord = (): void => {
		resetVerticalGoal();
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		setCursorPos(
			Math.max(
				isBashMode(value) ? 1 : 0,
				snapOutOfAtomicToken(value, moveToPrevWord(value, c), 'left'),
			),
		);
	};
	/** Ctrl+Right: jump to just past the next word (readline Alt+F). */
	const moveCursorNextWord = (): void => {
		resetVerticalGoal();
		const value = input();
		const c = Math.min(cursorPos(), value.length);
		setCursorPos(
			snapOutOfAtomicToken(value, moveToNextWord(value, c), 'right'),
		);
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
		const target = direction === 'up' ? info.line - 1 : info.line + 1;
		if (target < 0 || target >= lines.length) return false;
		if (verticalGoalColumn === null) verticalGoalColumn = info.column;
		setCursorPos(
			offsetForLine(lines, target, verticalGoalColumn) +
				(isBashMode(input()) ? 1 : 0),
		);
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
		// A modal owns the screen while open — paste must land in the
		// modal's field, never leak into the chat box behind it.
		if (anyModalOpen()) return;
		const text = new TextDecoder().decode(event.bytes);
		const {text: compact, attachments} = processPaste(
			text,
			pasteAttachments(),
			{
				sessionId: sessionId(),
			},
		);
		setPasteAttachments(attachments);
		insertAtCursor(compact);
	});
	/** Submit with `[Text #N]` expanded back to the real pasted content. */
	let lastSubmittedValue = '';
	let lastSubmittedAt = 0;
	const submitExpanded = (value: string): void => {
		const trimmed = value.trim();
		if (!trimmed) return;
		// Clear BEFORE calling async app logic (vision fallback, slash-command
		// work, or queue insertion). Otherwise the old text remains painted
		// during that await and a second Enter queues it again.
		const now = Date.now();
		if (trimmed === lastSubmittedValue && now - lastSubmittedAt < 500) return;
		lastSubmittedValue = trimmed;
		lastSubmittedAt = now;
		const attachments = pasteAttachments();
		const submittedAttachments = referencedImageAttachments(
			trimmed,
			attachments,
		);
		const expanded = expandTextPlaceholders(trimmed, attachments);
		setInputAt('');
		setPasteAttachments({});
		props.onSubmit(expanded, submittedAttachments);
	};

	const typedChar = typedInputChar;

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
						Math.round((estimateTokens(text, model) / window) * 100),
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
					(command.startsWith('mock:') ? 'Preview scenario' : 'Run command'),
				prefix: '',
			});
		}
		for (const command of loadCustomCommands()) {
			items.push({
				name: command.name,
				kind: 'command',
				description: command.description,
				prefix: '',
			});
		}
		for (const skill of loadSkills()) {
			items.push({
				name: skill.name,
				kind: 'skill',
				description: skill.description,
				prefix: '',
			});
		}
		if (!name) {
			return items.slice(0, 50).map((item, index) => ({
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
		return (
			items
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
				}))
		);
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
		return [...slice].reverse().map((item, offset) => ({
			...item,
			index: sel + (slice.length - 1 - offset),
		}));
	});
	// `@` file-mention suggestions (parity: the reference mentions files).
	const mentionFiles = createMemo(() => {
		const token = mentionToken(input(), cursorPos());
		if (token === null) return [];
		const all = listProjectFiles();
		const cwd = process.cwd();
		const q = mentionSearchToken(token).toLowerCase();
		const scored = q
			? all
					.map(path => {
						const mention = mentionPathText(path, cwd);
						return {
							path,
							mention,
							score: Math.max(fuzzyScore(q, mention), fuzzyScore(q, path)),
						};
					})
					.filter(entry => entry.score > 0)
					.sort((a, b) => b.score - a.score)
					.slice(0, 6)
			: all.slice(0, 6).map(path => ({
					path,
					mention: mentionPathText(path, cwd),
					score: 0,
				}));
		// Fold the selection into the array, the reconciler's <For> only
		// re-renders when the `each` reference changes.
		return scored.map((entry, index) => ({
			path: entry.path,
			mention: entry.mention,
			score: entry.score,
			active: mentionSelected() === index,
		}));
	});
	// Box height grows with the command menu / task overlay (parity: the box
	// is prompt + one empty row by default, +1 per menu/task line while shown).
	const boxHeight = createMemo(() => {
		return computeInputBoxHeight(
			input(),
			terminalDimensions().width ?? 80,
			busy(),
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
	const bashMode = createMemo(() => isBashMode(input()));
	const displayValue = createMemo(() => bashDisplayValue(input()));
	const wrapped = createMemo(() =>
		wrapTextDetailed(displayValue(), inputWidth()),
	);
	const inputLines = createMemo(() => wrapped().map(entry => entry.text));
	// Caret position inside the WRAPPED rows (line + column), derived from
	// the raw-string cursor, never inside an atomic token.
	const cursorInfo = createMemo(() =>
		cursorPositionFromWrapped(
			wrapped(),
			Math.max(0, cursorPos() - (bashMode() ? 1 : 0)),
		),
	);
	// Known `/commands` (built-ins + custom + skills), built ONCE per frame,
	// NOT per tokenized line (the tokenizer runs once per input row).
	const knownCommands = createMemo(
		() =>
			new Set<string>([
				...commandNames(),
				...customCommandNames(),
				...loadSkills().map(skill => skill.name),
			]),
	);
	// Active suggestion-row palette (info tint + guaranteed-readable fg).
	const activeRow = createMemo(() => activeRowPalette(colors()));
	const approval = createMemo(() => pendingApproval());
	const prompt = createMemo(() => pendingPrompt());
	const [promptOption, setPromptOption] = createSignal(0);
	createEffect(() => {
		prompt();
		setPromptOption(0);
	});
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
	useKeyboard(event => {
		// Any key pauses the caret blink (visible while typing, debounced).
		forceCursorVisible();
		// Reset the fast-erase hold counter whenever a non-backspace key
		// arrives (a fresh keypress means a fresh, deliberate press).
		if (!isDeleteKey(event)) backspaceHold = 0;
		const pendingText = prompt();
		if (pendingText) {
			// The wizard prompt owns the key; claim it so the history
			// scrollbox's native vim keys (`k`/`j`/`h`/`l`) never scroll
			// behind it.
			event.preventDefault();
			if (event.name === 'escape') {
				// Esc cancels: value editors just dismiss, but prompts with an
				// explicit onCancel (e.g. the first-run trust gate) must NOT
				// silently continue, cancelling there declines trust (exit).
				setPendingPrompt(null);
				pendingText.onCancel?.();
			} else if (
				pendingText.options?.length &&
				(event.name === 'up' || event.name === 'down')
			) {
				setPromptOption(index =>
					event.name === 'down'
						? (index + 1) % pendingText.options!.length
						: (index - 1 + pendingText.options!.length) %
							pendingText.options!.length,
				);
			} else if (event.name === 'return') {
				const value =
					input().trim() || pendingText.options?.[promptOption()] || '';
				setInputAt('');
				setPendingPrompt(null);
				pendingText.resolve(value);
			} else if (isDeleteKey(event)) {
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
		// GAP-19: the MODALS own the keys while open (but a value editor
		// wizard opened FROM the panel must still receive keystrokes, so
		// prompts/approvals are handled above this gate).
		if (anyModalOpen()) {
			event.preventDefault();
			return;
		}
		// A6: Shift+Enter / Ctrl+J / a literal LF insert a newline AT THE
		// CURSOR, handled BEFORE the suggestion popups so a popup never
		// swallows the key (plain Enter still selects/completes/submits).
		const isReturnKey = isSubmitKey(event);
		if (isNewlineInsert(event)) {
			event.preventDefault();
			insertAtCursor('\n');
			setSelectedCompletion(0);
			setExitConfirm(false);
			return;
		}
		// `@` file-mention popup: ↑/↓ navigate, Enter inserts, Esc dismisses.
		const mentionMatches = mentionFiles();
		if (mentionMatches.length > 0 && !event.ctrl && !event.meta) {
			event.preventDefault();
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
				const cursor = cursorPos();
				const token = mentionToken(input(), cursor);
				if (item && token !== null) {
					const current = input();
					const next = insertMention(current, item.mention, token, cursor);
					setInputAt(next, next.length - current.slice(cursor).length);
				}
				setMentionSelected(0);
				return;
			}
			if (event.name === 'escape') {
				event.preventDefault();
				const cursor = cursorPos();
				const at = input().lastIndexOf('@', cursor - 1);
				setInputAt(
					at >= 0 ? input().slice(0, at) + input().slice(cursor) : input(),
				);
				setMentionSelected(0);
				return;
			}
		}
		// Command-completion popup: ↑/↓ navigate, Enter selects, Esc dismisses.
		const matches = completions();
		if (matches.length > 0 && !event.ctrl && !event.meta) {
			event.preventDefault();
			if (event.name === 'up') {
				// ↑ walks FORWARD through the list (bottom-anchored: the
				// selected item is at the bottom, navigation goes up).
				setSelectedCompletion(prev => Math.min(matches.length - 1, prev + 1));
				return;
			}
			if (event.name === 'down') {
				setSelectedCompletion(prev => Math.max(0, prev - 1));
				return;
			}
			if (event.name === 'return') {
				const item =
					matches[Math.min(selectedCompletion(), matches.length - 1)];
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
				event.preventDefault();
				setInputAt('');
				setSelectedCompletion(0);
				return;
			}
		}
		const pending = approval();
		if (pending) {
			event.preventDefault();
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
			event.preventDefault();
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
			event.preventDefault();
			// Multiline input: ↑ moves the caret up a VISUAL line; only on
			// the FIRST line does it fall through to history (parity: the
			// original's multiline PR + ink-text-input onEdgeArrow).
			if (moveCursorVertical('up')) return;
			// A non-empty multiline draft only moves to its first position when
			// caret is not already at the first raw line. At first-line edge,
			// allow prompt-history navigation instead of trapping ↑ at column 0.
			if (input().length > 0 && cursorPos() > 0) {
				setCursorPos(bashMode() ? 1 : 0);
				return;
			}
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
			event.preventDefault();
			// Multiline input: ↓ moves the caret down a VISUAL line; only on
			// the LAST line does it fall through to history.
			if (moveCursorVertical('down')) return;
			// Existing draft owns arrows. At bottom edge, move to end; history
			// navigation remains available only from an empty input.
			if (input().length > 0) {
				setCursorPos(input().length);
				return;
			}
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
			event.preventDefault();
			if (bashMode() && cursorPos() <= 1) return;
			// Ctrl+Left jumps WORD-WISE (parity: the original nanocoder
			// text-input); plain ← still walks char-by-char over tokens.
			if (event.ctrl) moveCursorPrevWord();
			else moveCursorLeft();
			return;
		}
		if (event.name === 'right') {
			event.preventDefault();
			if (event.ctrl) moveCursorNextWord();
			else moveCursorRight();
			return;
		}
		if (event.name === 'home') {
			event.preventDefault();
			resetVerticalGoal();
			setCursorPos(bashMode() ? 1 : 0);
			return;
		}
		if (event.name === 'end') {
			event.preventDefault();
			resetVerticalGoal();
			setCursorPos(input().length);
			return;
		}
		if (event.name === 'tab') {
			event.preventDefault();
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
					ORDER[
						(ORDER.indexOf(current as (typeof ORDER)[number]) + 1) %
							ORDER.length
					] ?? 'yolo';
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
						current.slice(0, current.length - token.length) + entries[0] + ' ',
					);
				}
			}
			return;
		}
		if (isReturnKey) {
			event.preventDefault();
			// Enter on a selected queued item loads it back into the input
			// for editing (and removes it from the queue).
			const queuedIndex = selectedQueued();
			if (queuedIndex >= 0 && queuedIndex < pendingQueue().length) {
				const value = pendingQueue()[queuedIndex]?.value ?? '';
				setInputAt(value);
				setPendingQueue(prev =>
					prev.filter((_, index) => index !== queuedIndex),
				);
				setSelectedQueued(-1);
				return;
			}
			const value = input().trim();
			if (!value) return;
			submitExpanded(value);
			return;
		}
		if (isDeleteKey(event)) {
			event.preventDefault();
			// Del on a selected queued item removes it.
			const queuedIndex = selectedQueued();
			if (
				queuedIndex >= 0 &&
				queuedIndex < pendingQueue().length &&
				input().length === 0
			) {
				setPendingQueue(prev =>
					prev.filter((_, index) => index !== queuedIndex),
				);
				setSelectedQueued(prev =>
					prev >= pendingQueue().length - 1 ? pendingQueue().length - 2 : prev,
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
			event.preventDefault();
			insertAtCursor(' ');
			setExitConfirm(false);
			return;
		}
		const char = typedChar(event);
		if (char && !event.ctrl && !event.meta) {
			// Claim every typed character so the history scrollbox's native
			// vim keys (`k`/`j`/`h`/`l`) never scroll while the user types.
			event.preventDefault();
			insertAtCursor(char);
			setExitConfirm(false);
		}
	});

	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	return (
		<box flexDirection="column">
			<Show when={bashMode()}>
				<box height={1}>
					<text fg={colors().primary} attributes={bold()}>
						Bash mode
					</text>
				</box>
			</Show>
			{/* Working indicator: FIXED above the input box (parity with
			    nanocoder's live region, never scrolled away). */}
			<Show when={busy()}>
				<box height={1}>
					<text
						fg={retryingAttempt() > 0 ? colors().warning : colors().primary}
					>
						{gearGlyph(spinnerFrame())}{' '}
						{workingLabel(thinkingMode(), thinkingActive())}
						{workingDots(spinnerFrame())} · ({formatElapsed(turnElapsed())})
						{retryingAttempt() > 0 ? ` · retrying (${retryingAttempt()})` : ''}{' '}
						· Esc to cancel
					</text>
				</box>
			</Show>
			{/* Line-mode thinking ticker: shows ONLY while the model is
			    ACTIVELY thinking (thinkingActive), hidden the moment thinking
			    stops — never a stale line during tool runs, never an empty gap
			    while idle. */}
			<Show when={lineTickerVisible(thinkingMode(), busy(), thinkingActive())}>
				<box height={1}>
					<text fg={colors().secondary} attributes={dim()}>
						{'  └ '}
						{liveThoughtOneLine(
							reasoning(),
							historyFillWidth(terminalDimensions().width ?? 80),
						)}
					</text>
				</box>
			</Show>
			{/* Post-open lazy-load indicator: ONE ROW PER service, each with
			    a BLINKING secondary ✦ glyph + ANIMATED dots, clearing
			    independently as its scan finishes (MCP/LSP/skills load at
			    different speeds). */}
			<Show when={startupLoading().length > 0 && !busy()}>
				<For each={startupLoading()}>
					{item => (
						<box height={1} flexDirection="row">
							{/* Width-stable glyph cell: the hidden blink
							    frame keeps a space so nothing shifts. */}
							<text fg={colors().secondary} attributes={dim()}>
								{glyphBlinkOn(spinnerFrame()) ? '✦' : ' '}{' '}
							</text>
							<text fg={colors().secondary} attributes={dim()}>
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
				<Show when={completionTone() === 'success'}>
					{/* Resume notice: a breakline separates it from the chat. */}
					<box height={1} />
				</Show>
				<box height={1}>
					<text
						fg={
							completionTone() === 'success'
								? colors().success
								: colors().secondary
						}
					>
						{completionMessage()}
					</text>
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
			    scroll away with the transcript). Every row is a FIXED-height
			    box — bare <text> nodes inside a fixed-height column overlap
			    (the header and the first message painted the same row).
			    Colors: header secondary, rows default text with a secondary
			    `(queued)` tag; ONLY the selected row gets the active-row
			    highlight (info bg + bold), so the block never floods the
			    screen with primary. */}
			<Show when={pendingQueue().length > 0}>
				<box flexDirection="column" height={pendingQueue().length + 1}>
					<box height={1} flexDirection="row">
						<text fg={colors().secondary} attributes={dim()}>
							Queued messages (↑/↓ select, Enter edit, Del remove):
						</text>
					</box>
					<For each={pendingQueue()}>
						{(message, index) => {
							const active = selectedQueued() === index();
							return (
								<box
									flexDirection="row"
									height={1}
									backgroundColor={active ? activeRow().bg : undefined}
									{...({
										onMouseMove: () => setSelectedQueued(index()),
										onMouseUp: () => {
											setSelectedQueued(index());
										},
									} as any)}
								>
									<text
										width={11}
										fg={active ? activeRow().fg : colors().secondary}
										attributes={active ? bold() : undefined}
									>
										{active ? '▸ ' : '  '}
										{'(queued)'}
									</text>
									{/* Fixed-width tag cell (11 = `▸ (queued)`): the
									    renderer TRIMS a text node's trailing space,
									    so `(queued) ` + value glued into
									    `(queued)feel`; a lone ' ' node and an empty
									    width-1 box both vanish. The width reserves
									    the cell (completion-row pattern), the next
									    node starts after it. */}
									<text fg={active ? activeRow().fg : colors().text}>
										{message.value}
									</text>
								</box>
							);
						}}
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
											const cursor = cursorPos();
											const token = mentionToken(input(), cursor);
											if (token !== null) {
												const current = input();
												const next = insertMention(
													current,
													item.mention,
													token,
													cursor,
												);
												setInputAt(
													next,
													next.length - current.slice(cursor).length,
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
										{active ? '❯ ' : '  '}@{item.mention}
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
			    column + a ONE-LINE description column (the 2-line wrap is
			    only for the settings modal lists) with the
			    description beside the slash name. */}
			<Show when={completions().length > 0}>
				<box flexDirection="column" height={completionWindow().length}>
					<For each={completionWindow()}>
						{item => {
							const active = item.active;
							return (
								// The WHOLE row is the hover/click target (parity:
								// the settings rows, hover navigates, click picks).
								<box
									flexDirection="row"
									height={1}
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
										onMouseMove: () => setSelectedCompletion(item.index),
									} as any)}
								>
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
											fg={active ? activeRow().fg : colors().primary}
											attributes={active ? bold() : undefined}
										>
											{item.prefix}
										</text>
									) : (
										<></>
									)}
									<text
										fg={active ? activeRow().fg : colors().secondary}
										attributes={active ? bold() : dim()}
									>
										{item.description}
									</text>
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
					borderColor={bashMode() ? colors().primary : colors().secondary}
					paddingLeft={1}
					flexDirection="column"
					height={boxHeight()}
				>
					<Show when={prompt()}>
						<text fg={colors().primary} attributes={bold()}>
							{prompt()?.question ?? ''}: {input()}▌
						</text>
						<box height={1} />
						<text fg={colors().secondary}>
							{prompt()?.options?.length
								? `↑/↓ ${prompt()?.options?.[promptOption()] ?? ''} · Enter select · type custom · Esc cancel`
								: 'Press Esc to cancel'}
						</text>
					</Show>
					<Show when={approval()}>
						<text fg={colors().error} attributes={bold()}>
							Approve ✦ {approval()?.name ?? ''}({approval()?.detail ?? ''}
							)? (y/n)
						</text>
						<box height={1} />
						<text fg={colors().secondary}>Press Esc to cancel</text>
					</Show>
					<Show when={!approval() && !prompt()}>
						{/* Multi-line input: each WRAPPED line gets its own row (the
				    box grows with the text, no fixed single-row limit). */}
						<For each={inputLines()}>
							{(line, index) => (
								<box flexDirection="row">
									<text fg={colors().primary} attributes={bold()}>
										{index() === 0
											? `${bashMode() ? '!' : (colors().promptChar ?? '❯')} `
											: '  '}
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
											<For each={tokenizeInputLine(line, knownCommands())}>
												{segment => (
													<text
														fg={
															segment.token ? colors().primary : colors().text
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
												line.slice(0, caretIndexFor(line, cursorInfo().column)),
												knownCommands(),
											)}
										>
											{segment => (
												<text
													fg={segment.token ? colors().primary : colors().text}
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
											bg={cursorVisible() ? activeRow().bg : undefined}
											fg={cursorVisible() ? activeRow().fg : undefined}
										>
											{cursorVisible()
												? (line[caretIndexFor(line, cursorInfo().column)] ??
													' ')
												: (line[caretIndexFor(line, cursorInfo().column)] ??
													' ')}
										</text>
										<For
											each={tokenizeInputLine(
												line.slice(
													caretIndexFor(line, cursorInfo().column) + 1,
												),
												knownCommands(),
											)}
										>
											{segment => (
												<text
													fg={segment.token ? colors().primary : colors().text}
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
		wrapText(bashDisplayValue(inputText), Math.max(10, terminalWidth - 12))
			.length,
	);
	// Cancelling row (`Press Esc to cancel` while the abort unwinds).
	if (isCancelling && !isBusy) interior += 1;
	return interior + 2; // top + bottom borders
}

/**
 * Rows the completion notice occupies ABOVE the input. The resume notice
 * (success tone) renders a leading breakline PLUS the message row; every
 * other completion line is a single row. The App subtracts this from the
 * history-height cap, so an unaccounted breakline pushes the status line
 * onto the input box.
 */
export function completionMessageRows(
	message: string,
	tone: 'default' | 'success',
): number {
	if (!message) return 0;
	return tone === 'success' ? 2 : 1;
}

/**
 * Command-completion popup height (borders + match rows), the popup renders
 * ABOVE the input box, so the App subtracts it from the history height.
 */
export function completionPopupHeight(inputText: string, _width = 100): number {
	if (!inputText.startsWith('/') || inputText.includes(' ')) return 0;
	const name = inputText.slice(1);
	const all: string[] = [
		...commandNames(),
		...customCommandNames(),
		...loadSkills().map(skill => skill.name),
	];
	const matches: Array<{command: string; score: number}> = name
		? all
				.map(command => ({
					command,
					score: fuzzyScore(name.toLowerCase(), command),
				}))
				.filter(entry => entry.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 50)
		: all.slice(0, 6).map(command => ({command, score: 1}));
	// Borderless + windowed: one line per suggestion.
	return matches.length > 0 ? Math.min(6, matches.length) : 0;
}

/** `@` file-mention popup height (borders + match rows). */
export function mentionPopupHeight(inputText: string): number {
	const token = mentionToken(inputText);
	if (token === null) return 0;
	const all = listProjectFiles();
	const cwd = process.cwd();
	const q = mentionSearchToken(token).toLowerCase();
	const matches = q
		? all
				.filter(path => {
					const mention = mentionPathText(path, cwd);
					return Math.max(fuzzyScore(q, mention), fuzzyScore(q, path)) > 0;
				})
				.slice(0, 6)
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
	// An empty line has no parts: OpenTUI renders an EMPTY `<text>` as one
	// real cell, so a `[{text:''}]` part paints a phantom space before the
	// caret and pushes the block cursor one column forward on empty lines
	// (the Shift+Enter continuation line regression).
	if (line.length === 0) return [];
	const parts: Array<{text: string; token: boolean}> = [];
	// The component passes a frame-cached set; tests omit it (built on call).
	const knownSet =
		known ??
		new Set<string>([
			...commandNames(),
			...customCommandNames(),
			...loadSkills().map(skill => skill.name),
		]);
	let cursor = 0;
	for (const match of line.matchAll(/\[(?:Image|Text) #\d+\]|\/[^\s]*/g)) {
		const at = match.index ?? 0;
		if (at > cursor) {
			parts.push({text: line.slice(cursor, at), token: false});
		}
		const token = match[0];
		const isCommand = token.startsWith('/') && knownSet.has(token.slice(1));
		parts.push({
			text: token,
			token: isCommand || /^\[(?:Image|Text) #\d+\]$/.test(token),
		});
		cursor = at + token.length;
	}
	if (cursor < line.length)
		parts.push({text: line.slice(cursor), token: false});
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
		const end = entry.start + entry.text.length;
		const next = wrapped[i + 1];
		// Empty explicit lines own their exact raw offset.
		if (entry.text.length === 0 && target === entry.start) {
			return {line: i, column: 0};
		}
		// At a SOFT-wrap boundary next.start === end, caret belongs to next
		// visual row. At a NEWLINE boundary next.start > end, caret at end
		// belongs after current line's last character.
		if (
			target < end ||
			(target === end && (!next || next.start > end)) ||
			i === wrapped.length - 1
		) {
			return {
				line: i,
				column: Math.max(0, Math.min(target - entry.start, entry.text.length)),
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
