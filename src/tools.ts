/**
 * Tool registry (parity: nanocoder's tool-registry contract, doc D1).
 * Tools register a handler (plus shared display metadata); `executeTool`
 * resolves by name, pairs results 1:1, and surfaces validation/execution
 * errors without crashing the loop.
 */

import {readFileSync, statSync, unlinkSync} from 'node:fs';
import {
	streamChat,
	type ChatMessageLike,
	type MockToolCall,
	type ToolCatalogEntry,
} from './client';
import {runBash} from './bash';
import {lintBody, loadSkills} from './custom';
import {subagentSystemPrompt} from './subagents';
import {activeEndpoint, appendInfo, setActiveAgents, setTasks} from './state';
import {snapshotMutationTargets} from './file-undo';
import {
	executeNativeWebSearch,
	resolveWebSearchFallback,
} from './web-search';
import type {Mode, ToolProfile} from './settings';

export interface ToolResult {
	tool_call_id: string;
	content: string;
}

export interface ToolContext {
	/** Live output callback (bash streams lines as they arrive). */
	onProgress?: (content: string) => void;
}

interface ToolDef {
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
	/** Read-only tools never require approval (B16/D4 default). */
	readOnly?: boolean;
	/** Model-facing description (the provider sees this in the tools array). */
	description?: string;
	/** Model-facing JSON schema for the arguments (empty schema by default). */
	parameters?: Record<string, unknown>;
}

const toolRegistry = new Map<string, ToolDef>();

export function registerTool(name: string, def: ToolDef): void {
	toolRegistry.set(name, def);
}

export function listTools(): string[] {
	return [...toolRegistry.keys()];
}

/**
 * Model-facing tool catalog: the registry names plus the optional
 * descriptions/schemas each tool declares. The request head uses THIS (a
 * bare name list leaves the model guessing what each tool does — the
 * `skill` tools were unusable until they got descriptions + schemas).
 */
export function toolCatalog(): ToolCatalogEntry[] {
	return [...toolRegistry.entries()].map(([name, def]) => ({
		name,
		description: def.description ?? '',
		parameters: def.parameters,
	}));
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
	'delete_file',
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
	'delete_file',
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
	'delete_file',
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
	delete_file: 'Delete',
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
		// /undo parity (openclaude rewind): snapshot the file(s) this
		// mutation will touch BEFORE executing, so a later undo can restore
		// them alongside the transcript truncation. Non-file tools no-op.
		snapshotMutationTargets(canonicalName, canonicalCall.arguments);
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
	description:
		'Run a shell command in the terminal (builds, tests, git, process ' +
		'management, file inspection — anything no dedicated file tool ' +
		'covers; prefer write_file/string_replace/diff_edit for editing ' +
		'files and delete_file for deleting them). ' +
		'ALWAYS write a one-line PRE-TOOL BRIEF before calling this tool — ' +
		'what you are about to run and why, ≤8 words (e.g. "run tests to ' +
		'verify") — THEN call it in the same message; this requirement ' +
		'overrides any general "no narration" style rules. The brief is ' +
		'MANDATORY when the previous bash call had no explanation, or when ' +
		'this call starts a NEW action or goal. Keep it terse ONLY when ' +
		'this exact call continues the same goal you already explained in ' +
		'the previous message.',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The shell command to execute.',
			},
		},
		required: ['command'],
	},
	async execute(args, ctx) {
		const command = text(args, 'command') || 'true';
		const result = await runBash(command, ctx.onProgress);
		return result.content;
	},
});

registerTool('write_file', {
	description:
		'Create or fully overwrite a file with new content. For small edits ' +
		'prefer string_replace (targeted) or diff_edit (patch) so the change ' +
		'is visible as a diff.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or cwd-relative path of the file to write.',
			},
			content: {
				type: 'string',
				description: 'The full new file content.',
			},
		},
		required: ['path', 'content'],
	},
	async execute(args) {
		const path = text(args, 'path') || 'scratch/mock-write.txt';
		const body = text(args, 'content') ?? '';
		await Bun.write(path, body);
		return `Wrote ${body.length} chars to ${path}\n${body}`;
	},
});

registerTool('string_replace', {
	description:
		'Replace one exact substring in a file with new text (a targeted edit, ' +
		'keeps the rest of the file intact).',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or cwd-relative path of the file to edit.',
			},
			old_string: {
				type: 'string',
				description:
					'The exact existing text to replace (must match verbatim).',
			},
			new_string: {
				type: 'string',
				description: 'The replacement text.',
			},
		},
		required: ['path', 'old_string', 'new_string'],
	},
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
	description:
		'Apply a unified diff (patch -p1 --forward) to the repository. Use for ' +
		'multi-hunk edits where the change should be shown as a diff.',
	parameters: {
		type: 'object',
		properties: {
			diff: {
				type: 'string',
				description:
					'A unified diff (---/+++ headers with @@ hunks) applied with patch -p1.',
			},
			cwd: {
				type: 'string',
				description: 'Working directory to apply the patch in (default: cwd).',
			},
		},
		required: ['diff'],
	},
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

registerTool('delete_file', {
	description:
		'Permanently delete a single file. Prefer this over `rm` in bash: ' +
		'deletions flow through the harness (approval in normal mode, and ' +
		'the hook point for file-protection rules) instead of a raw shell ' +
		'command. Directories are NOT supported — use bash for those.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description:
					'Absolute or cwd-relative path of the file to delete.',
			},
		},
		required: ['path'],
	},
	async execute(args) {
		const path = text(args, 'path') || 'scratch/mock-delete.txt';
		try {
			const stat = statSync(path);
			if (stat.isDirectory()) {
				return `Error: ${path} is a directory — delete_file only removes files (use bash for directories).`;
			}
			unlinkSync(path);
			return `Deleted ${path}`;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return `Error: ${path} does not exist`;
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
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
	description:
		'Load a skill (a markdown instruction bundle) into context. Skills are ' +
		'listed in the SYSTEM prompt under AVAILABLE SKILLS — pick the one that ' +
		'matches the task (e.g. hilinga-prod-ops for production server work) and ' +
		'call this with its exact name before acting on that domain.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Exact skill name from the AVAILABLE SKILLS list.',
			},
		},
		required: ['name'],
	},
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
	description:
		'Check whether a skill exists and is valid (no undeclared template ' +
		'variables). Use before/after calling the skill tool to confirm the name.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Skill name to validate.',
			},
		},
		required: ['name'],
	},
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
		}, undefined, toolCatalog());
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
