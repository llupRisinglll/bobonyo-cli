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
/** Fixed wrap width for the command (nanocoder uses the live box width). */
const COMMAND_WRAP_WIDTH = 72;

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
): string {
	let raw = formatToolEntryText(tool, expanded, status);
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
	if (canonical === 'execute_bash' || canonical === 'execute_bash:user') return 'bashrow';
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
): string {
	const canonical = resolveToolName(tool.name);
	return canonical === 'execute_bash' || canonical === 'execute_bash:user'
		? formatBashEntry(tool, expanded, status)
		: formatGenericEntry(tool, expanded, status);
}

function formatGenericEntry(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
): string {
	if (tool.name === 'write_file' || tool.name === 'string_replace' || tool.name === 'diff_edit') {
		return formatFilePreview(tool, expanded, status);
	}
	if (tool.name === 'git_diff') {
		return formatDiffRow(tool, status);
	}
	if (tool.name === 'skill' || tool.name === 'check_skill') {
		return formatSkillRow(tool, status);
	}
	if (tool.name === 'write_tasks') {
		return formatTaskList(tool, status);
	}
	// VISUALIZATIONS are never collapsed and never use the `  └   ` tool
	// container: a chart/table must render in FULL (truncating a bar chart
	// to 3 lines hides most of the data and defeats the purpose), and the
	// transcript routes these tools to dedicated CARDS anyway (this branch
	// is only a non-indented fallback for other surfaces). The output is
	// already ASCII, so it wraps safely.
	if (tool.name === 'visualize' || tool.name === 'list_background_tasks') {
		const output = tool.output.replace(/\s+$/, '');
		return output
			? `✦ ${displayToolName(tool.name)}\n${output
					.split('\n')
					.map(line => `  ${line}`)
					.join('\n')}`
			: `✦ ${displayToolName(tool.name)}`;
	}
	const header = tool.detail
		? `✦ ${displayToolName(tool.name)}(${tool.detail})`
		: `✦ ${displayToolName(tool.name)}`;
	const output = formatOutputTail(tool.output, expanded);
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
	const [loadedLine, ...bodyLines] = tool.output.replace(/\s+$/, '').split('\n');
	const previewLines = bodyLines
		.slice(0, 4)
		.map(line =>
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

function textArg(args: Record<string, unknown> | undefined, key: string): string {
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
): string {
	const path = textArg(tool.args, 'path') || tool.detail;
	const displayName = tool.name === 'write_file' ? 'Write' : 'Edit';
	if (tool.name === 'write_file') {
		// Only render the file preview when the tool actually EXECUTED
		// (output starts with the success prefix). A declined/error result
		// (e.g. `Declined by user.`) must fall back to the generic tail,
		// otherwise the row would show the proposed content as if written.
		if (!/^Wrote /.test(tool.output)) {
			const tail = formatOutputTail(tool.output, expanded);
			return tail ? `${displayName} ${path}\n${tail}` : `${displayName} ${path}`;
		}
		const body = textArg(tool.args, 'content') || stripResultPrefix(tool.output);
		const lines = body.replace(/\n+$/, '').split('\n');
		const visible = expanded ? lines : lines.slice(0, 50);
		const hidden = lines.length - visible.length;
		const numbered = visible
			.map((line, index) => `${String(index + 1).padStart(4, ' ')} ${line}`)
			.join('\n');
		const footer =
			hidden > 0
				? `\n  … +${hidden} more lines`
				: '';
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
	// string_replace / diff_edit: old → new diff with line numbers.
	if (!/^Replaced /.test(tool.output)) {
		const tail = formatOutputTail(tool.output, expanded);
		const header = `✦ ${displayName} ${path}`;
		return tail ? `${header}\n${tail}` : header;
	}
	const oldStr = textArg(tool.args, 'old_string') || '';
	const newStr =
		textArg(tool.args, 'new_string') ||
		stripResultPrefix(tool.output);
	const oldLines = oldStr.replace(/\n+$/, '').split('\n').filter(line => line !== '');
	const newLines = newStr.replace(/\n+$/, '').split('\n').filter(line => line !== '');
	const summary = ` ⎿ ${oldLines.length} line${oldLines.length === 1 ? '' : 's'} → ${newLines.length} line${newLines.length === 1 ? '' : 's'}`;
	const diff = lineDiffText(oldStr, newStr);
	const header = `✦ ${displayName} ${path}`;
	// Diff rows stay in ONE `filediff` fence (the +/- markers are not valid
	// code, so the custom tokenizer colors them + the red/green row bg).
	return fence(
		'filediff',
		status,
		`${header}\n${summary}${diff ? `\n${diff}` : ''}`,
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
	const match = /^(?:Wrote|Edited|Replaced|Deleted)[^\n]*\n?([\s\S]*)$/.exec(output);
	return match?.[1]?.replace(/^\n/, '') ?? output;
}

function lineDiffText(oldStr: string, newStr: string): string {
	const diff = lineDiff(oldStr, newStr);
	return diff
		.map(line => {
			const text = line.text;
			if (line.kind === 'add') {
				return `   + ${String(line.newLineNo ?? '').padStart(3, ' ')} ${text}`;
			}
			if (line.kind === 'remove') {
				return `   - ${String(line.oldLineNo ?? '').padStart(3, ' ')} ${text}`;
			}
			return `     ${String(line.oldLineNo ?? '').padStart(3, ' ')} ${text}`;
		})
		.join('\n');
}

/**
 * Diff row (git_diff): consistent with every other tool, `✦ Name(detail)`
 * header, the output under a `└` container (EXIT_CODE head + stat/patch tail)
 * with a `+N more lines` footer when the collapsed cap hides lines.
 */
function formatDiffRow(tool: ToolDisplayData, status: RowStatus): string {
	const header = tool.detail
		? `✦ ${displayToolName(tool.name)}(${tool.detail})`
		: `✦ ${displayToolName(tool.name)}`;
	const output = formatOutputTail(tool.output, false);
	return output ? `${header}\n${output}` : header;
}

function formatBashEntry(
	tool: ToolDisplayData,
	expanded: boolean,
	status: RowStatus,
): string {
	const wrapped = wordWrap(tool.detail, COMMAND_WRAP_WIDTH);
	const visibleCount = expanded
		? wrapped.length
		: Math.min(wrapped.length, COMMAND_MAX_LINES);
	const visible = wrapped.slice(0, visibleCount);
	const hiddenCommand = wrapped.length - visibleCount;

	const commandBlock = visible
		.map((line, index) =>
			index === 0
				? `✦ ${displayToolName(tool.name)}(${line}`
				: `   │ ${line}`,
		)
		.join('\n');
	const commandBlockWithClose = `${commandBlock})`;
	const commandHint =
		hiddenCommand > 0
			? `\n     … +${hiddenCommand} more line${hiddenCommand === 1 ? '' : 's'}`
			: '';
	const output = formatOutputTail(tool.output, expanded);
	return `${commandBlockWithClose}${commandHint}${output ? `\n${output}` : ''}`;
}

/**
 * Output preview: the TAIL of the output (results/errors are at the end),
 * `└   ` on the first row, `      ` on continuations, and a `+N lines`
 * footer below when the collapsed cap hides lines.
 */
export function formatOutputTail(output: string, expanded: boolean): string {
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
	// the wrapped text can never escape the container (parity: the wrapped
	// command lines use the same fixed width).
	const WRAP = 84;
	const wrappedLines: string[] = [];
	for (const line of tail) {
		for (const piece of wordWrap(line, WRAP)) wrappedLines.push(piece);
	}
	const bodyWithWrap = wrappedLines
		.map((line, index) => `${index === 0 ? '  └   ' : '      '}${line}`)
		.join('\n');
	const footer =
		hidden > 0
			? `\n     … +${hidden} line${hidden === 1 ? '' : 's'}`
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
