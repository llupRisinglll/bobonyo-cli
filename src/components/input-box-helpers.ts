import {commandNames, customCommandNames} from '../commands';
import {loadCustomCommands, loadSkills} from '../custom';
import {wrapTextDetailed} from '../text-wrap';

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
export function fuzzyScore(query: string, command: string): number {
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
