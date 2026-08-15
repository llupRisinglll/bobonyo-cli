import {RGBA, createTextAttributes, type TextChunk} from '@opentui/core';
import type {Colors} from './theme';
import {commandNames, customCommandNames} from './commands';
import {loadSkills} from './custom';
import {
	languageForPath,
	tokenizeBash,
	tokenizeCode,
	themeColors,
	type ThemePalette,
} from './highlight';

/**
 * Tool-row renderers. Each row is embedded in the transcript as a fenced
 * code block with a custom language (` ```toolrow:done ` etc.); the History
 * renderNode builds a CodeRenderable whose onChunks returns these colored
 * chunks. Colors come from the ACTIVE theme.
 *
 * Row status controls the glyph color: done = success, running/bg =
 * secondary (bg is static, running blinks, the blink itself is handled by
 * the History ticker swapping the glyph between ✦ and a space).
 */

export type RowStatus = 'done' | 'running' | 'bg';

export type Palette = ThemePalette;

function chunk(text: string, fg: RGBA | undefined, attributes = 0): TextChunk {
	return {__isChunk: true, text, ...(fg ? {fg} : {}), attributes};
}

function bold(): number {
	return createTextAttributes({bold: true});
}

function dim(): number {
	return createTextAttributes({dim: true});
}

function italic(): number {
	return createTextAttributes({italic: true});
}

export function glyphColor(status: RowStatus, palette: Palette): RGBA {
	// done = success; running/bg = secondary (parity: ToolGlyph).
	return status === 'done' ? palette.fg.success : palette.fg.secondary;
}

/**
 * Glyph color for a SETTLED tool/thought row. Tools follow the row status
 * (done = success green, running/bg = secondary); THOUGHTS stay secondary
 * in every state — thinking is optional info, never a success signal, and
 * the gear is static (parity: tokenizeThought colors the header
 * secondary/dim always). Pure, unit-tested.
 */
export function settledGlyphColor(
	glyph: '✦' | '⚙',
	status: RowStatus,
	palette: Palette,
): RGBA {
	if (glyph === '⚙') return palette.fg.secondary;
	return glyphColor(status, palette);
}

function emitLines(
	lines: string[],
	render: (line: string, index: number, isHeader: boolean) => TextChunk[],
	defaultFg: RGBA,
): TextChunk[] {
	const chunks: TextChunk[] = [];
	const headerAt = lines.findIndex(line => line.trim() !== '');
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) chunks.push(chunk('\n', defaultFg));
		chunks.push(...render(lines[i] ?? '', i, i === headerAt));
	}
	return chunks;
}

/**
 * Longest common PREFIX and SUFFIX of two strings, the unchanged outer
 * parts of a changed line (the middle is the word-level diff).
 */
function commonAffix(
	a: string,
	b: string,
): [prefix: string, middle: string, suffix: string] {
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	const prefix = a.slice(0, p);
	let s = 0;
	while (
		s < a.length - p &&
		s < b.length - p &&
		a[a.length - 1 - s] === b[b.length - 1 - s]
	) {
		s++;
	}
	const suffix = s > 0 ? a.slice(a.length - s) : '';
	const middle = a.slice(p, a.length - s);
	return [prefix, middle, suffix];
}

/**
 * Compact GROUP header: `✦ Ran WebSearch ×2 and WebFetch (hint)`, `Ran `,
 * the `×N` tally and the `and`/`, ` separators are WHITE (body text, they
 * are part of the sentence, not optional info); ONLY the tool names are
 * primary; the trailing `(hint)` stays secondary (parity:
 * CompactToolCountsLine + the "secondary is for output/optional info" rule).
 * The leading glyph is OPTIONAL: liveRowSegments strips it (it renders
 * separately/blinks), so the tokenizer also receives glyph-less
 * `Ran Read ×2` headers and must color them the same way.
 */
function groupHeaderChunks(
	line: string,
	status: RowStatus,
	palette: Palette,
): TextChunk[] {
	const m = line.match(/^([✦⚙]\s*)?(Ran\s+)(.*)$/);
	if (!m) return headerChunks(line, status, palette, palette.fg.text);
	const chunks: TextChunk[] = [];
	if (m[1]) chunks.push(chunk(m[1], glyphColor(status, palette)));
	chunks.push(chunk(m[2] ?? '', palette.fg.text));
	const rest = m[3] ?? '';
	const hintAt = rest.search(/\(ctrl-o|\(ctrl \+ t/);
	// Keep the space that separated the names from the hint (names.trim()
	// below would otherwise drop it, gluing `×2(ctrl-o` together).
	const hintStart =
		hintAt === -1
			? -1
			: hintAt > 0 && rest[hintAt - 1] === ' '
				? hintAt - 1
				: hintAt;
	const names = hintStart === -1 ? rest : rest.slice(0, hintStart);
	const hint = hintStart === -1 ? '' : rest.slice(hintStart);
	for (const token of names.trim().split(/( and |, | ×\d+)/)) {
		if (!token) continue;
		if (/^( and |, | ×\d+)$/.test(token) || /^\s+$/.test(token)) {
			chunks.push(chunk(token, palette.fg.text));
		} else {
			chunks.push(chunk(token, palette.fg.primary, bold()));
		}
	}
	if (hint) chunks.push(chunk(hint, palette.fg.secondary));
	return chunks;
}

/** `✦ Name(detail)` header: glyph by status, name primary bold, detail secondary. */
function headerChunks(
	line: string,
	status: RowStatus,
	palette: Palette,
	defaultFg: RGBA,
	inside?: (text: string) => TextChunk[],
): TextChunk[] {
	const chunks: TextChunk[] = [];
	let rest = line;
	// Leading glyph (✦/⚙) + space.
	const glyph = rest.match(/^[✦⚙]\s*/);
	if (glyph) {
		chunks.push(chunk(glyph[0], glyphColor(status, palette)));
		rest = rest.slice(glyph[0].length);
	}
	// Tool name up to the first '(' or end of line.
	const open = rest.indexOf('(');
	if (open === -1) {
		chunks.push(chunk(rest, palette.fg.primary, bold()));
		return chunks;
	}
	chunks.push(chunk(rest.slice(0, open), palette.fg.primary, bold()));
	chunks.push(chunk('(', palette.fg.secondary));
	const inner = rest.slice(open + 1);
	const close = inner.lastIndexOf(')');
	if (close === -1) {
		chunks.push(...(inside ? inside(inner) : [chunk(inner, defaultFg)]));
		return chunks;
	}
	const content = inner.slice(0, close);
	chunks.push(...(inside ? inside(content) : [chunk(content, defaultFg)]));
	chunks.push(chunk(')', palette.fg.secondary));
	// Trailing status suffix (e.g. ` (running)` / ` completed`).
	const tail = inner.slice(close + 1);
	if (tail) chunks.push(chunk(tail, palette.fg.secondary));
	return chunks;
}

const TOOL_NAME_RE = /^([A-Za-z][A-Za-z0-9 _-]*?)(?:\(|$)/;

/** Generic tool row: `✦ Name(detail)` + `└` output tail (secondary). */
export function tokenizeToolRow(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				if (/^(?:[✦⚙]\s*)?Ran\s+/.test(line)) {
					return groupHeaderChunks(line, status, palette);
				}
				const m = line.match(/^([✦⚙]\s*)([A-Za-z]+)(\s+.*)$/);
				if (m) {
					return [
						chunk(m[1] ?? '', glyphColor(status, palette)),
						chunk(m[2] ?? '', palette.fg.primary, bold()),
						chunk(m[3] ?? '', palette.fg.secondary),
					];
				}
				return headerChunks(line, status, palette, defaultFg);
			}
			if (/^[✦⚙]/.test(line))
				return headerChunks(line, status, palette, defaultFg);
			// Output / footer rows are secondary (container semantics).
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/**
 * Triggered-command row (`✦ Triggered a Command(name)`): ONLY the word
 * `Command` is primary (the tool-name convention); the glyph, `Triggered a`,
 * the parenthesized name and the `└` body all stay secondary (parity: the
 * user asked for the same format as tools).
 */
export function tokenizeCommandRow(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		(line, _index, isHeader) => {
			if (isHeader) {
				const m = line.match(/^([✦⚙]\s*)?(.*?\s)(Command|Skill)(\s*\(.*)$/);
				if (m) {
					return [
						...(m[1] ? [chunk(m[1], glyphColor(status, palette))] : []),
						// `Triggered a ` and `(name)` are WHITE (default text),
						// only the word Command/Skill is primary (parity: the
						// tool-name convention where Ran/details stay white).
						chunk(m[2] ?? '', defaultFg),
						chunk(m[3] ?? '', palette.fg.primary, bold()),
						chunk(m[4] ?? '', defaultFg),
					];
				}
				return headerChunks(line, status, palette, defaultFg);
			}
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/** Bash row: header with a bash-highlighted command, secondary output. */
export function tokenizeBashRow(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				// First content line is the COMMAND: `$ cmd` — the `$` prompt is
				// secondary, the command keeps its bash syntax highlighting.
				const cmd = line.match(/^\$\s?(.*)$/);
				if (cmd) {
					return [
						chunk('$ ', palette.fg.secondary),
						...tokenizeBash(cmd[1] ?? '', palette, defaultFg),
					];
				}
				return [chunk(line, palette.fg.secondary, dim())];
			}
			// Command continuation: `  cmd` (2-space indent, bash-highlighted).
			const continuation = line.match(/^\s{2}(.*)$/);
			if (continuation) {
				return [
					chunk('  ', palette.fg.secondary),
					...tokenizeBash(continuation[1] ?? '', palette, defaultFg),
				];
			}
			// `… +N more lines` footer inside the box: secondary dim.
			if (line.startsWith('…')) {
				return [chunk(line, palette.fg.secondary, dim())];
			}
			// Output lines: secondary dim.
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/** File preview: numbered content lines with per-language highlighting. */
export function tokenizeFileRow(
	text: string,
	path: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	// Only real code files get syntax colors — .txt/unknown extensions stay
	// plain text (a `.txt` preview must never read like JavaScript).
	const language = languageForPath(path);
	// The fenced token text carries a leading blank line after the opener,
	// strip it so the header is line 0 and the body cursor stays aligned.
	// Tabs break the native layout (a blank row after every tab-indented
	// preview line) — expand to spaces, indentation preserved.
	const lines = text
		.replace(/^\n+/, '')
		.replace(/\n+$/, '')
		.replace(/\t/g, '  ')
		.split('\n');
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				// `✦ Write <path>`, glyph by status, `Write` primary bold,
				// `<path>` secondary.
				const m = line.match(/^([✦⚙]\s*)([A-Za-z]+)(\s+.*)$/);
				if (m) {
					return [
						chunk(m[1] ?? '', glyphColor(status, palette)),
						chunk(m[2] ?? '', palette.fg.primary, bold()),
						chunk(m[3] ?? '', palette.fg.secondary),
					];
				}
				return headerChunks(line, status, palette, defaultFg);
			}
			if (line.startsWith(' ⎿') || line.startsWith('  ⎿')) {
				return [chunk(line, palette.fg.secondary, dim())];
			}
			const numbered = line.match(/^(\s*\d+\s+)(.*)$/);
			if (numbered) {
				const code = language
					? tokenizeCode(numbered[2] ?? '', language, palette, defaultFg)
					: [chunk(numbered[2] ?? '', defaultFg)];
				return [chunk(numbered[1] ?? '', palette.fg.secondary), ...code];
			}
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

export interface DiffLine {
	kind: 'context' | 'remove' | 'add';
	oldLineNo?: number;
	newLineNo?: number;
	text: string;
}

/** LCS-based line diff with old/new line numbers (parity: DiffView). */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
	const oldLines = oldStr === '' ? [] : oldStr.replace(/\n+$/, '').split('\n');
	const newLines = newStr === '' ? [] : newStr.replace(/\n+$/, '').split('\n');
	const n = oldLines.length;
	const m = newLines.length;
	const dp: number[][] = Array.from({length: n + 1}, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i]![j] =
				oldLines[i] === newLines[j]
					? (dp[i + 1]![j + 1] ?? 0) + 1
					: Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
		}
	}
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;
	let oldNo = 1;
	let newNo = 1;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			result.push({
				kind: 'context',
				oldLineNo: oldNo++,
				newLineNo: newNo++,
				text: oldLines[i] ?? '',
			});
			i++;
			j++;
		} else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
			result.push({
				kind: 'remove',
				oldLineNo: oldNo++,
				text: oldLines[i] ?? '',
			});
			i++;
		} else {
			result.push({kind: 'add', newLineNo: newNo++, text: newLines[j] ?? ''});
			j++;
		}
	}
	while (i < n) {
		result.push({kind: 'remove', oldLineNo: oldNo++, text: oldLines[i] ?? ''});
		i++;
	}
	while (j < m) {
		result.push({kind: 'add', newLineNo: newNo++, text: newLines[j] ?? ''});
		j++;
	}
	return result;
}

/**
 * File edit diff: `✦ Edit <path>` header, ` ⎿ N lines → N lines`, then
 * colored +/- rows with line numbers (green add / red remove / dim context).
 */
export function tokenizeFileDiff(
	text: string,
	path: string,
	status: RowStatus,
	colors: Colors,
	width = 0,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	// Only real code files get syntax colors — .txt/unknown extensions stay
	// plain text (a `.txt` diff must never highlight `new` as a keyword).
	const language = languageForPath(path);
	// The fenced token text carries a leading blank line after the opener,
	// strip it so the header is line 0 and the body cursor stays aligned
	// (the parse loop indexes body rows from the same `lines` array).
	// TABS BREAK THE NATIVE LAYOUT: a `\t` in a text chunk makes OpenTUI
	// render a BLANK ROW after every tab-indented diff line (seen only in a
	// real terminal, not the test renderer). Expand tabs to spaces first —
	// the code's indentation is preserved (never flush) and the rows stay
	// contiguous.
	const lines = text
		.replace(/^\n+/, '')
		.replace(/\n+$/, '')
		.replace(/\t/g, '  ')
		.split('\n');
	// Parse the diff BODY (everything after the `✦ Edit`/`⎿` header rows)
	// into structured rows so remove/add runs can be paired 1:1 like the
	// original DiffView, never diff a line against an arbitrary neighbor.
	interface DiffBodyRow {
		raw: string;
		kind: 'context' | 'remove' | 'add';
		indent: string;
		sigil?: string;
		number?: string;
		text: string;
		// Word-diff middle span (char offsets within `text`); absent when the
		// line is unpaired or too different to word-highlight (parity:
		// computeDiffLines' changeRatioThreshold).
		word?: [number, number];
	}
	const body: DiffBodyRow[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const header = line.match(/^([✦⚙]\s*[A-Za-z]+\s+.+)$/);
		if (header && i === 0) {
			continue;
		}
		// ` ⎿ N lines → M lines` summary rows render through their own early
		// branch in the emit callback (they never consume a body entry).
		if (line.startsWith(' ⎿') || line.startsWith('  ⎿')) continue;
		// Number-first gutter (parity: the reference DiffView):
		// `   5 + function …` / `   5 - function …`. The sigil takes EXACTLY
		// one separator space, so the code's own leading indentation (tabs
		// in real code) stays in `text` — a greedy `\s+` would swallow it
		// and the added lines would render flush at column 0.
		const change = line.match(/^(\s*)(\d+\s+)([-+]) (.*)$/);
		if (change) {
			body.push({
				raw: line,
				kind: change[3] === '+' ? 'add' : 'remove',
				indent: change[1] ?? '',
				sigil: change[3],
				number: change[2],
				text: change[4] ?? '',
			});
			continue;
		}
		const context = line.match(/^(\s*)(\d+\s+)(.*)$/);
		if (context) {
			body.push({
				raw: line,
				kind: 'context',
				indent: context[1] ?? '',
				number: context[2],
				text: context[3] ?? '',
			});
			continue;
		}
		// Stray rows (not a numbered context line) are opaque body rows,
		// they render dim and stay out of pairing.
		body.push({raw: line, kind: 'context', indent: '', text: line});
	}
	// Pair adjacent remove/add runs 1:1, in order (removal[i] <-> addition[i]),
	// and mark only pairs within the 0.6 change-ratio threshold with a
	// word-level highlight (parity: nanocoder's emitChangeRun).
	{
		let runStart = 0;
		for (let i = 0; i <= body.length; i++) {
			const changed =
				i < body.length &&
				(body[i]?.kind === 'remove' || body[i]?.kind === 'add');
			if (changed) continue;
			const removals = body
				.slice(runStart, i)
				.filter(row => row.kind === 'remove');
			const additions = body
				.slice(runStart, i)
				.filter(row => row.kind === 'add');
			const pairCount = Math.min(removals.length, additions.length);
			for (let p = 0; p < pairCount; p++) {
				const oldRow = removals[p]!;
				const newRow = additions[p]!;
				const [pre, mid, post] = commonAffix(oldRow.text, newRow.text);
				const unchanged = pre.length + post.length;
				const ratio =
					1 - unchanged / Math.max(oldRow.text.length, newRow.text.length, 1);
				if (ratio <= 0.6 && mid.length > 0) {
					const start = pre.length;
					oldRow.word = [start, start + mid.length];
					newRow.word = [start, start + mid.length];
				}
			}
			runStart = i + 1;
		}
	}
	// Render a changed row: sigil + number on the row bg, code text with
	// syntax colors (row bg underneath), optional darker word bg on the
	// paired middle, and the row bg extended across the full width.
	const renderChange = (row: DiffBodyRow): TextChunk[] => {
		const kind = row.kind;
		const fg = kind === 'add' ? palette.fg.success : palette.fg.error;
		const rowBg = RGBA.fromHex(
			kind === 'add' ? colors.diffAdded : colors.diffRemoved,
		);
		const wordBg = RGBA.fromHex(
			kind === 'add' ? colors.diffAddedWord : colors.diffRemovedWord,
		);
		const text = row.text;
		// WRAP INSIDE THE CONTAINER: a diff line longer than the renderable
		// width must split into continuation pieces (indented to the code
		// column, row bg preserved) — leaving it to overflow makes the
		// TERMINAL wrap the orphan tail onto a phantom row (the
		// "additional lines" bug: unit tests never caught it because the
		// test renderer clips, but in the real TUI long diff rows painted
		// an extra line that vanished on resize). The continuation pieces
		// are joined with an embedded newline + the code-column indent, so
		// splitChunksByLine turns them into their own painted rows that
		// still carry the row/word background.
		const prefixLen =
			row.indent.length +
			(row.number ?? '').length +
			// The sigil emits WITH its trailing space (the parse regex
			// takes exactly one separator); without it `+const` glues to
			// the code.
			(row.sigil ? 2 : 0);
		const maxText = width > 0 ? Math.max(1, width - prefixLen) : text.length;
		// Split the row into width-budget PIECES; each piece keeps its own
		// word-diff segments (pre/mid/post within the piece), so the darker
		// word background only tints the changed middle, never the whole
		// wrapped line.
		const pieces: Array<Array<{text: string; word: boolean}>> = [];
		for (let offset = 0; offset < text.length; offset += maxText) {
			const piece = text.slice(offset, offset + maxText);
			const pieceEnd = offset + piece.length;
			const wordStart = row.word ? Math.max(offset, row.word[0]) : pieceEnd;
			const wordEnd = row.word ? Math.min(pieceEnd, row.word[1]) : pieceEnd;
			const segments: Array<{text: string; word: boolean}> = [];
			if (wordEnd > wordStart) {
				segments.push(
					{text: piece.slice(0, wordStart - offset), word: false},
					{text: piece.slice(wordStart - offset, wordEnd - offset), word: true},
					{text: piece.slice(wordEnd - offset), word: false},
				);
			} else {
				segments.push({text: piece, word: false});
			}
			pieces.push(segments.filter(segment => segment.text.length > 0));
		}
		if (pieces.length === 0) pieces.push([{text: '', word: false}]);
		const code: TextChunk[] = [];
		for (let i = 0; i < pieces.length; i++) {
			for (const part of pieces[i]!) {
				if (!part.text) continue;
				const chunks = language
					? tokenizeCode(part.text, language, palette, defaultFg)
					: [chunk(part.text, fg)];
				const partBg = part.word ? wordBg : rowBg;
				if (i > 0 && part === pieces[i]![0]) {
					// Continuation rows align their code with the parent's
					// code column (indent + number + sigil) and inherit the
					// row bg.
					code.push({
						...chunk(
							`\n${' '.repeat(prefixLen)}`,
							readableDiffFg(rowBg, defaultFg, colors),
						),
						bg: rowBg,
					});
				}
				code.push(
					...chunks.map(c => ({
						...c,
						// Readability guard: the syntax color (or the row fg)
						// must stay readable on the row/word background.
						fg: readableDiffFg(partBg, c.fg ?? fg, colors),
						bg: partBg,
					})),
				);
			}
		}
		const firstPieceLen = pieces[0]!.reduce(
			(sum, segment) => sum + segment.text.length,
			0,
		);
		const used =
			row.indent.length +
			(row.sigil ?? '').length +
			1 +
			(row.number ?? '').length +
			firstPieceLen;
		return fill(
			[
				{
					...chunk(row.indent, readableDiffFg(rowBg, defaultFg, colors)),
					bg: rowBg,
				},
				{
					...chunk(
						row.number ?? '',
						readableDiffFg(rowBg, palette.fg.secondary, colors),
					),
					bg: rowBg,
				},
				{
					...chunk(
						`${row.sigil ?? ''} `,
						readableDiffFg(rowBg, fg, colors),
						bold(),
					),
					bg: rowBg,
				},
				...code,
			],
			used,
		);
	};
	let bodyCursor = 0;
	// Context rows wrap the same way: a numbered unchanged line longer than
	// the renderable width splits with the code column re-indented, so no
	// row can overflow and wrap in the terminal.
	const contextChunks = (
		indent: string,
		number: string,
		text: string,
	): TextChunk[] => {
		const prefixLen = indent.length + number.length;
		const maxText = width > 0 ? Math.max(1, width - prefixLen) : text.length;
		const out: TextChunk[] = [
			chunk(indent, defaultFg),
			chunk(number, palette.fg.secondary),
		];
		for (let offset = 0; offset < text.length; offset += maxText) {
			const piece = text.slice(offset, offset + maxText);
			if (offset > 0) {
				out.push(chunk(`\n${' '.repeat(prefixLen)}`, defaultFg));
			}
			out.push(
				...(language
					? tokenizeCode(piece, language, palette, defaultFg)
					: [chunk(piece, defaultFg)]),
			);
		}
		return out;
	};
	const fill = (chunks: TextChunk[], used: number): TextChunk[] => {
		if (width <= 0) return chunks;
		const padding = Math.max(0, width - used);
		return padding > 0
			? [
					...chunks,
					{...chunk(' '.repeat(padding), defaultFg), bg: chunks[0]?.bg},
				]
			: chunks;
	};
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				// `✦ Edit <path>`, ONLY the action name (Edit) is primary bold;
				// the glyph is status-colored and the path stays secondary.
				const m = line.match(/^([✦⚙]\s*)([A-Za-z]+)(\s+.*)$/);
				if (m) {
					return [
						chunk(m[1] ?? '', glyphColor(status, palette)),
						chunk(m[2] ?? '', palette.fg.primary, bold()),
						chunk(m[3] ?? '', palette.fg.secondary),
					];
				}
				return headerChunks(line, status, palette, defaultFg);
			}
			if (line.startsWith(' ⎿') || line.startsWith('  ⎿')) {
				return [chunk(line, palette.fg.secondary, dim())];
			}
			// Diff body rows: consume from the parsed list in order. Header and
			// summary rows do not consume a body entry (bodyCursor tracks only
			// rows that were parsed above).
			const row = body[bodyCursor];
			if (row && row.raw === line) {
				bodyCursor++;
				if (row.kind === 'context') {
					if (row.number !== undefined && row.text) {
						return contextChunks(row.indent, row.number, row.text);
					}
					// Summary / opaque row.
					return [chunk(line, palette.fg.secondary, dim())];
				}
				return renderChange(row);
			}
			const context = line.match(/^(\s*)(\d+\s+)(.*)$/);
			if (context) {
				return contextChunks(
					context[1] ?? '',
					context[2] ?? '',
					context[3] ?? '',
				);
			}
			return fill([chunk(line, palette.fg.secondary, dim())], line.length);
		},
		defaultFg,
	);
}

/** Agent row: `✦ Ran agent:name(task) status` + secondary preview. */
export function tokenizeAgentRow(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				// `✦ Ran agent:explore(<task>) <status>`, ONLY `agent:explore` is
				// primary; `Ran `, `(<task>)` and the status stay secondary.
				const m = line.match(/^([✦⚙]\s*)?(.*)$/);
				if (m) {
					const rest = m[2] ?? '';
					const agentMatch = rest.match(
						/^(Ran\s+)(agent:[^()\s]+)((?:\([^)]*\))?)(.*)$/,
					);
					if (agentMatch) {
						const agentChunks: TextChunk[] = [];
						if (m[1]) {
							agentChunks.push(chunk(m[1], glyphColor(status, palette)));
						}
						return [
							...agentChunks,
							chunk(agentMatch[1] ?? '', palette.fg.secondary),
							chunk(agentMatch[2] ?? '', palette.fg.primary, bold()),
							chunk(agentMatch[3] ?? '', palette.fg.secondary),
							chunk(agentMatch[4] ?? '', palette.fg.secondary),
						];
					}
					const fallback: TextChunk[] = [];
					if (m[1]) fallback.push(chunk(m[1], glyphColor(status, palette)));
					fallback.push(chunk(rest, palette.fg.primary, bold()));
					return fallback;
				}
				return headerChunks(line, status, palette, defaultFg);
			}
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/**
 * Thought container: `⚙ Thought (Ns)` header + secondary body. The header is
 * ALWAYS secondary/dim (thinking is not primary information a normal user
 * reads); the live state animates ONLY the timer and dots, never the glyph,
 * so nothing blinks between colors.
 */
export function tokenizeThought(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				const m = line.match(/^([✦⚙]\s*)(.*)$/);
				if (m) {
					return [
						chunk(m[1] ?? '', palette.fg.secondary, dim()),
						chunk(m[2] ?? '', palette.fg.secondary, dim()),
					];
				}
				return [chunk(line, palette.fg.secondary, dim())];
			}
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/**
 * User message (arrow style): `❯ content` on a surface background (parity:
 * nanocoder's UserMessage `ICON_PROMPT_HISTORY_BACKGROUND` = #2a2a2a). The
 * `❯ ` prompt is primary bold; the content stays the default text color; the
 * leading blank (spacing row) keeps NO background.
 */
export function tokenizeUserMessage(
	text: string,
	colors: Colors,
	width = 0,
	realAttachments = '',
): TextChunk[] {
	const palette = themeColors(colors);
	const bg = RGBA.fromHex('#2a2a2a');
	// Known `/commands` + REAL attachment token numbers (the fence language
	// marker). A manually typed `[Image #1]` is NOT in the marker and stays
	// plain text.
	const known = new Set<string>([
		...commandNames(),
		...customCommandNames(),
		...loadSkills().map(skill => `skill:${skill.name}`),
	]);
	const real = new Set(
		realAttachments.split('').filter(char => /[0-9]/.test(char)),
	);
	const contentChunks = (content: string): TextChunk[] => {
		const parts: Array<{text: string; token: boolean}> = [];
		let cursor = 0;
		for (const match of content.matchAll(
			/\[(?:Image|Text) #(\d+)\]|\/[^\s]*/g,
		)) {
			const at = match.index ?? 0;
			if (at > cursor) {
				parts.push({text: content.slice(cursor, at), token: false});
			}
			const token = match[0];
			const isRealAttachment =
				token.startsWith('[') && real.has(match[1] ?? '');
			const isCommand = token.startsWith('/') && known.has(token.slice(1));
			parts.push({text: token, token: isRealAttachment || isCommand});
			cursor = at + token.length;
		}
		if (cursor < content.length) {
			parts.push({text: content.slice(cursor), token: false});
		}
		if (parts.length === 0) parts.push({text: content, token: false});
		return parts.map(part =>
			chunk(part.text, part.token ? palette.fg.primary : palette.fg.text),
		);
	};
	// The fenced token text carries a leading blank line after the opener,
	// KEEP it as the bg-free breakline BEFORE the message (the separator is
	// required; only its BACKGROUND was wrong). Blank rows INSIDE the message
	// (index > 0) keep the surface background so multi-line user messages
	// read as ONE solid block, breaklines included.
	const lines = text.replace(/\n+$/, '').split('\n');
	// The message block's background spans the WHOLE row, not just the text
	// (multi-line user messages read as one solid highlighted block).
	const fill = (chunks: TextChunk[], used: number): TextChunk[] => {
		if (width <= 0) return chunks;
		const padding = Math.max(0, width - used);
		return padding > 0
			? [...chunks, {...chunk(' '.repeat(padding), palette.fg.text), bg}]
			: chunks;
	};
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (!line.trim()) {
				// The leading blank separator (index 0) stays bg-free; interior
				// paragraph breaklines get the same full-row surface.
				if (index === 0) return [chunk(line, palette.fg.text)];
				return fill([{...chunk(line, palette.fg.text), bg}], line.length);
			}
			// The `+N more lines` footer (user messages capped for display)
			// renders secondary-dim INSIDE the surface, consistent with tool
			// footers.
			if (/^\s*… \+(\d+) more lines/.test(line) && !isHeader) {
				return fill(
					[{...chunk(line, palette.fg.secondary, dim()), bg}],
					line.length,
				);
			}
			const m = line.match(/^(❯\s*)(.*)$/);
			if (m && isHeader) {
				return fill(
					[
						chunk(m[1] ?? '', palette.fg.primary, bold()),
						...contentChunks(m[2] ?? ''),
					].map(c => ({...c, bg})),
					line.length,
				);
			}
			return fill([{...chunk(line, palette.fg.text), bg}], line.length);
		},
		palette.fg.text,
	);
}

/**
 * Task list: `✦ Tasks (N done, …)` header + `◐/✓/○` status icons, done
 * tasks in success green, in-progress in warning, pending in secondary.
 */
export function tokenizeTaskRow(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		(line, _index, isHeader) => {
			if (isHeader) return headerChunks(line, status, palette, defaultFg);
			const icon = line.match(/^(\s*)([◐✓○])(\s+)(.*)$/);
			if (icon) {
				const fg =
					icon[2] === '✓'
						? palette.fg.success
						: icon[2] === '◐'
							? palette.fg.warning
							: palette.fg.secondary;
				return [
					chunk(icon[1] ?? '', defaultFg),
					chunk(icon[2] ?? '', fg, bold()),
					chunk(icon[3] ?? '', defaultFg),
					chunk(icon[4] ?? '', defaultFg),
				];
			}
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/**
 * `/status` block (codex-like): `Label: value` rows, the label stays
 * secondary and the value renders in the text color. Rendered through a
 * custom fence so `model[effort]` brackets are preserved verbatim.
 */
export function tokenizeStatusRow(text: string, colors: Colors): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		line => {
			const label = line.match(/^(\S+:\s*)(.*)$/);
			if (label) {
				return [
					chunk(label[1] ?? '', palette.fg.secondary),
					chunk(label[2] ?? '', defaultFg),
				];
			}
			return [chunk(line, defaultFg)];
		},
		defaultFg,
	);
}

/** Error row: `⚠ message` in the error color (light red). */
export function tokenizeErrorRow(text: string, colors: Colors): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		line => {
			const m = line.match(/^(⚠\s*)(.*)$/);
			if (m) {
				return [
					chunk(m[1] ?? '', palette.fg.error, bold()),
					chunk(m[2] ?? '', palette.fg.error),
				];
			}
			return [chunk(line, palette.fg.error)];
		},
		defaultFg,
	);
}

/** Warning rows (e.g. the vision-fallback indicator) in the WARNING color. */
export function tokenizeWarningRow(text: string, colors: Colors): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		line => {
			const m = line.match(/^([✦]\s*)(.*)$/);
			if (m) {
				return [
					chunk(m[1] ?? '', palette.fg.warning),
					chunk(m[2] ?? '', palette.fg.warning),
				];
			}
			return [chunk(line, palette.fg.warning)];
		},
		defaultFg,
	);
}

/**
 * Welcome banner: primary mascot + borders, and the detail rows colored by
 * purpose, `model:` info with a text value + secondary hint, `directory:`
 * secondary, `permissions:` warning with the mode in error/warning.
 */
export function tokenizeBanner(text: string, colors: Colors): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		line => {
			if (/^[╭╰][─]+[╮╯]$/.test(line)) {
				return [chunk(line, palette.fg.primary, bold())];
			}
			if (/^[│].*[│]$/.test(line)) {
				const chunks: TextChunk[] = [];
				let rest = line;
				// Leading/trailing border.
				if (rest.startsWith('│')) {
					chunks.push(chunk('│', palette.fg.primary));
					rest = rest.slice(1);
				}
				const close = rest.lastIndexOf('│');
				if (close !== -1) {
					// Mascot (★ / ╭◕‿◕╮ / ╰───╯) and title in primary.
					const body = rest.slice(0, close);
					const tail = rest.slice(close);
					// Match against `body` (NOT `rest`): rest still contains the
					// closing `│`, and the greedy `(.*)$` would swallow it, the
					// border would render twice (`││`).
					const mascot = body.match(/^(\s*)(★\s*|╭◕‿◕╮|╰───╯)(.*)$/);
					if (mascot) {
						chunks.push(chunk(mascot[1] ?? '', defaultFg));
						chunks.push(chunk(mascot[2] ?? '', palette.fg.primary, bold()));
						chunks.push(
							...bannerBody(
								body.slice((mascot[1] ?? '').length + (mascot[2] ?? '').length),
								palette,
								defaultFg,
							),
						);
					} else {
						chunks.push(...bannerBody(body, palette, defaultFg));
					}
					chunks.push(chunk(tail, palette.fg.primary));
				} else {
					chunks.push(...bannerBody(rest, palette, defaultFg));
				}
				return chunks;
			}
			// Tip line.
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

function bannerBody(
	text: string,
	palette: Palette,
	defaultFg: RGBA,
): TextChunk[] {
	const title = text.match(/^(\s*)(bobonyo\s*\([^)]*\))(.*)$/);
	if (title) {
		return [
			chunk(`${title[1] ?? ''}${title[2] ?? ''}`, palette.fg.primary, bold()),
			// Keep the trailing padding so the box border stays aligned.
			chunk(title[3] ?? '', defaultFg),
		];
	}
	// All KEYS (`model:`, `directory:`, `permissions:`) share ONE label color
	// (secondary), only the VALUES keep purpose colors (parity feedback:
	// per-key coloring looked inconsistent).
	const keyed = text.match(/^(\s*)([a-zA-Z]+:)(\s+)(.*)$/);
	if (keyed) {
		const label = `${keyed[1] ?? ''}${keyed[2] ?? ''}${keyed[3] ?? ''}`;
		const value = keyed[4] ?? '';
		const key = (keyed[2] ?? '').toLowerCase();
		if (value.includes('/model to change')) {
			const model = value.match(/^(\S+)(\s+)(.*)$/);
			return [
				chunk(label, palette.fg.secondary),
				chunk(model?.[1] ?? value, defaultFg),
				chunk(
					model ? `${model[2] ?? ''}${model[3] ?? ''}` : '',
					palette.fg.secondary,
					dim(),
				),
			];
		}
		// Non-permission values (e.g. the directory path) render in the
		// default text color, only the permissions value is purpose-colored.
		if (key !== 'permissions:') {
			return [chunk(label, palette.fg.secondary), chunk(value, defaultFg)];
		}
		const valueMatch = value.match(/^(\S.*\S)(\s*)$/);
		const valueText = valueMatch?.[1] ?? value.trimEnd();
		const padding = valueMatch?.[2] ?? '';
		const danger = /yolo|auto-accept/i.test(valueText);
		return [
			chunk(label, palette.fg.secondary),
			chunk(
				valueText,
				danger ? palette.fg.error : palette.fg.warning,
				danger ? bold() : undefined,
			),
			chunk(padding, defaultFg),
		];
	}
	// Unknown line, keep it verbatim (including any padding).
	return [chunk(text, defaultFg)];
}

/** Git diff row: `✦ git_diff(detail)` header + red/green diff lines. */
export function tokenizeDiffRow(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		(line, _index, isHeader) => {
			if (isHeader || /^[✦⚙]/.test(line)) {
				return headerChunks(line, status, palette, defaultFg);
			}
			const trimmed = line.trimStart();
			if (
				trimmed.startsWith('+++') ||
				trimmed.startsWith('---') ||
				trimmed.startsWith('@@')
			) {
				return [chunk(line, palette.fg.info, bold())];
			}
			if (trimmed.startsWith('+')) {
				return [chunk(line, palette.fg.success)];
			}
			if (trimmed.startsWith('-')) {
				return [chunk(line, palette.fg.error)];
			}
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/** Relative luminance of an RGBA color (0..1, Rec. 709 weights). */
function luminance(c: RGBA): number {
	return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Guaranteed-readable foreground for a given background: prefer the original
 * foreground when it clears the contrast bar; otherwise pick the lighter of
 * `text`/`base` for a DARK background or the darker for a LIGHT one. This is
 * the foolproof guard so a hover/selection tint can never make text
 * invisible under any theme.
 */
export function readableOn(
	bg: RGBA,
	preferred: RGBA | undefined,
	text: RGBA,
	base: RGBA,
): RGBA {
	const bgLum = luminance(bg);
	if (preferred && Math.abs(luminance(preferred) - bgLum) >= 0.35) {
		return preferred;
	}
	const light = luminance(text) > luminance(base) ? text : base;
	const dark = luminance(text) > luminance(base) ? base : text;
	return bgLum < 0.5 ? light : dark;
}

/**
 * Diff-row foreground: keep the preferred color (row/syntax fg) when it
 * clears the contrast bar against the row/word background, otherwise fall
 * back to a guaranteed-readable light/dark color. A diff can never render
 * unreadable under any theme — this is the same guard activeRowPalette uses
 * for hover tints, applied to every chunk that sits on a diff background.
 */
function readableDiffFg(
	bg: RGBA,
	preferred: RGBA | undefined,
	colors: Colors,
): RGBA {
	return readableOn(
		bg,
		preferred,
		RGBA.fromHex(colors.text),
		RGBA.fromHex(colors.base),
	);
}

/**
 * Active/hovered ROW palette (suggestion popups, settings, modals): the row
 * tint is `info` and the foreground is guaranteed readable on it, a row can
 * never become invisible under any theme.
 */
export function activeRowPalette(colors: Colors): {bg: RGBA; fg: RGBA} {
	const bg = RGBA.fromHex(colors.info);
	const fg = readableOn(
		bg,
		undefined,
		RGBA.fromHex(colors.text),
		RGBA.fromHex(colors.base),
	);
	return {bg, fg};
}
