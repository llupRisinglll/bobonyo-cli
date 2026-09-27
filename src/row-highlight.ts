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
import {tokenizeBanner} from './row-highlight-banner';
export {lineDiff, tokenizeFileDiff} from './row-highlight-diff';
export type {DiffLine} from './row-highlight-diff';
import {
	capToolHeader,
	commonAffix,
	groupHeaderChunks,
	headerChunks,
} from './row-highlight-tools';
export {tokenizeBanner} from './row-highlight-banner';
export {capToolHeader, commonAffix} from './row-highlight-tools';

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

export function chunk(
	text: string,
	fg: RGBA | undefined,
	attributes = 0,
): TextChunk {
	return {__isChunk: true, text, ...(fg ? {fg} : {}), attributes};
}

export function bold(): number {
	return createTextAttributes({bold: true});
}

export function dim(): number {
	return createTextAttributes({dim: true});
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

export function emitLines(
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

/** Generic tool row: `✦ Name(detail)` + `└` output tail (secondary). */
export function tokenizeToolRow(
	text: string,
	status: RowStatus,
	colors: Colors,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	const lines = text.replace(/\n+$/, '').split('\n');
	const activityHeader = lines.find(line => line.trim() !== '')?.trim() ?? '';
	const mcpActivity = /(?:^|\s)MCP$/.test(activityHeader);
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				const activity = line.match(
					/^(?:[✦⚙]\s*)?(Explored|Navigated Web|Skills triggered|.+ MCP)$/,
				);
				if (activity) {
					return [chunk(activity[1] ?? line, defaultFg, bold())];
				}
				if (/^(?:[✦⚙]\s*)?Ran\s+/.test(line)) {
					return groupHeaderChunks(line, status, palette, headerChunks);
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
			const branch = line.match(/^(\s*[├└│]\s*)(.*)$/);
			if (branch) {
				const body = branch[2] ?? '';
				const continuation = !/[├└]/.test(branch[1] ?? '');
				const skillsActivity = activityHeader === 'Skills triggered';
				const actionEnd = skillsActivity
					? (body.match(/^\S+/)?.[0].length ?? 0)
					: mcpActivity
						? body.indexOf('(') === -1
							? body.length
							: body.indexOf('(')
						: (body.match(/^[^\s(]+/)?.[0].length ?? 0);
				return [
					chunk(branch[1] ?? '', palette.fg.secondary, dim()),
					chunk(
						body.slice(0, actionEnd),
						continuation ? defaultFg : palette.fg.primary,
						continuation ? 0 : bold(),
					),
					chunk(body.slice(actionEnd), defaultFg),
				];
			}
			// Output / footer rows are secondary (container semantics).
			return [chunk(line, palette.fg.secondary, dim())];
		},
		defaultFg,
	);
}

/** Human-facing task progress: muted diamond, spacing, and plain secondary text. */
export function tokenizeTaskStatusRow(
	text: string,
	_colors: Colors,
): TextChunk[] {
	const palette = themeColors(_colors);
	const lines = text.replace(/\n+$/, '').split('\n');
	return emitLines(
		lines,
		line => [chunk(line, palette.fg.text)],
		palette.fg.text,
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
	width = 0,
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
	const headerAt = lines.findIndex(line => line.trim() !== '');
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				// `✦ Write <path>`, glyph by status, `Write` primary bold,
				// `<path>` secondary (path capped to the renderable width —
				// a long repo path must never overflow and wrap a phantom
				// blank row in the terminal).
				const m = line.match(/^([✦⚙]\s*)([A-Za-z]+)(\s+.*)$/);
				if (m) {
					const capped = capToolHeader(
						m[1] ?? '',
						m[2] ?? '',
						m[3] ?? '',
						width,
					);
					return [
						chunk(capped.glyph, glyphColor(status, palette)),
						chunk(capped.name, palette.fg.primary, bold()),
						chunk(capped.rest, palette.fg.secondary),
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
			// Review aggregates contain several agent rows in one tool result.
			// Treat every `Ran agent:` line as a header, not only first line.
			const agentHeader = /^(?:[✦⚙]\s*)?Ran\s+agent:[^()\s]+/.test(line);
			if (isHeader || agentHeader) {
				// `✦ Ran agent:explore(<task>) <status>`, ONLY `agent:explore` is
				// primary; `Ran `, `(<task>)` and the status stay secondary.
				const m = line.match(/^([✦⚙]\s*)?(.*)$/);
				if (m) {
					const rest = m[2] ?? '';
					const agentMatch = rest.match(
						/^(Ran\s+)(agent:[^()\s]+)((?:\([^)]*\))?)(.*)$/,
					);
					if (agentMatch) {
						// Aggregate review output omits glyphs; renderer owns one glyph
						// per agent row instead of treating them as pasted text.
						// Glyph is rendered by SettledToolRow/LiveToolRows.
						// Keep tokenizer output glyph-free or mock agent rows get `✦ ✦`.
						return [
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
			// User message continuation lines sit under message content, not
			// column zero. Keep the two-column lead explicit so Markdown-like
			// bullets cannot look like a new transcript entry.
			const lead = index > 0 ? '  ' : '';
			return fill(
				[chunk(lead, palette.fg.text), ...contentChunks(line)].map(c => ({
					...c,
					bg,
				})),
				lead.length + line.length,
			);
		},
		palette.fg.text,
	);
}

/**
 * Task list: `✦ Tasks (N done, …)` header + `›/◆/·` status icons, done
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
	const compactCompletedSnapshot =
		status === 'done' &&
		lines.length === 2 &&
		/^✦\s+/.test(lines[0] ?? '') &&
		/^\s*└\s+Tasks\s+\(/.test(lines[1] ?? '');
	return emitLines(
		lines,
		(line, _index, isHeader) => {
			if (isHeader) {
				if (compactCompletedSnapshot) {
					return [chunk(line, palette.fg.secondary, dim())];
				}
				return headerChunks(line, status, palette, defaultFg);
			}
			const icon = line.match(/^(\s*)(?:(└)\s+)?([›◆·×])(\s+)(.*)$/);
			if (icon) {
				const completed = icon[3] === '◆';
				const cancelled = icon[3] === '×';
				const fg = icon[3] === '›' ? palette.fg.warning : palette.fg.secondary;
				const textAttributes =
					completed || cancelled
						? createTextAttributes({strikethrough: true, dim: true})
						: 0;
				return [
					chunk(icon[1] ?? '', defaultFg),
					...(icon[2]
						? [chunk(`${icon[2]} `, palette.fg.secondary, dim())]
						: []),
					chunk(
						icon[3] ?? '',
						fg,
						completed || cancelled ? textAttributes : bold(),
					),
					chunk(icon[4] ?? '', completed || cancelled ? fg : defaultFg),
					chunk(icon[5] ?? '', fg, textAttributes),
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
