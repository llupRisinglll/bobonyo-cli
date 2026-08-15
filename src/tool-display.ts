/**
 * Tool-row display formatting (parity: nanocoder's CompactDetailResult).
 *
 * Every row is embedded in the transcript as a FENCED CODE BLOCK with a
 * custom language, ` ```bashrow:done `, ` ```toolrow:running `, …, and the
 * History renderNode tokenizes the block into themed chunks (primary tool
 * name, status-colored glyph, bash/code highlighting, secondary container
 * content). The `:<status>` suffix drives the glyph color:
 * done = success, running/bg = secondary.
 */

import {displayToolName, resolveToolName} from './tools';
import {lineDiff, type RowStatus} from './row-highlight';
import {tasks} from './state';

export const PREVIEW_COLLAPSED_LINES = 3;
export const PREVIEW_EXPANDED_LINES = 50;
export const COMMAND_MAX_LINES = 3;
/**
 * Max characters kept from ONE output line before wrapping. A single
 * unbroken line (minified JS, a giant log entry) must not expand into
 * hundreds of wrapped rows; the HEAD of the line is kept with a trailing
 * `…` marker (parity: toolResultTail) so the truncation stays visible in
 * the preview's tail rows.
 */
export const PREVIEW_LINE_MAX_CHARS = 2000;
/**
 * Hard cap on RENDERED (wrapped) rows per preview — the backstop that
 * guarantees a huge line can never flood the transcript even when the
 * capture-side cap did not apply (resumed sessions, saved transcripts).
 * Collapsed shows exactly the "3 lines" target ON RENDERED ROWS (a wrapped
 * long line must not grow the preview past it); expanded is the generous
 * opt-in view (up to 200 rows from 50 raw lines).
 */
export const PREVIEW_MAX_ROWS = {
	collapsed: PREVIEW_COLLAPSED_LINES,
	expanded: PREVIEW_EXPANDED_LINES * 4,
} as const;
/**
 * Bordered-bash chrome. The command lives INSIDE the box on its own line
 * (`│ $ cmd`), so the wrap width is the box width minus the `│ ` left edge
 * and the `│` right edge.
 */
const BOX_EDGE_WIDTH = 3;
/** Command prompt: `│ $ ` (4 chars) — the `$` is the command indicator. */
const COMMAND_PROMPT_WIDTH = 4;

export interface ToolDisplayData {
	name: string;
	detail: string;
	output: string;
	/** Raw call arguments (file previews diff old/new from these). */
	args?: Record<string, unknown>;
}

/** Wrap row content in a fence of the requested language + status. */
export function fence(
	language: string,
	status: RowStatus,
	content: string,
	extra = '',
): string {
	const fenceChar = content.includes('```') ? '````' : '```';
	const suffix = extra ? `:${extra}` : '';
	return `${fenceChar}${language}:${status}${suffix}\n\n${content.replace(/\n+$/, '')}\n${fenceChar}`;
}

export function formatToolEntry(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus = 'done',
	plain = false,
	blinkOn = true,
	/** Available content width (bash command/body wrap target). */
	width = 84,
): string {
	let raw = formatToolEntryText(tool, expanded, status, width);
	// File previews return a MULTI-block text (a `filerow` header fence + a
	// fenced code block with the built-in highlight), already fenced, so the
	// outer wrap must be skipped.
	if (raw.trimStart().startsWith('```')) {
		return plain ? raw : raw;
	}
	// Running rows blink the glyph (parity: ToolGlyph toggles ✦ every 500ms).
	// The space keeps the row width stable so nothing shifts while blinking.
	if (status === 'running' && !blinkOn) {
		raw = raw.replace(/^[✦⚙]/, ' ');
	}
	return plain ? raw : fence(rowLanguage(tool.name), status, raw);
}

/** Row language id for a tool (used by the History renderNode). */
export function rowLanguage(name: string): string {
	const canonical = resolveToolName(name);
	if (canonical === 'execute_bash' || canonical === 'execute_bash:user')
		return 'bashrow';
	if (name === 'write_file') return 'filerow';
	if (name === 'string_replace' || name === 'diff_edit') return 'filediff';
	if (name === 'git_diff') return 'diffrow';
	if (name === 'agent') return 'agentrow';
	if (name === 'write_tasks') return 'taskrow';
	return 'toolrow';
}

function formatToolEntryText(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
	width: number,
): string {
	const canonical = resolveToolName(tool.name);
	return canonical === 'execute_bash' || canonical === 'execute_bash:user'
		? formatBashEntry(tool, expanded, status, width)
		: formatGenericEntry(tool, expanded, status, width);
}

function formatGenericEntry(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
	width: number,
): string {
	if (
		tool.name === 'write_file' ||
		tool.name === 'string_replace' ||
		tool.name === 'diff_edit'
	) {
		return formatFilePreview(tool, expanded, status, width);
	}
	if (tool.name === 'git_diff') {
		return formatDiffRow(tool, status, width);
	}
	if (tool.name === 'skill' || tool.name === 'check_skill') {
		return formatSkillRow(tool, status);
	}
	if (tool.name === 'write_tasks') {
		return formatTaskList(tool, status);
	}
	const header = tool.detail
		? `✦ ${displayToolName(tool.name)}(${tool.detail})`
		: `✦ ${displayToolName(tool.name)}`;
	const output = formatOutputTail(tool.output, expanded, width);
	return output ? `${header}\n${output}` : header;
}

/**
 * Task list (parity: nanocoder's TaskListDisplay), `✦ Tasks (N done, M in
 * progress, K open)` header + `◐/✓/○` status icons per task, colored by
 * state. Reads the LIVE task signal so a running row shows progress.
 */
function formatTaskList(tool: ToolDisplayData, status: RowStatus): string {
	const list = tasks();
	const done = list.filter(task => task.done).length;
	const running = list.filter(task => task.running).length;
	const open = list.length - done - running;
	const suffix = ` (${done} done, ${running} in progress, ${open} open)`;
	const lines = list.map(task => {
		const icon = task.done ? '✓' : task.running ? '◐' : '○';
		return `  ${icon} ${task.title}`;
	});
	return fence(
		'taskrow',
		status,
		`✦ ${displayToolName(tool.name)}${suffix}\n${lines.join('\n')}`,
	);
}

/**
 * Skill row (parity: nanocoder's optimized skill surface), `✦ Skill(<name>)`
 * + `└ Loaded <path>` + a 4-line markdown content preview with a `+N more
 * lines` hint. The preview strips markdown markup (the row renders inside a
 * code block, so raw `#`/backticks would show literally).
 */
function formatSkillRow(tool: ToolDisplayData, status: RowStatus): string {
	const name = tool.detail || 'skill';
	const [loadedLine, ...bodyLines] = tool.output
		.replace(/\s+$/, '')
		.split('\n');
	const previewLines = bodyLines.slice(0, 4).map(line =>
		line
			.replace(/^#{1,6}\s+/, '')
			.replace(/`/g, '')
			.replace(/^\s*[-*]\s+/, '')
			.replace(/\*\*/g, ''),
	);
	const hidden = Math.max(0, bodyLines.length - previewLines.length);
	const footer =
		hidden > 0
			? `\n      … +${hidden} more line${hidden === 1 ? '' : 's'}`
			: '';
	return (
		`✦ Skill(${name})\n` +
		`  └   ${loadedLine ?? ''}\n` +
		previewLines.map(line => `      ${line}`).join('\n') +
		footer
	);
}

function textArg(
	args: Record<string, unknown> | undefined,
	key: string,
): string {
	const value = args?.[key];
	return typeof value === 'string' ? value : '';
}

/**
 * File-write/edit preview (parity: nanocoder's CompactFileResult).
 * `write_file` renders a numbered, syntax-highlighted preview of the new
 * content (` ```filerow `); `string_replace`/`diff_edit` render an old→new
 * line diff with line numbers (` ```filediff `).
 */
function formatFilePreview(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
	width: number,
): string {
	const path = textArg(tool.args, 'path') || tool.detail;
	const displayName = tool.name === 'write_file' ? 'Write' : 'Edit';
	if (tool.name === 'write_file') {
		// Only render the file preview when the tool actually EXECUTED
		// (output starts with the success prefix). A declined/error result
		// (e.g. `Declined by user.`) must fall back to the generic tail,
		// otherwise the row would show the proposed content as if written.
		if (!/^Wrote /.test(tool.output)) {
			const tail = formatOutputTail(tool.output, expanded, width);
			return tail
				? `${displayName} ${path}\n${tail}`
				: `${displayName} ${path}`;
		}
		const body =
			textArg(tool.args, 'content') || stripResultPrefix(tool.output);
		const lines = body.replace(/\n+$/, '').split('\n');
		const visible = expanded ? lines : lines.slice(0, 50);
		const hidden = lines.length - visible.length;
		const numbered = visible
			.map((line, index) => `${String(index + 1).padStart(4, ' ')} ${line}`)
			.join('\n');
		const footer = hidden > 0 ? `\n  … +${hidden} more lines` : '';
		const header = `✦ ${displayName} ${path}`;
		const summary = ` ⎿ ${displayName}: ${lines.length} line${lines.length === 1 ? '' : 's'}`;
		// Header through the `filerow` tokenizer; the numbered CODE gets its
		// own fence with the file's REAL language so OpenTUI's built-in
		// tree-sitter highlights it (the filerow block only carries the
		// header + summary so the parser never sees non-code text).
		const headerFence = fence('filerow', status, `${header}\n${summary}`);
		const lang = languageForFile(path);
		const codeFence = lang
			? `${'```'}${lang}\n${numbered}\n${'```'}`
			: numbered;
		return `${headerFence}\n${codeFence}${footer}`;
	}
	// string_replace / diff_edit: old → new diff with line numbers. The
	// legacy nanocoder result prefix (`Successfully replaced content at
	// lines N-M`) gates the same diff path as the current `Replaced …`.
	if (
		!/^Replaced /.test(tool.output) &&
		!/^Successfully replaced content at line/.test(tool.output)
	) {
		const tail = formatOutputTail(tool.output, expanded, width);
		const header = `✦ ${displayName} ${path}`;
		return tail ? `${header}\n${tail}` : header;
	}
	const oldStr =
		textArg(tool.args, 'old_string') || textArg(tool.args, 'old_str') || '';
	const newStr =
		textArg(tool.args, 'new_string') ||
		textArg(tool.args, 'new_str') ||
		stripResultPrefix(tool.output);
	// Count the REAL lines, blank lines included: the diff renderer
	// (lineDiff) keeps interior blank lines, so the summary must count them
	// too — filtering empties here made the summary say N while the diff
	// rendered N+1 rows (the phantom "extra line" when the model inserts a
	// blank line). Trailing newlines are stripped so a trailing `\n` never
	// invents a phantom final line.
	const oldLines = oldStr.replace(/\n+$/, '').split('\n');
	const newLines = newStr.replace(/\n+$/, '').split('\n');
	// STRIP REDUNDANT CONTEXT: the edit tool's old/new strings usually
	// ANCHOR the change with identical surrounding lines. Those lines are
	// not part of the change — rendering them as context inflated the diff
	// (a real 3 → 4 edit showed `7 → 8` and 4 phantom "extra" rows). Diff
	// only the MIDDLE that actually differs; the summary then reflects the
	// true change and the rendered rows match it exactly.
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] ===
			newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}
	const diffOld = oldLines.slice(prefix, oldLines.length - suffix);
	const diffNew = newLines.slice(prefix, newLines.length - suffix);
	// DEGENERATE-STRIP GUARD: when old_string is a strict PREFIX (or suffix)
	// of new_string — a block REPLACED by a longer block that starts with
	// the same lines — prefix-stripping consumes the ENTIRE old block and
	// the diff degenerates to `0 lines → N lines` with the replaced lines
	// hidden (the model "replaced" them but the view said pure insertion).
	// Fall back to the FULL old→new so the replacement renders as removes +
	// adds, exactly like git/codex. Anchors are only redundant when a real
	// change remains on BOTH sides.
	let diffOldFinal = diffOld;
	let diffNewFinal = diffNew;
	let stripPrefix = prefix;
	if (diffOld.length === 0 || diffNew.length === 0) {
		diffOldFinal = oldLines;
		diffNewFinal = newLines;
		stripPrefix = 0;
	}
	const summary = ` ⎿ ${diffOldFinal.length} line${diffOldFinal.length === 1 ? '' : 's'} → ${diffNewFinal.length} line${diffNewFinal.length === 1 ? '' : 's'}`;
	// Number the diff against the REAL file, not the snippet: the tool
	// reports where the FIRST occurrence sat (`(at line N)`), and the
	// stripped middle starts `stripPrefix` lines into that occurrence.
	const diff = lineDiffText(
		diffOldFinal.join('\n'),
		diffNewFinal.join('\n'),
		replacementBaseLine(tool.output) + stripPrefix,
	);
	// Cap the diff preview like the Write preview: collapsed shows the first
	// 50 lines with a `+N more lines` footer (expand via click / ctrl+o);
	// expanded shows the whole diff.
	const diffLines = diff.split('\n');
	const visibleDiff = expanded ? diffLines : diffLines.slice(0, 50);
	const hiddenDiff = diffLines.length - visibleDiff.length;
	const diffBody = visibleDiff.join('\n');
	const diffFooter = hiddenDiff > 0 ? `\n  … +${hiddenDiff} more lines` : '';
	const header = `✦ ${displayName} ${path}`;
	// Diff rows stay in ONE `filediff` fence (the +/- markers are not valid
	// code, so the custom tokenizer colors them + the red/green row bg).
	return fence(
		'filediff',
		status,
		`${header}\n${summary}${diffBody ? `\n${diffBody}` : ''}${diffFooter}`,
	);
}

/** Map a file path to an OpenTUI tree-sitter language id. */
function languageForFile(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'typescript';
	if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript';
	if (['md', 'mdx'].includes(ext)) return 'markdown';
	return '';
}

/** Strip the `Wrote/Replaced …` prefix from a tool RESULT, keep the body. */
function stripResultPrefix(output: string): string {
	const match = /^(?:Wrote|Edited|Replaced|Deleted)[^\n]*\n?([\s\S]*)$/.exec(
		output,
	);
	return match?.[1]?.replace(/^\n/, '') ?? output;
}

/**
 * Absolute 1-based line of the FIRST replaced occurrence, parsed from the
 * string_replace result (`Replaced N occurrences in <path> (at line L)`).
 * Falls back to 1 when the result predates the marker (legacy saved
 * sessions, mocks) — the old snippet-relative numbering.
 */
export function replacementBaseLine(output: string): number {
	const match = /^Replaced \d+ occurrences? in .*? \(at line (\d+)\)/.exec(
		output,
	);
	const line = match ? Number(match[1]) : NaN;
	return Number.isFinite(line) && line > 0 ? line : 1;
}

function lineDiffText(oldStr: string, newStr: string, baseLine = 1): string {
	const diff = lineDiff(oldStr, newStr);
	// The diff rows are numbered 1..N relative to the snippet; shift them so
	// they match the REAL file position (the tool reports where the first
	// occurrence sat). Context rows carry the old line number, which equals
	// the new line number for unchanged lines.
	const offset = Math.max(0, baseLine - 1);
	// INDENT: every diff row carries a fixed 2-space container lead, so the
	// numbered block nests under the `✦ Edit` header instead of rendering
	// flush at column 0 (parity: tool/thought bodies sit inside their
	// container). The number field is right-aligned in a 4-wide gutter.
	const lead = '  ';
	return diff
		.map(line => {
			const text = line.text;
			if (line.kind === 'add') {
				return `${lead}${String((line.newLineNo ?? 1) + offset).padStart(4, ' ')} + ${text}`;
			}
			if (line.kind === 'remove') {
				return `${lead}${String((line.oldLineNo ?? 1) + offset).padStart(4, ' ')} - ${text}`;
			}
			// Context rows carry a SPACE in the sigil column so the numbers
			// align with the +/- rows (`   3   text`).
			return `${lead}${String((line.oldLineNo ?? 1) + offset).padStart(4, ' ')}   ${text}`;
		})
		.join('\n');
}

/**
 * Diff row (git_diff): consistent with every other tool, `✦ Name(detail)`
 * header, the output under a `└` container (EXIT_CODE head + stat/patch tail)
 * with a `+N more lines` footer when the collapsed cap hides lines.
 */
function formatDiffRow(
	tool: ToolDisplayData,
	status: RowStatus,
	width: number,
): string {
	const header = tool.detail
		? `✦ ${displayToolName(tool.name)}(${tool.detail})`
		: `✦ ${displayToolName(tool.name)}`;
	const output = formatOutputTail(tool.output, false, width);
	return output ? `${header}\n${output}` : header;
}

function formatBashEntry(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
	width: number,
): string {
	// Plain content, NOT a hand-drawn border: the BashToolRow component
	// wraps this in an OpenTUI bordered box (border is drawn by the layout
	// engine, so wrapped lines always stay inside). The command is
	// pre-wrapped here so the rendered line count matches the block ranges
	// used for hover/click.
	const wrapped = wordWrap(
		tool.detail,
		Math.max(1, width - COMMAND_PROMPT_WIDTH),
	);
	const visibleCount = expanded
		? wrapped.length
		: Math.min(wrapped.length, COMMAND_MAX_LINES);
	const visible = wrapped.slice(0, visibleCount);
	const hiddenCommand = wrapped.length - visibleCount;

	// First line carries the `$` prompt marker, continuations indent to the
	// same column (the component renders them inside the box).
	const commandLines = visible.map(
		(command, index) => `${index === 0 ? '$' : ' '} ${command}`,
	);
	const commandHint =
		hiddenCommand > 0
			? `\n… +${hiddenCommand} more line${hiddenCommand === 1 ? '' : 's'}`
			: '';
	const output = formatOutputTail(tool.output, expanded, width, '');
	return `${commandLines.join('\n')}${commandHint}${output ? `\n${output}` : ''}`;
}

/**
 * Output preview: the TAIL of the output (results/errors are at the end),
 * `└   ` on the first row, `      ` on continuations, and a `+N lines`
 * footer below when the collapsed cap hides lines.
 */
export function formatOutputTail(
	output: string,
	expanded: boolean,
	width = 84,
	/** Container prefix: `  └   ` for generic rows, `''` for the bordered box. */
	prefix = '  └   ',
): string {
	// C5: error results strip the `Error: ` prefix from the visible tail.
	const source = output.replace(/^Error:\s*/, '');
	const lines = source
		.replace(/\r\n/g, '\n')
		.replace(/\s+$/, '')
		.split('\n')
		.filter(line => line !== '');
	if (lines.length === 0) return '';
	const cap = expanded ? PREVIEW_EXPANDED_LINES : PREVIEW_COLLAPSED_LINES;
	const tail = lines.slice(-cap);
	const hidden = lines.length - tail.length;
	// WRAP WITHIN THE CONTAINER: a raw output line longer than the indent
	// width would spill past the `  └   ` edge (bash logs, URLs, test
	// output). Pre-wrap each line so every continuation keeps the indent —
	// the wrapped text can never escape the container.
	const WRAP = Math.max(1, width - BOX_EDGE_WIDTH);
	const wrappedLines: string[] = [];
	for (const line of tail) {
		// A single unbroken line (minified JS, giant log entry) must not
		// wrap into hundreds of rows: keep the HEAD of the line with a
		// trailing `…` marker (parity: toolResultTail).
		const preview =
			line.length > PREVIEW_LINE_MAX_CHARS
				? `${line.slice(0, PREVIEW_LINE_MAX_CHARS)}…`
				: line;
		for (const piece of wordWrap(preview, WRAP)) wrappedLines.push(piece);
	}
	// Hard cap on RENDERED rows too — the per-line cap bounds each line, and
	// this bounds the total even when the source is one huge blob.
	const maxRows = expanded
		? PREVIEW_MAX_ROWS.expanded
		: PREVIEW_MAX_ROWS.collapsed;
	const visibleRows = wrappedLines.slice(-maxRows);
	const hiddenRows = wrappedLines.length - visibleRows.length;
	const contPrefix = prefix === '  └   ' ? '      ' : '';
	const bodyWithWrap = visibleRows
		.map((line, index) => `${index === 0 ? prefix : contPrefix}${line}`)
		.join('\n');
	const footerLines = hidden + hiddenRows;
	const footer =
		footerLines > 0
			? `\n… +${footerLines} more line${footerLines === 1 ? '' : 's'}`
			: '';
	return `${bodyWithWrap}${footer}`;
}

function wordWrap(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		// A single word longer than the width must be HARD-SPLIT (URLs,
		// long paths, unbroken log lines) so no line can escape the
		// container (parity: wrapText's long-word handling).
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
			continue;
		}
		if (current.length + 1 + word.length <= width) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}
