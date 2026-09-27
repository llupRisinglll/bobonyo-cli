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
import {stripEchoedCommand} from './bash';
import type {RowStatus} from './row-highlight';
import {tasks} from './state';
import {fence, formatOutputTail, wordWrap} from './tool-display-output';
import type {ToolDisplayData} from './tool-display-types';
import {formatFilePreview} from './tool-display-files';
export {
	PREVIEW_COLLAPSED_LINES,
	PREVIEW_EXPANDED_LINES,
	PREVIEW_LINE_MAX_CHARS,
	PREVIEW_MAX_ROWS,
	fence,
	formatOutputTail,
} from './tool-display-output';
export type {ToolDisplayData} from './tool-display-types';
export {formatFilePreview, replacementBaseLine} from './tool-display-files';

export const COMMAND_MAX_LINES = 3;
/**
 * Max characters kept from ONE output line before wrapping. A single
 * unbroken line (minified JS, a giant log entry) must not expand into
 * hundreds of wrapped rows; the HEAD of the line is kept with a trailing
 * `…` marker (parity: toolResultTail) so the truncation stays visible in
 * the preview's tail rows.
 */
/**
 * Hard cap on RENDERED (wrapped) rows per preview — the backstop that
 * guarantees a huge line can never flood the transcript even when the
 * capture-side cap did not apply (resumed sessions, saved transcripts).
 * Collapsed shows exactly the "3 lines" target ON RENDERED ROWS (a wrapped
 * long line must not grow the preview past it); expanded is the generous
 * opt-in view (up to 200 rows from 50 raw lines).
 */
/**
 * Bordered-bash chrome. The command lives INSIDE the box on its own line
 * (`│ $ cmd`), so the wrap width is the box width minus the `│ ` left edge
 * and the `│` right edge.
 */
/** Command prompt: `│ $ ` (4 chars) — the `$` is the command indicator. */
const COMMAND_PROMPT_WIDTH = 4;

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
	if (isTaskProgressTool(tool.name)) return raw;
	return plain ? raw : fence(rowLanguage(tool.name), status, raw);
}

/** Row language id for a tool (used by the History renderNode). */
export function rowLanguage(name: string): string {
	const canonical = resolveToolName(name);
	if (canonical === 'execute_bash' || canonical === 'execute_bash:user')
		return 'bashrow';
	if (name === 'write_file') return 'filerow';
	if (
		name === 'edit_file' ||
		name === 'string_replace' ||
		name === 'diff_edit' ||
		name === 'apply_patch'
	)
		return 'filediff';
	if (name === 'git_diff') return 'diffrow';
	if (name === 'agent' || name === 'review_changes') return 'agentrow';
	if (name === 'write_tasks') return 'taskrow';
	return 'toolrow';
}
/** Shared glyph metadata for every transcript row language. */
export function rowGlyph(language: string): '✦' | '⚙' {
	return language === 'thought' ? '⚙' : '✦';
}

/** Human-facing task progress, intentionally not rendered as a tool call. */
export function formatTaskStatusText(
	tool: ToolDisplayData,
	status: RowStatus,
): string {
	const rawTitle =
		typeof tool.args?.title === 'string' ? tool.args.title.trim() : '';
	const outputTitle = /^\S+\s+·\s+\S+\s+·\s+(.+?)(?:\s+·|$)/.exec(
		tool.output.split('\n', 1)[0] ?? '',
	)?.[1];
	const outputStatus =
		/^\S+\s+·\s+(pending|in_progress|completed|cancelled)\s+·/.exec(
			tool.output.split('\n', 1)[0] ?? '',
		)?.[1];
	const title = rawTitle || outputTitle || 'task checklist';
	const taskRows = Array.isArray(tool.args?.tasks) ? tool.args.tasks : [];
	const hasUnfinished = taskRows.some(
		task =>
			Boolean(task) &&
			typeof task === 'object' &&
			['pending', 'in_progress'].includes(
				String((task as {status?: unknown}).status),
			),
	);
	const working =
		status === 'running' ||
		(tool.args?.status ?? outputStatus) === 'in_progress' ||
		(!tool.args?.status && hasUnfinished);
	return `${working ? 'Working on' : 'Finished working on'}: ${title}`;
}

export function isTaskProgressTool(name: string): boolean {
	return ['write_tasks', 'task_create', 'task_update'].includes(name);
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
		tool.name === 'edit_file' ||
		tool.name === 'string_replace' ||
		tool.name === 'diff_edit' ||
		tool.name === 'apply_patch'
	) {
		return formatFilePreview(tool, expanded, status, width);
	}
	if (tool.name === 'git_diff') {
		return formatDiffRow(tool, status, width);
	}
	if (tool.name === 'skill' || tool.name === 'check_skill') {
		return formatSkillRow(tool, status);
	}
	if (tool.name === 'write_tasks') return formatTaskList(tool, status);
	if (isTaskProgressTool(tool.name)) return formatTaskStatusText(tool, status);
	if (tool.name === 'review_changes') return tool.output;
	if (tool.name === 'agent') {
		const detail = tool.detail || 'agent';
		const state =
			status === 'running'
				? 'running'
				: tool.output.includes('Started background agent')
					? 'started'
					: 'completed';
		return `✦ Ran ${detail} ${state}`;
	}
	const header = tool.detail
		? `✦ ${displayToolName(tool.name)}(${tool.detail})`
		: `✦ ${displayToolName(tool.name)}`;
	const output = formatOutputTail(tool.output, expanded, width);
	return output ? `${header}\n${output}` : header;
}

/**
 * Task list (parity: nanocoder's TaskListDisplay), `✦ <title> (N done, M in
 * progress, K open)` header + `›/◆/·` status icons per task, colored by
 * state. Saved arguments own each snapshot, including an explicit empty
 * list. Only a running call without saved tasks may read the live signal.
 */
function formatTaskList(tool: ToolDisplayData, status: RowStatus): string {
	const saved = Array.isArray(tool.args?.tasks)
		? tool.args.tasks.filter(
				(task): task is ReturnType<typeof tasks>[number] =>
					Boolean(task) &&
					typeof task === 'object' &&
					typeof (task as {title?: unknown}).title === 'string' &&
					typeof (task as {status?: unknown}).status === 'string',
			)
		: [];
	const list = Array.isArray(tool.args?.tasks)
		? saved
		: status === 'running'
			? tasks()
			: [];
	const done = list.filter(task => task.status === 'completed').length;
	const running = list.filter(task => task.status === 'in_progress').length;
	const cancelled = list.filter(task => task.status === 'cancelled').length;
	const open = list.length - done - running - cancelled;
	const suffix = ` (${done} done, ${running} in progress, ${open} open)`;
	const title =
		typeof tool.args?.title === 'string' && tool.args.title.trim()
			? tool.args.title.trim()
			: displayToolName(tool.name);
	if (tool.compactTask) {
		const content = `✦ ${title}${suffix}`;
		return fence('taskrow', status, content);
	}
	const lines = list.map((task, index) => {
		const icon =
			task.status === 'completed'
				? '◆'
				: task.status === 'in_progress'
					? '›'
					: task.status === 'cancelled'
						? '×'
						: '·';
		const label =
			task.status === 'in_progress' && task.activeForm
				? task.activeForm
				: task.title;
		return `${index === 0 ? '  └ ' : '    '}${icon} ${label}`;
	});
	return fence(
		'taskrow',
		status,
		`✦ ${title}${suffix}${lines.length ? `\n${lines.join('\n')}` : ''}`,
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
	// DISPLAY HEAL: drop a leading echoed-command line from the saved
	// output (the shell printed the typed command back, e.g.
	// `EXIT_CODE: 0\n$ cd x && echo hi\nhi`). The command line right above
	// IS the header, so the echo would render the command twice — the
	// "entry shows twice" artifact. The capture path (runBash) strips the
	// echo going forward; this heals already-persisted sessions at render.
	const output = formatOutputTail(
		stripBashEcho(tool.output, tool.detail),
		expanded,
		width,
		'',
	);
	return `${commandLines.join('\n')}${commandHint}${output ? `\n${output}` : ''}`;
}

/**
 * Display-level heal for already-saved bash results: drop a leading
 * echoed-command line (the shell printed the typed command back into the
 * captured stream). The row's box header already shows the command, so a
 * saved `EXIT_CODE: 0\n$ cd x && echo hi\nhi` would otherwise render the
 * command twice. runBash strips the echo at CAPTURE for new runs; this
 * handles pre-fix persisted sessions. Pure, unit-tested.
 */
export function stripBashEcho(output: string, command: string): string {
	if (!command.trim()) return output;
	const lines = output.split('\n');
	// runBash results carry a leading `EXIT_CODE: N`; the echo (when the
	// shell printed the command) lands right after it. Raw captures (or
	// non-EXIT_CODE results like `Declined by user.`) start with the echo.
	let i = 0;
	while (i < lines.length && (lines[i]?.trim() ?? '') === '') i++;
	if (/^EXIT_CODE:\s*-?\d+/.test(lines[i]?.trim() ?? '')) {
		i++;
	}
	const stripped = stripEchoedCommand(lines.slice(i), command);
	return [...lines.slice(0, i), ...stripped].join('\n');
}
