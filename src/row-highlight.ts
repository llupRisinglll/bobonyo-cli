import {RGBA, createTextAttributes, type TextChunk} from '@opentui/core';
import type {Colors} from './theme';
import {commandNames, customCommandNames} from './commands';
import {loadSkills} from './custom';
import {
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

function chunk(
	text: string,
	fg: RGBA | undefined,
	attributes = 0,
): TextChunk {
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
 */
function groupHeaderChunks(
	line: string,
	status: RowStatus,
	palette: Palette,
): TextChunk[] {
	const m = line.match(/^([✦⚙]\s*)(Ran\s+)(.*)$/);
	if (!m) return headerChunks(line, status, palette, palette.fg.text);
	const chunks: TextChunk[] = [
		chunk(m[1] ?? '', glyphColor(status, palette)),
		chunk(m[2] ?? '', palette.fg.text),
	];
	const rest = m[3] ?? '';
	const hintAt = rest.search(/\(ctrl-o|\(ctrl \+ t/);
	// Keep the space that separated the names from the hint (names.trim()
	// below would otherwise drop it, gluing `×2(ctrl-o` together).
	const hintStart = hintAt === -1 ? -1 : hintAt > 0 && rest[hintAt - 1] === ' ' ? hintAt - 1 : hintAt;
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
	return emitLines(lines, (line, index, isHeader) => {
		if (isHeader) {
			if (/^[✦⚙]\s*Ran\s+/.test(line)) {
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
		if (/^[✦⚙]/.test(line)) return headerChunks(line, status, palette, defaultFg);
		// Output / footer rows are secondary (container semantics).
		return [chunk(line, palette.fg.secondary, dim())];
	}, defaultFg);
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
	return emitLines(lines, (line, index, isHeader) => {
		if (isHeader) {
			return headerChunks(line, status, palette, defaultFg, inner =>
				tokenizeBash(inner, palette, defaultFg),
			);
		}
		// Wrapped command continuations: `   │ <bash>`, prefix secondary,
		// the command itself bash-highlighted.
		const cont = line.match(/^(\s*│\s*)(.*)$/);
		if (cont) {
			return [
				chunk(cont[1] ?? '', palette.fg.secondary),
				...tokenizeBash(cont[2] ?? '', palette, defaultFg),
			];
		}
		return [chunk(line, palette.fg.secondary, dim())];
	}, defaultFg);
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
	const language = path.split('.').pop()?.toLowerCase() ?? '';
	// The fenced token text carries a leading blank line after the opener,
	// strip it so the header is line 0 and the body cursor stays aligned.
	const lines = text.replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
	return emitLines(lines, (line, index, isHeader) => {
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
			const code = tokenizeCode(
				numbered[2] ?? '',
				language,
				palette,
				defaultFg,
			);
			return [chunk(numbered[1] ?? '', palette.fg.secondary), ...code];
		}
		return [chunk(line, palette.fg.secondary, dim())];
	}, defaultFg);
}

export interface DiffLine {
	kind: 'context' | 'remove' | 'add';
	oldLineNo?: number;
	newLineNo?: number;
	text: string;
}

/** LCS-based line diff with old/new line numbers (parity: DiffView). */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
	const oldLines =
		oldStr === '' ? [] : oldStr.replace(/\n+$/, '').split('\n');
	const newLines =
		newStr === '' ? [] : newStr.replace(/\n+$/, '').split('\n');
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
			result.push({kind: 'context', oldLineNo: oldNo++, newLineNo: newNo++, text: oldLines[i] ?? ''});
			i++;
			j++;
		} else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
			result.push({kind: 'remove', oldLineNo: oldNo++, text: oldLines[i] ?? ''});
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
	const language = path.split('.').pop()?.toLowerCase() ?? '';
	// The fenced token text carries a leading blank line after the opener,
	// strip it so the header is line 0 and the body cursor stays aligned
	// (the parse loop indexes body rows from the same `lines` array).
	const lines = text.replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
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
		const change = line.match(/^(\s*)([-+])(\s*\d+\s+)(.*)$/);
		if (change) {
			body.push({
				raw: line,
				kind: change[2] === '+' ? 'add' : 'remove',
				indent: change[1] ?? '',
				sigil: change[2],
				number: change[3],
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
		const rowBg = RGBA.fromHex(kind === 'add' ? colors.diffAdded : colors.diffRemoved);
		const wordBg = RGBA.fromHex(
			kind === 'add' ? colors.diffAddedWord : colors.diffRemovedWord,
		);
		const text = row.text;
		const parts: Array<{text: string; word: boolean}> = row.word
			? [
					{text: text.slice(0, row.word[0]), word: false},
					{
						text: text.slice(row.word[0], row.word[1]),
						word: row.word[1] > row.word[0],
					},
					{text: text.slice(row.word[1]), word: false},
				]
			: [{text, word: false}];
		const code: TextChunk[] = [];
		for (const part of parts) {
			if (!part.text) continue;
			const chunks = tokenizeCode(part.text, language, palette, defaultFg);
			code.push(
				...chunks.map(c => ({
					...c,
					fg: c.fg ?? fg,
					bg: part.word ? wordBg : rowBg,
				})),
			);
		}
		const used =
			row.indent.length +
			(row.sigil ?? '').length +
			(row.number ?? '').length +
			text.length;
		return fill(
			[
				{...chunk(row.indent, defaultFg), bg: rowBg},
				{...chunk(row.sigil ?? '', fg, bold()), bg: rowBg},
				{...chunk(row.number ?? '', palette.fg.secondary), bg: rowBg},
				...code,
			],
			used,
		);
	};
	let bodyCursor = 0;
	const fill = (chunks: TextChunk[], used: number): TextChunk[] => {
		if (width <= 0) return chunks;
		const padding = Math.max(0, width - used);
		return padding > 0
			? [...chunks, {...chunk(' '.repeat(padding), defaultFg), bg: chunks[0]?.bg}]
			: chunks;
	};
	return emitLines(lines, (line, index, isHeader) => {
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
					return [
						chunk(row.indent, defaultFg),
						chunk(row.number, palette.fg.secondary),
						...tokenizeCode(row.text, language, palette, defaultFg),
					];
				}
				// Summary / opaque row.
				return [chunk(line, palette.fg.secondary, dim())];
			}
			return renderChange(row);
		}
		const context = line.match(/^(\s*)(\d+\s+)(.*)$/);
		if (context) {
			return [
				chunk(context[1] ?? '', defaultFg),
				chunk(context[2] ?? '', palette.fg.secondary),
				...tokenizeCode(context[3] ?? '', language, palette, defaultFg),
			];
		}
		return fill([chunk(line, palette.fg.secondary, dim())], line.length);
	}, defaultFg);
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
	return emitLines(lines, (line, index, isHeader) => {
		if (isHeader) {
			// `✦ Ran agent:explore(<task>) <status>`, ONLY `agent:explore` is
			// primary; `Ran `, `(<task>)` and the status stay secondary.
			const m = line.match(/^([✦⚙]\s*)(.*)$/);
			if (m) {
				const rest = m[2] ?? '';
				const agentMatch = rest.match(/^(Ran\s+)(agent:[^()\s]+)((?:\([^)]*\))?)(.*)$/);
				if (agentMatch) {
					return [
						chunk(m[1] ?? '', glyphColor(status, palette)),
						chunk(agentMatch[1] ?? '', palette.fg.secondary),
						chunk(agentMatch[2] ?? '', palette.fg.primary, bold()),
						chunk(agentMatch[3] ?? '', palette.fg.secondary),
						chunk(agentMatch[4] ?? '', palette.fg.secondary),
					];
				}
				return [
					chunk(m[1] ?? '', glyphColor(status, palette)),
					chunk(rest, palette.fg.primary, bold()),
				];
			}
			return headerChunks(line, status, palette, defaultFg);
		}
		return [chunk(line, palette.fg.secondary, dim())];
	}, defaultFg);
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
	return emitLines(lines, (line, index, isHeader) => {
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
	}, defaultFg);
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
		for (const match of content.matchAll(/\[(?:Image|Text) #(\d+)\]|\/[^\s]*/g)) {
			const at = match.index ?? 0;
			if (at > cursor) {
				parts.push({text: content.slice(cursor, at), token: false});
			}
			const token = match[0];
			const isRealAttachment =
				token.startsWith('[') && real.has(match[1] ?? '');
			const isCommand =
				token.startsWith('/') && known.has(token.slice(1));
			parts.push({text: token, token: isRealAttachment || isCommand});
			cursor = at + token.length;
		}
		if (cursor < content.length) {
			parts.push({text: content.slice(cursor), token: false});
		}
		if (parts.length === 0) parts.push({text: content, token: false});
		return parts.map(part =>
			chunk(
				part.text,
				part.token ? palette.fg.primary : palette.fg.text,
			),
		);
	};
	// The fenced token text carries a leading blank line after the opener,
	// KEEP it as the bg-free breakline BEFORE the message (the separator is
	// required; only its BACKGROUND was wrong). Blank rows render plain.
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
	return emitLines(lines, (line, _index, isHeader) => {
		if (!line.trim()) {
			return [chunk(line, palette.fg.text)];
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
		return fill(
			[{...chunk(line, palette.fg.text), bg}],
			line.length,
		);
	}, palette.fg.text);
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
	return emitLines(lines, (line, _index, isHeader) => {
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
	}, defaultFg);
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
	return emitLines(lines, line => {
		const label = line.match(/^(\S+:\s*)(.*)$/);
		if (label) {
			return [
				chunk(label[1] ?? '', palette.fg.secondary),
				chunk(label[2] ?? '', defaultFg),
			];
		}
		return [chunk(line, defaultFg)];
	}, defaultFg);
}

/** Error row: `⚠ message` in the error color (light red). */
export function tokenizeErrorRow(
	text: string,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(lines, line => {
		const m = line.match(/^(⚠\s*)(.*)$/);
		if (m) {
			return [
				chunk(m[1] ?? '', palette.fg.error, bold()),
				chunk(m[2] ?? '', palette.fg.error),
			];
		}
		return [chunk(line, palette.fg.error)];
	}, defaultFg);
}

/** Warning rows (e.g. the vision-fallback indicator) in the WARNING color. */
export function tokenizeWarningRow(
	text: string,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(lines, line => {
		const m = line.match(/^([✦]\s*)(.*)$/);
		if (m) {
			return [
				chunk(m[1] ?? '', palette.fg.warning),
				chunk(m[2] ?? '', palette.fg.warning),
			];
		}
		return [chunk(line, palette.fg.warning)];
	}, defaultFg);
}

/**
 * Welcome banner: primary mascot + borders, and the detail rows colored by
 * purpose, `model:` info with a text value + secondary hint, `directory:`
 * secondary, `permissions:` warning with the mode in error/warning.
 */
export function tokenizeBanner(
	text: string,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(lines, (line) => {
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
					chunks.push(...bannerBody(body.slice((mascot[1] ?? '').length + (mascot[2] ?? '').length), palette, defaultFg));
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
	}, defaultFg);
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
	return emitLines(lines, (line, _index, isHeader) => {
		if (isHeader || /^[✦⚙]/.test(line)) {
			return headerChunks(line, status, palette, defaultFg);
		}
		const trimmed = line.trimStart();
		if (trimmed.startsWith('+++') || trimmed.startsWith('---') || trimmed.startsWith('@@')) {
			return [chunk(line, palette.fg.info, bold())];
		}
		if (trimmed.startsWith('+')) {
			return [chunk(line, palette.fg.success)];
		}
		if (trimmed.startsWith('-')) {
			return [chunk(line, palette.fg.error)];
		}
		return [chunk(line, palette.fg.secondary, dim())];
	}, defaultFg);
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
