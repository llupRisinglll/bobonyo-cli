/**
 * Tool registry (parity: nanocoder's tool-registry contract, doc D1).
 * Tools register a handler (plus shared display metadata); `executeTool`
 * resolves by name, pairs results 1:1, and surfaces validation/execution
 * errors without crashing the loop.
 */

import {readFileSync} from 'node:fs';
import {streamChat, type ChatMessageLike, type MockToolCall} from './client';
import {bgTasks, PROGRESS_STEP_MARKERS, runBash} from './bash';
import {lintBody, loadSkills} from './custom';
import {subagentSystemPrompt} from './subagents';
import {activeEndpoint, appendInfo, setActiveAgents, setTasks} from './state';
import {
	executeNativeWebSearch,
	resolveWebSearchFallback,
} from './web-search';
import type {Mode, ToolProfile} from './settings';
import {parseVizData, type VizPoint} from './visualize';
import {publishViz} from './viz-store';

export interface ToolResult {
	tool_call_id: string;
	content: string;
}

export interface ToolContext {
	/** Live output callback (bash streams lines as they arrive). */
	onProgress?: (content: string) => void;
	/** Tool-call id (charts publish under it so the card can subscribe). */
	toolId?: string;
}

interface ToolDef {
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
	/** Read-only tools never require approval (B16/D4 default). */
	readOnly?: boolean;
	/** What the tool does — sent to the model in the tool catalog. */
	description?: string;
}

const toolRegistry = new Map<string, ToolDef>();

export function registerTool(name: string, def: ToolDef): void {
	toolRegistry.set(name, def);
}

export function listTools(): string[] {
	return [...toolRegistry.keys()];
}

/** Description for a registered tool (the model's tool catalog). */
export function toolDescription(name: string): string {
	return toolRegistry.get(name)?.description ?? '';
}

/** Mutation tools require approval in `normal` mode (B16). */
const READ_ONLY_TOOLS = new Set([
	'read_file',
	'find_files',
	'list_directory',
	'search_file_contents',
	'git_status',
	'git_log',
	'git_diff',
	'web_search',
	'fetch_url',
	'skill',
	'check_skill',
	'agent',
	'list_background_tasks',
	'visualize',
]);

export function requiresApproval(
	name: string,
	mode: Mode,
	alwaysAllow: string[] = [],
): boolean {
	if (mode === 'yolo' || mode === 'auto-accept') return false;
	if (alwaysAllow.includes(name) || alwaysAllow.includes(resolveToolName(name))) {
		return false;
	}
	if (READ_ONLY_TOOLS.has(name)) return false;
	if (toolRegistry.get(name)?.readOnly) return false;
	return true;
}

/** Read-only tools never mutate state (B17 parallel batch eligibility). */
export function isReadOnlyTool(name: string): boolean {
	const canonical = resolveToolName(name);
	return READ_ONLY_TOOLS.has(canonical) || toolRegistry.get(canonical)?.readOnly === true;
}

/** Plan mode excludes mutation tools (D3 MODE_EXCLUDED_TOOLS). */
const PLAN_EXCLUDED = new Set([
	'write_file',
	'string_replace',
	'diff_edit',
	'file_op',
	'execute_bash',
	'write_tasks',
	'git_add',
	'git_commit',
	'git_pr',
]);

const sleep = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms));

/**
 * Stream a tool result line-by-line through onProgress so the running row
 * animates (parity: the original mocks reveal output progressively). The
 * settled result still returns the full content.
 */
async function streamLines(
	content: string,
	ctx: ToolContext,
	delayMs = 35,
): Promise<string> {
	const lines = content.split('\n');
	if (lines.length <= 1) return content;
	let acc = '';
	for (const line of lines) {
		acc = acc ? `${acc}\n${line}` : line;
		ctx.onProgress?.(acc);
		await sleep(delayMs);
	}
	return content;
}

/** Tool profiles (D7): nano = 7, minimal = 10 core tools. */
const NANO_TOOLS = new Set([
	'read_file',
	'diff_edit',
	'write_file',
	'execute_bash',
	'web_search',
	'search_file_contents',
]);

const MINIMAL_TOOLS = new Set([
	'execute_bash',
	'read_file',
	'write_file',
	'string_replace',
	'diff_edit',
	'search_file_contents',
	'find_files',
	'web_search',
	'agent',
]);

export function resolveProfile(
	profile: ToolProfile,
	model: string,
): Exclude<ToolProfile, 'auto'> {
	if (profile !== 'auto') return profile;
	const id = model.toLowerCase();
	if (id.includes('nano')) return 'nano';
	if (id.includes('mini') || id.includes('minimal')) return 'minimal';
	return 'full';
}

export function toolAvailability(
	name: string,
	profile: ToolProfile,
	mode: Mode,
	model: string,
): {available: boolean; reason?: string} {
	if (mode === 'plan' && PLAN_EXCLUDED.has(name)) {
		return {available: false, reason: 'not available in plan mode'};
	}
	const resolved = resolveProfile(profile, model);
	if (resolved === 'nano' && !NANO_TOOLS.has(name)) {
		return {available: false, reason: `not available in nano profile`};
	}
	if (resolved === 'minimal' && !MINIMAL_TOOLS.has(name)) {
		return {available: false, reason: `not available in minimal profile`};
	}
	return {available: true};
}

export function isSingleToolProfile(profile: ToolProfile, model: string): boolean {
	const resolved = resolveProfile(profile, model);
	return resolved === 'nano' || resolved === 'minimal';
}

function text(args: Record<string, unknown>, key: string): string {
	return typeof args[key] === 'string' ? (args[key] as string) : '';
}

/**
 * Display name for a tool call (parity flavor of nanocoder's formatter
 * names, mirroring tool-aliases.ts `claudeCode` values): execute_bash →
 * `Bash`, web_search → `WebSearch`, read_file → `Read`, … Tools with no
 * claude-code alias (git_*) keep their raw name.
 */
const CLAUDE_CODE_NAMES: Record<string, string> = {
	execute_bash: 'Bash',
	'execute_bash:user': 'Executed Bash',
	read_file: 'Read',
	write_file: 'Write',
	string_replace: 'Edit',
	diff_edit: 'Edit',
	find_files: 'Find',
	search_file_contents: 'Grep',
	list_directory: 'LS',
	web_search: 'WebSearch',
	fetch_url: 'WebFetch',
	agent: 'agent',
	skill: 'Skill',
	check_skill: 'Skill',
	write_tasks: 'Tasks',
};

export function displayToolName(name: string): string {
	return CLAUDE_CODE_NAMES[name] ?? name;
}

/** Reverse alias map (D2): `Bash` → `execute_bash`, `Read` → `read_file`, … */
const CANONICAL_BY_ALIAS: Record<string, string> = Object.fromEntries(
	Object.entries(CLAUDE_CODE_NAMES).map(([canonical, alias]) => [alias, canonical]),
);

export function resolveToolName(name: string): string {
	return CANONICAL_BY_ALIAS[name] ?? name;
}

/**
 * Related-tool families for compacted tool groups (mirrors nanocoder's
 * TOOL_GROUP_FAMILIES). Tools in the same family share ONE compacted block;
 * everything else is standalone (same-name standalone calls still tally,
 * e.g. `✦ Ran Bash ×3`).
 */
const TOOL_GROUP_FAMILIES: Record<string, string> = {
	web_search: 'web',
	fetch_url: 'web',
	read_file: 'file-read',
	list_directory: 'file-read',
	find_files: 'search',
	search_file_contents: 'search',
	git_status: 'git',
	git_diff: 'git',
	git_log: 'git',
	git_add: 'git',
	git_commit: 'git',
	git_push: 'git',
	git_pull: 'git',
	git_branch: 'git',
	git_stash: 'git',
	git_reset: 'git',
	git_pr: 'git',
	skill: 'skill',
	check_skill: 'skill',
};

export function toolFamily(name: string): string {
	return TOOL_GROUP_FAMILIES[name] ?? `__standalone__:${name}`;
}

/**
 * File-write tools always render their own rows (CompactFileResult in
 * nanocoder), never grouped, even when the same tool runs multiple times.
 */
const FILE_WRITE_TOOLS = new Set(['write_file', 'string_replace', 'diff_edit']);

export function isFileWriteTool(name: string): boolean {
	return FILE_WRITE_TOOLS.has(name);
}

/**
 * Single-line argument summary for a tool header row, the first string-ish
 * argument (bash → command, read_file → path, web_search → query, …).
 */
export function toolArgsSummary(call: MockToolCall): string {
	const args = call.arguments;
	// Git tools synthesize the equivalent CLI invocation from the structured
	// args (parity: nanocoder's getCompactToolDetail) so the header shows
	// what actually ran (`✦ git_diff(git diff --staged --stat)`).
	if (call.name === 'git_diff' || call.name === 'git_log' || call.name === 'git_status') {
		if (call.name === 'git_status') return 'git status';
		const parts = call.name === 'git_diff' ? ['git diff'] : ['git log'];
		if (call.name === 'git_diff') {
			if (args?.staged === true) parts.push('--staged');
			if (args?.stat === true) parts.push('--stat');
		} else if (typeof args?.count === 'number') {
			parts.push(`-n ${args.count}`);
		}
		if (typeof args?.base === 'string' && args.base) parts.push(args.base);
		if (typeof args?.author === 'string' && args.author) parts.push(`--author=${args.author}`);
		if (typeof args?.since === 'string' && args.since) parts.push(`--since=${args.since}`);
		if (typeof args?.file === 'string' && args.file) parts.push(args.file);
		return parts.join(' ');
	}
	const order =
		call.name === 'skill'
			? ['name', 'path', 'description']
			: ['command', 'path', 'pattern', 'query', 'name', 'description'];
	for (const key of order) {
		const value = args?.[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

/**
 * Tool-row detail shown in the `✦ <name>(<detail>)` header. Agents use the
 * nanocoder format `agent:<type>(<task>)` instead of the plain task text.
 */
export function toolDisplayDetail(call: MockToolCall): string {
	if (call.name === 'agent') {
		const type = String(call.arguments.subagent_type ?? 'explore');
		const task = toolArgsSummary(call);
		return `agent:${type}${task ? `(${task})` : ''}`;
	}
	return toolArgsSummary(call);
}

/**
 * First N lines of a tool result, truncated to a sane width per line,
 * the `└` output tail of a settled tool row.
 */
export function toolResultTail(content: string, maxLines = 3, maxWidth = 100): string {
	return content
		.split('\n')
		.slice(0, maxLines)
		.map(line => (line.length > maxWidth ? `${line.slice(0, maxWidth)}…` : line))
		.join('\n');
}

export async function executeTool(
	call: MockToolCall,
	ctx: ToolContext = {},
): Promise<ToolResult> {
	const canonicalName = resolveToolName(call.name);
	const canonicalCall = {...call, name: canonicalName};
	if (call.arguments._malformed) {
		// Invalid JSON arguments: surface a validation error instead of
		// silently executing with defaults (parity: tool-schema error).
		return {
			tool_call_id: call.id,
			content: `Error: Invalid tool arguments: ${call.rawArguments}`,
		};
	}
	const def = toolRegistry.get(canonicalName);
	if (!def) {
		return {tool_call_id: call.id, content: `Unknown tool: ${call.name}`};
	}
	try {
		const content = await def.execute(canonicalCall.arguments, ctx);
		return {tool_call_id: call.id, content};
	} catch (error) {
		return {
			tool_call_id: call.id,
			content: `Error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

registerTool('read_file', {
	async execute(args) {
		const path = text(args, 'path') || 'README.md';
		return Bun.file(path).text();
	},
});

registerTool('execute_bash', {
	async execute(args, ctx) {
		const command = text(args, 'command') || 'true';
		const result = await runBash(command, ctx.onProgress);
		return result.content;
	},
});

registerTool('list_background_tasks', {
	description:
		'List every running/completed background task with its status, ' +
		'elapsed time, and output tail as a TABLE. Call this ONCE per check, ' +
		'NOT in a loop. If a task is still running, report the progress and ' +
		'stop; you may use visualize to show the progress chart. NEVER use ' +
		'monitor for polling.',
	execute() {
		const tasks = bgTasks();
		if (tasks.length === 0) return 'No background tasks.';
		// Progress chart: each task's recognized milestone as a bar, so a
		// worktree/e2e build reads as a progress card instead of raw lines.
		const progressLines = tasks
			.map(task => {
				const steps = task.progress.map(p => p.step);
				const label = `${task.id} (${task.running ? 'running' : `exit ${task.exitCode ?? '?'}`})`;
				if (steps.length === 0) {
					return `${label}:0:${PROGRESS_STEP_MARKERS.length}`;
				}
				const total = PROGRESS_STEP_MARKERS.length;
				return `${label}:${steps.length}:${total}`;
			})
			.join('\n');
		// ASCII progress bars per task: `[█████░░░░░] 4/7 steps`.
		const bars = tasks
			.map(task => {
				const total = PROGRESS_STEP_MARKERS.length;
				const done = Math.min(total, task.progress.length);
				const filled = Math.round((done / Math.max(1, total)) * 20);
				const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 20 - filled));
				const status = task.running
					? 'running'
					: `exit ${task.exitCode ?? '?'}`;
				const steps = task.progress.map(p => p.step).join(', ');
				return `  ${task.id} [${bar}] ${done}/${total} ${status}${steps ? ` — ${steps}` : ''}`;
			})
			.join('\n');
		// Markdown table — the built-in markdown formatter renders it (the
		// dedicated table VISUALIZATION is not needed).
		const rows = tasks.map(
			task =>
				`| ${task.id} | ${task.running ? 'running' : `exit ${task.exitCode ?? '?'}`} | ` +
				`${Math.round((Date.now() - task.startedAt) / 1000)}s | ` +
				`${task.command.slice(0, 50)} | ${task.output.slice(-1).join('').slice(0, 30)} | ` +
				`${task.progress.length}/${PROGRESS_STEP_MARKERS.length} steps |`,
		);
		return (
			`Progress:\n${bars || '  (no progress markers yet)'}\n\n` +
			`Steps: ${progressLines}\n\n` +
			`| id | status | elapsed | command | tail | steps |\n` +
			`|---|---|---|---|---|---|\n` +
			rows.join('\n')
		);
	},
});

// `monitor` stays registered ONLY so legacy calls (mock worktree scenarios)
// resolve; it returns a redirect instead of task output, so the agent is
// forced toward list_background_tasks / visualize.
registerTool('monitor', {
	description:
		'DEPRECATED. Use list_background_tasks (overview table) and visualize ' +
		'(chart) for progress. This tool returns no task output.',
	execute() {
		return (
			'[monitor deprecated] Call list_background_tasks for the overview ' +
			'table, then visualize for charts. No output returned.'
		);
	},
});

registerTool('visualize', {
	description:
		'Render numbers as a REAL-TIME chart UI the user can read at a glance. ' +
		"kind: 'bar' | 'line' | 'heat' | 'spark'. data: JSON array of " +
		"{label, value} objects (or {label, value, status}), or CSV lines " +
		"'label,value'. HEAT example: data: [{label: 'login.spec.ts', " +
		"status: 'passed'}, {label: 'pay.spec.ts', status: 'failed'}] — " +
		'status accepts passed/failed/running or true/false, and renders ' +
		'✓ pass / ✗ fail / ◐ run rows. Use this INSTEAD of dumping raw ' +
		'numbers when summarizing stats, progress, timings, git counts, ' +
		'test runs, or any series. Use chartId to update the SAME card ' +
		'across repeated calls. IMPORTANT: the chart IS your final answer — ' +
		'after calling visualize, do NOT also write the same numbers as a ' +
		'table, list, or text recap. One short sentence of insight maximum.',
	readOnly: true,
	async execute(args, ctx) {
		const kind = text(args, 'kind') || 'bar';
		const title = text(args, 'title') || 'Values';
		const chartId =
			(typeof args.chartId === 'string' && args.chartId) || title;
		const points = parseVizData(args.data ?? args.values ?? args.rows);
		if (points.length === 0) return 'No data to visualize.';
		// REAL-TIME: stream the points one by one so the chart GROWS live in
		// the transcript (each `label:value` line is parsed by the chart
		// component as it arrives). The settled row renders the full chart
		// from the final output.
		let acc = '';
		for (const point of points) {
			acc = acc ? `${acc}\n${point.label}:${point.value}` : `${point.label}:${point.value}`;
			ctx.onProgress?.(acc);
			// PUBLISH to the real-time store: the chart card in the
			// transcript reads this signal and grows in place.
			const published: VizPoint[] = [];
			for (const line of acc.split('\n')) {
				const [label, value] = line.split(':');
				const n = Number(value);
				if (label && Number.isFinite(n)) {
					const original = points.find(p => p.label === label);
					published.push({
						label,
						value: n,
						...(original?.status ? {status: original.status} : {}),
					});
				}
			}
			// PUBLISH under the STABLE chart identity: repeated `visualize`
			// calls with the same chartId update the SAME card (the LLM keeps
			// calling the tool and the card refreshes, like the task list).
			publishViz(chartId, title, kind, published);
			await sleep(600);
		}
		return acc;
	},
});

registerTool('write_file', {
	async execute(args) {
		const path = text(args, 'path') || 'scratch/mock-write.txt';
		const body = text(args, 'content') ?? '';
		await Bun.write(path, body);
		return `Wrote ${body.length} chars to ${path}\n${body}`;
	},
});

registerTool('string_replace', {
	async execute(args) {
		const path = text(args, 'path') || 'scratch/mock-edit.txt';
		const oldString = text(args, 'old_string') ?? '';
		const newString = text(args, 'new_string') ?? '';
		const exists = await Bun.file(path).exists();
		let current = exists ? await Bun.file(path).text() : oldString;
		if (!current.includes(oldString)) {
			// Empty/legacy target (a previous mock run deleted the content):
			// seed from old_string so the replacement is deterministic.
			if (current.trim() === '') current = oldString;
			else {
			return `Error: '${oldString}' not found in ${path}`;
			}
		}
		const count = current.split(oldString).length - 1;
		const updated = current.split(oldString).join(newString);
		await Bun.write(path, updated);
		return `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${path}\n${updated}`;
	},
});

registerTool('diff_edit', {
	async execute(args) {
		const diff = text(args, 'diff') ?? '';
		const cwd = text(args, 'cwd') || process.cwd();
		const result = Bun.spawnSync(['patch', '-p1', '--forward'], {
			cwd,
			stdin: new TextEncoder().encode(diff),
		});
		const out = (result.stdout?.toString() ?? '').trim();
		const err = (result.stderr?.toString() ?? '').trim();
		return `EXIT_CODE: ${result.exitCode}\n${out}${err ? `\n${err}` : ''}\n${diff}`;
	},
});

registerTool('git_status', {
	async execute(args, ctx) {
		const cwd = text(args, 'cwd') || process.cwd();
		const result = Bun.spawnSync(['git', 'status', '--short'], {
			cwd,
		});
		return streamLines(
			(result.stdout?.toString() ?? '').trim() || 'working tree clean',
			ctx,
		);
	},
});

registerTool('git_log', {
	async execute(args, ctx) {
		const cwd = text(args, 'cwd') || process.cwd();
		const count = Math.max(1, Math.min(50, Number(args.count) || 10));
		const result = Bun.spawnSync(
			['git', 'log', `-n ${count}`, '--pretty=format:%h %s'],
			{cwd},
		);
		const out = (result.stdout?.toString() ?? '').trim();
		return streamLines(`EXIT_CODE: ${result.exitCode}\n${out}`.trim(), ctx);
	},
});

registerTool('git_diff', {
	async execute(args, ctx) {
		const cwd = text(args, 'cwd') || process.cwd();
		const staged = args.staged === true;
		const stat = args.stat === true;
		const result = Bun.spawnSync(
			['git', 'diff', ...(staged ? ['--staged'] : []), ...(stat ? ['--stat'] : [])],
			{cwd},
		);
		const out = (result.stdout?.toString() ?? '').trim();
		return streamLines(`EXIT_CODE: ${result.exitCode}\n${out}`.trim(), ctx);
	},
});

for (const name of ['git_add', 'git_commit', 'git_push', 'git_pull', 'git_branch']) {
	registerTool(name, {
		execute(args) {
			const cwd = text(args, 'cwd') || process.cwd();
			const rest = Array.isArray(args.args) ? args.args.map(String) : [];
			const sub = name.slice('git_'.length);
			const result = Bun.spawnSync(['git', sub, ...rest], {cwd});
			const out = (result.stdout?.toString() ?? '').trim();
			const err = (result.stderr?.toString() ?? '').trim();
			return `EXIT_CODE: ${result.exitCode}\n${out}${err ? `\n${err}` : ''}`.trim();
		},
	});
}

for (const name of ['git_stash', 'git_reset']) {
	registerTool(name, {
		execute(args) {
			const cwd = text(args, 'cwd') || process.cwd();
			const rest = Array.isArray(args.args) ? args.args.map(String) : [];
			const sub = name.slice('git_'.length);
			const result = Bun.spawnSync(['git', sub, ...rest], {cwd});
			const out = (result.stdout?.toString() ?? '').trim();
			const err = (result.stderr?.toString() ?? '').trim();
			return `EXIT_CODE: ${result.exitCode}\n${out}${err ? `\n${err}` : ''}`.trim();
		},
	});
}

registerTool('git_pr', {
	execute(args) {
		const cwd = text(args, 'cwd') || process.cwd();
		const result = Bun.spawnSync(
			['gh', 'pr', 'view', '--json', 'url,title,state'],
			{cwd},
		);
		const out = (result.stdout?.toString() ?? '').trim();
		if (result.exitCode !== 0) {
			return `EXIT_CODE: ${result.exitCode}\n${out}`.trim();
		}
		try {
			const pr = JSON.parse(out) as {url?: string; title?: string; state?: string};
			return `PR: ${pr.title ?? ''} (${pr.state ?? ''})\n${pr.url ?? ''}`;
		} catch {
			return `EXIT_CODE: ${result.exitCode}\n${out}`.trim();
		}
	},
});

registerTool('file_op', {
	async execute(args) {
		const op = text(args, 'op') || 'stat';
		const path = text(args, 'path') || '.';
		const target = text(args, 'target') ?? '';
		switch (op) {
			case 'read':
			case 'cat': {
				const file = Bun.file(path);
				if (!(await file.exists())) return `Error: ${path} does not exist`;
				return (await file.text()).trim();
			}
			case 'delete':
			case 'rm': {
				Bun.spawnSync(['rm', '-f', path], {cwd: process.cwd()});
				return `Deleted ${path}`;
			}
			case 'move':
			case 'rename': {
				if (!target) return 'Error: file_op move needs a target';
				Bun.spawnSync(['mv', path, target], {cwd: process.cwd()});
				return `Moved ${path} -> ${target}`;
			}
			case 'copy': {
				if (!target) return 'Error: file_op copy needs a target';
				Bun.spawnSync(['cp', path, target], {cwd: process.cwd()});
				return `Copied ${path} -> ${target}`;
			}
			case 'mkdir': {
				Bun.spawnSync(['mkdir', '-p', path], {cwd: process.cwd()});
				return `Created directory ${path}`;
			}
			default:
				return `stat ${path}`;
		}
	},
});

registerTool('check_skill', {
	execute(args) {
		const name = text(args, 'name') || 'unknown';
		const path = text(args, 'path') || `<${name}>`;
		return `Skill ${name} is loadable (${path}).`;
	},
});

registerTool('find_files', {
	async execute(args, ctx) {
		const pattern = text(args, 'pattern') || '**/*';
		const path = text(args, 'path') || '.';
		const result = Bun.spawnSync(
			['rg', '--files', '-g', pattern, path],
			{cwd: process.cwd()},
		);
		const out = (result.stdout?.toString() ?? '').trim();
		return streamLines(out || `no files matched ${pattern}`, ctx);
	},
});

registerTool('list_directory', {
	async execute(args, ctx) {
		const path = text(args, 'path') || '.';
		const result = Bun.spawnSync(['ls', '-1', path], {
			cwd: process.cwd(),
		});
		const out = (result.stdout?.toString() ?? '').trim();
		return streamLines(out || `empty directory: ${path}`, ctx);
	},
});

registerTool('search_file_contents', {
	execute(args) {
		const pattern = text(args, 'pattern') || 'mock-provider';
		const path = text(args, 'path') || '.';
		const result = Bun.spawnSync(['rg', '-l', pattern, path], {
			cwd: process.cwd(),
		});
		return (
			(result.stdout?.toString() ?? '').trim() ||
			`no matches for ${pattern}`
		);
	},
});

registerTool('web_search', {
	async execute(args, ctx) {
		const query = text(args, 'query') || 'web search';
		// Fallback model configured (Settings → Capabilities → Web search
		// model): run the query through its provider's NATIVE server-side
		// search and emit the chat indicator (parity: nanocoder's
		// `✦ WebSearch fallback: <model> searched → <main> responds`).
		const fallback = resolveWebSearchFallback();
		if (fallback) {
			try {
				const results = await executeNativeWebSearch(query);
				if (results !== null) {
					appendInfo(
						`  ✦ WebSearch fallback: ${fallback.model} searched → ` +
							`${activeEndpoint().model} responds`,
					);
					return results;
				}
			} catch (error) {
				return `Error: ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		}
		return streamLines(
			// Parity with `nanocoder preview tui`'s canned web-search result.
			'1. Ink, React for CLIs\n2. Static vs live rendering in terminal apps\n3. Mouse handling in raw-mode TUIs',
			ctx,
			120,
		);
	},
});

registerTool('fetch_url', {
	async execute(args, ctx) {
		void text(args, 'url');
		return streamLines(
			'<html><head><title>Example Docs</title></head><body><h1>Welcome</h1></body></html>',
			ctx,
			100,
		);
	},
});

registerTool('skill', {
	execute(args) {
		const name = text(args, 'name') || 'unknown';
		const path = text(args, 'path') || `<${name}>`;
		const skill = loadSkills().find(
			candidate => candidate.name.toLowerCase() === name.toLowerCase(),
		);
		if (skill) {
			return `Loaded skill ${name} from ${skill.source}\n${skill.body.trim()}`;
		}
		// Path-based fallback: read the md file directly when it exists.
		try {
			if (path.startsWith('<')) throw new Error('no path');
			const content = readFileSync(path, 'utf8');
			return `Loaded skill ${name} from ${path}\n${content.trim()}`;
		} catch {
			return `Loaded skill ${name} from ${path}`;
		}
	},
});

registerTool('check_skill', {
	execute(args) {
		const name = text(args, 'name') || 'unknown';
		const skill = loadSkills().find(
			candidate => candidate.name.toLowerCase() === name.toLowerCase(),
		);
		if (!skill) {
			return `Skill ${name} not found.`;
		}
		const issues = lintBody(skill.body, []);
		return issues.length === 0
			? `Skill ${name} is valid (${skill.source}).`
			: `Skill ${name} has undeclared template vars: ${issues.join(', ')}`;
	},
});

registerTool('agent', {
	async execute(args, ctx) {
		const description =
			text(args, 'description') || 'investigate the repository';
		const subagentType = text(args, 'subagent_type') || 'explore';
		setActiveAgents(prev => prev + 1);
		try {
			return await runSubagent(subagentType, description, ctx.onProgress);
		} finally {
			setActiveAgents(prev => Math.max(0, prev - 1));
		}
	},
});

/** Default subagent personalities (parity: the reference/openclaude). */
export const SUBAGENT_TYPES: Record<
	string,
	{label: string; instruction: string}
> = {
	general: {
		label: 'General',
		instruction:
			'You are a general assistant agent. Complete the assigned task using ' +
			'the available tools; read first, then act, and report what you did.',
	},
	explore: {
		label: 'Explore',
		instruction:
			'You are an exploration agent. Investigate the repository and report ' +
			'findings concisely, cite files and lines you actually read.',
	},
};

registerTool('write_tasks', {
	execute(args) {
		const tasks = Array.isArray(args.tasks) ? args.tasks : [];
		if (tasks.length === 0) return 'Tasks updated: no tasks.';
		const lines = tasks.map((task, index) => {
			const title =
				typeof task === 'string'
					? task
					: typeof task === 'object' && task !== null && 'title' in task
						? String((task as {title?: unknown}).title ?? 'task')
				: 'task';
			return `${index + 1}. ${title}`;
		});
		// A7/C9: publish the live task list for the running overlay.
		setTasks(
			tasks.map(task => ({
				title:
					typeof task === 'string'
						? task
						: typeof task === 'object' && task !== null && 'title' in task
							? String((task as {title?: unknown}).title ?? 'task')
							: 'task',
			})),
		);
		return `Tasks updated:\n${lines.join('\n')}`;
	},
});

async function runSubagent(
	subagentType: string,
	description: string,
	onProgress?: (output: string) => void,
): Promise<string> {
	// Custom agents (`.nanocoder/agents/*.md`, user agents) carry their own
	// system prompt; built-ins fall back to the registry instructions.
	const customPrompt = subagentSystemPrompt(subagentType);
	let history: ChatMessageLike[] = [
		{
			role: 'user',
			content:
				`${
					customPrompt ||
					(SUBAGENT_TYPES[subagentType]?.instruction ??
						SUBAGENT_TYPES.general!.instruction)
				}\n\n` +
				`Task: ${description}`,
		},
	];
	for (let round = 0; round < 6; round++) {
		const result = await streamChat(history, {
			// C10: stream the subagent's reasoning/text into the running row so
			// its per-call progress is visible while it works.
			onText: text => onProgress?.(text),
			onReasoning: () => {},
		}, undefined, listTools().map(name => ({name})));
		if (result.toolCalls.length === 0) {
			return result.text.trim() || 'Subagent produced no output.';
		}
		const toolMessages: ChatMessageLike[] = [];
		for (const call of result.toolCalls) {
			const toolResult = await executeTool(call);
			toolMessages.push({
				role: 'tool',
				content: toolResult.content,
				tool_call_id: toolResult.tool_call_id,
			});
		}
		history = [
			...history,
			{
				role: 'assistant',
				content: result.text,
				tool_calls: result.toolCalls.map(call => ({
					id: call.id,
					name: call.name,
					arguments: call.rawArguments,
				})),
			},
			...toolMessages,
		];
	}
	return `Subagent ${subagentType} finished without a final response.`;
}
