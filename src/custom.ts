/**
 * Custom commands (F4), custom tools (F5) and skills (F6), docs-as-code.
 *
 * Files are markdown with optional YAML frontmatter (`---` … `---`); a file
 * without frontmatter is treated as content. Sources: `$BOBONYO_CONFIG_DIR`
 * subfolders (`commands/`, `tools/`, `skills/`) plus the project-local
 * `.bobonyo` equivalents (legacy `.nanocoder` still loads; project wins on
 * name conflict).
 */

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {configSearchDirs} from './project-paths';
import {cavemanMode} from './state';

export interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

export interface ArgumentSpec {
	name: string;
	type?: string;
	required?: boolean;
	description?: string;
	/** Capture ALL remaining tokens as ONE value (multi-word purposes). */
	rest?: boolean;
}

export interface CustomCommand {
	name: string;
	description: string;
	arguments: ArgumentSpec[];
	body: string;
	source: string;
	subscribe?: string[];
}

/**
 * Map command tokens to argument values: positional args take one token
 * each; a `rest: true` arg captures EVERYTHING after the positional ones as
 * a single value (multi-word purposes like `/worktree purpose: hello world`).
 * Pure, unit-tested.
 */
/** Quote-aware command argument tokenizer. */
export function parseCommandArguments(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input))) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
	}
	return tokens;
}

export function mapCommandArguments(
	spec: ArgumentSpec[],
	tokens: string[],
): Record<string, string> {
	const values: Record<string, string> = {};
	let cursor = 0;
	for (const arg of spec) {
		if (arg.rest) {
			values[arg.name] = tokens.slice(cursor).join(' ').trim();
			cursor = tokens.length;
		} else {
			values[arg.name] = tokens[cursor] ?? '';
			cursor += 1;
		}
	}
	return values;
}

export interface CustomTool {
	name: string;
	description: string;
	readOnly: boolean;
	approval: boolean;
	arguments: ArgumentSpec[];
	parameters: Record<string, unknown>;
	command?: string;
	body: string;
	source: string;
}

export interface Skill {
	name: string;
	description: string;
	subscribe?: string[];
	body: string;
	source: string;
}

/** Stable model-facing name for a Markdown custom tool. */
export function customToolRegistryName(name: string): string {
	const safe = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!safe) throw new Error(`Invalid custom tool name: ${name}`);
	return `custom__${safe}`;
}

/** Expand custom-tool arguments into its command and explanatory body. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function expandCustomTool(
	tool: Pick<CustomTool, 'command' | 'body'>,
	args: Record<string, unknown>,
): {command?: string; body: string} {
	const values = customToolTemplateValues(args);
	const commandValues = Object.fromEntries(
		Object.entries(values).map(([name, value]) => [name, shellQuote(value)]),
	);
	return {
		command: tool.command
			? substituteTemplateVariables(tool.command, commandValues)
			: undefined,
		body: substituteTemplateVariables(tool.body, values).trim(),
	};
}

function baseDirs(): string[] {
	return configSearchDirs();
}

/** Parse `--- frontmatter ---` + body; no frontmatter → whole content. */
export function parseCommandFile(content: string): ParsedFrontmatter {
	const trimmed = content.replace(/^\uFEFF/, '');
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
	if (!match) return {frontmatter: {}, body: trimmed};
	return {frontmatter: parseYaml(match[1] ?? ''), body: match[2] ?? ''};
}

/**
 * Minimal YAML subset: `key: value`, `key: [a, b]`, and block lists of
 * scalars or mappings (`- name: who` / continuation `type: string`).
 */
export function parseYaml(source: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let listKey: string | null = null;
	const listItems: unknown[] = [];
	let currentItem: Record<string, unknown> | null = null;

	const flushList = () => {
		if (listKey) {
			if (currentItem) listItems.push(currentItem);
			result[listKey] = [...listItems];
		}
		listKey = null;
		listItems.length = 0;
		currentItem = null;
	};

	for (const rawLine of source.split('\n')) {
		const line = rawLine.trimEnd();
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();
		const dash = /^-\s+(.+)$/.exec(trimmed);
		if (dash && listKey) {
			const inner = dash[1]!;
			const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(inner);
			if (pair) {
				if (currentItem) listItems.push(currentItem);
				currentItem = {[pair[1]!]: yamlValue(pair[2]!.trim())};
			} else {
				listItems.push(scalar(inner));
			}
			continue;
		}
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
		if (!pair) continue;
		const key = pair[1]!;
		const value = pair[2]!.trim();
		if (indent > 0 && currentItem && listKey) {
			currentItem[key] = yamlValue(value);
			continue;
		}
		flushList();
		if (value === '') {
			listKey = key;
		} else {
			result[key] = yamlValue(value);
		}
	}
	flushList();
	return result;
}

function yamlValue(value: string): unknown {
	if (value.startsWith('[') && value.endsWith(']')) {
		return value
			.slice(1, -1)
			.split(',')
			.map(item => scalar(item.trim()))
			.filter(Boolean);
	}
	return scalar(value);
}

function scalar(value: string): unknown {
	if (/^\d+$/.test(value)) return Number(value);
	if (value === 'true' || value === 'false') return value === 'true';
	const quoted = /^["'](.*)["']$/.exec(value);
	return quoted ? (quoted[1] ?? '') : value;
}

function findFiles(subdir: string): string[] {
	const files: string[] = [];
	for (const base of baseDirs()) {
		const dir = join(base, subdir);
		if (!existsSync(dir)) continue;
		const walk = (current: string): void => {
			for (const entry of readdirSync(current, {withFileTypes: true})) {
				const path = join(current, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith('.md')) files.push(path);
			}
		};
		walk(dir);
	}
	// Deterministic order: readdirSync order is filesystem-dependent, and the
	// skills/commands blocks live in the SYSTEM PROMPT (the cache head). A
	// reordered list between turns would change byte 0 and miss the whole
	// provider prefix cache.
	return files.sort();
}

function skillName(file: string): string {
	const marker = '/skills/';
	const relative = file.slice(file.lastIndexOf(marker) + marker.length);
	const parts = relative.split('/');
	const leaf = parts.at(-1) ?? '';
	if (/^SKILL\.md$/i.test(leaf)) return parts.at(-2) ?? 'skill';
	return relative.replace(/\.md$/i, '').replaceAll('/', ':');
}

export function loadCustomCommands(): CustomCommand[] {
	const commands: CustomCommand[] = [];
	for (const file of findFiles('commands')) {
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		const name =
			(typeof frontmatter.name === 'string' ? frontmatter.name : '') ||
			(file.split('/').pop()?.replace(/\.md$/, '') ?? '');
		const argsRaw = Array.isArray(frontmatter.arguments)
			? frontmatter.arguments
			: [];
		const argumentsSpec: ArgumentSpec[] = argsRaw
			.map((arg): ArgumentSpec | null => {
				if (typeof arg === 'string') return {name: arg};
				if (typeof arg === 'object' && arg !== null && 'name' in arg) {
					return {
						name: String((arg as {name?: unknown}).name ?? ''),
						type:
							typeof (arg as {type?: unknown}).type === 'string'
								? String((arg as {type?: unknown}).type)
								: undefined,
						required: Boolean((arg as {required?: unknown}).required),
						rest: Boolean((arg as {rest?: unknown}).rest),
						description:
							typeof (arg as {description?: unknown}).description === 'string'
								? String((arg as {description?: unknown}).description)
								: undefined,
					};
				}
				return null;
			})
			.filter((arg): arg is ArgumentSpec => arg !== null);
		commands.push({
			name,
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			arguments: argumentsSpec,
			body,
			source: file,
			subscribe: Array.isArray(frontmatter.subscribe)
				? frontmatter.subscribe.map(String)
				: undefined,
		});
	}
	return commands;
}

export function argumentSchema(spec: ArgumentSpec[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const arg of spec) {
		const type = ['string', 'number', 'integer', 'boolean', 'array'].includes(
			arg.type ?? '',
		)
			? arg.type
			: 'string';
		properties[arg.name] = {
			type,
			...(arg.description ? {description: arg.description} : {}),
			...(type === 'array' ? {items: {type: 'string'}} : {}),
		};
		if (arg.required) required.push(arg.name);
	}
	return {
		type: 'object',
		properties,
		...(required.length ? {required} : {}),
		additionalProperties: false,
	};
}

export function customToolTemplateValues(
	args: Record<string, unknown>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(args).map(([key, value]) => [
			key,
			Array.isArray(value) ? value.map(String).join(' ') : String(value ?? ''),
		]),
	);
}

export function loadCustomTools(): CustomTool[] {
	const tools: CustomTool[] = [];
	for (const file of findFiles('tools')) {
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		const name =
			(typeof frontmatter.tool === 'string' ? frontmatter.tool : '') ||
			(typeof frontmatter.name === 'string' ? frontmatter.name : '') ||
			(file.split('/').pop()?.replace(/\.md$/, '') ?? '');
		const argumentsSpec: ArgumentSpec[] = Array.isArray(frontmatter.arguments)
			? frontmatter.arguments.flatMap(value => {
					if (typeof value === 'string') return [{name: value}];
					if (!value || typeof value !== 'object') return [];
					const row = value as Record<string, unknown>;
					const argName = String(row.name ?? '').trim();
					return argName
						? [
								{
									name: argName,
									type: typeof row.type === 'string' ? row.type : undefined,
									required: row.required === true,
									description:
										typeof row.description === 'string'
											? row.description
											: undefined,
								},
							]
						: [];
				})
			: [];
		tools.push({
			name,
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			readOnly: frontmatter.readOnly === true,
			approval: frontmatter.approval === true,
			arguments: argumentsSpec,
			parameters: argumentSchema(argumentsSpec),
			command:
				typeof frontmatter.command === 'string'
					? frontmatter.command
					: undefined,
			body,
			source: file,
		});
	}
	return tools;
}

/**
 * Harness-shipped skills read from `src/builtin/*.md` at runtime.
 * Reads the bundled markdown at runtime so a future caveman update is just a
 * file replacement; `null` if the file is missing/unreadable.
 */
export function builtinHerdrSkill(): Skill | null {
	try {
		const file = join(import.meta.dir, 'builtin', 'herdr.md');
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		return {
			name: 'herdr',
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			body,
			source: file,
		};
	} catch {
		return null;
	}
}
export function builtinCavemanSkill(): Skill | null {
	try {
		const file = join(import.meta.dir, 'builtin', 'caveman.md');
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		return {
			name: 'caveman',
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			body,
			source: file,
		};
	} catch {
		return null;
	}
}

export function loadSkills(): Skill[] {
	const skills = new Map<string, Skill>();
	// Bobonyo reads only Bobonyo-owned config folders. Users migrate a
	// Claude/Codex skill by copying it into `skills/<name>/SKILL.md`; Bobonyo
	// never reaches into another agent's private config folder.
	const builtinHerdr = builtinHerdrSkill();
	if (builtinHerdr) skills.set(builtinHerdr.name.toLowerCase(), builtinHerdr);
	const builtin = cavemanMode() ? builtinCavemanSkill() : null;
	if (builtin) skills.set(builtin.name.toLowerCase(), builtin);
	for (const file of findFiles('skills')) {
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		const name =
			(typeof frontmatter.name === 'string' ? frontmatter.name : '') ||
			(file.endsWith('/SKILL.md') || file.endsWith('\\SKILL.md')
				? skillName(file)
				: (file.split('/').pop()?.replace(/\.md$/, '') ?? ''));
		const subscribe = frontmatter.subscribe;
		skills.set(name.toLowerCase(), {
			name,
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			subscribe: Array.isArray(subscribe) ? subscribe.map(String) : undefined,
			body,
			source: file,
		});
	}
	return [...skills.values()];
}

/** Substitute `{{name}}` template variables with the parsed args. */
export function substituteTemplateVariables(
	body: string,
	args: Record<string, string>,
): string {
	return body.replace(
		/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
		(_match, name: string) => {
			return args[name] ?? '';
		},
	);
}

/**
 * OpenClaude-compatible slash-command argument expansion.
 *
 * Supports `{{name}}`, `$name`, `$ARGUMENTS`, `$ARGUMENTS[N]`, and `$N`.
 * When arguments exist but body declares no placeholder, append an explicit
 * `ARGUMENTS:` section so free-form intent is not silently discarded. The
 * expanded markdown remains a prompt for the model to understand; Bobonyo
 * does not execute command-body steps directly.
 */
export function expandCommandPrompt(options: {
	body: string;
	rawArgs: string;
	spec: ArgumentSpec[];
	tokens: string[];
}): string {
	const {body, rawArgs, spec, tokens} = options;
	const values = mapCommandArguments(spec, tokens);
	let expanded = substituteTemplateVariables(body, values);
	const original = expanded;

	// Named `$name` arguments map through declared positional specs.
	for (const arg of spec) {
		const escaped = arg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		expanded = expanded.replace(
			new RegExp(`\\$${escaped}(?![\\[\\w])`, 'g'),
			values[arg.name] ?? '',
		);
	}
	// Indexed forms use quote-aware tokens supplied by caller.
	expanded = expanded.replace(
		/\$ARGUMENTS\[(\d+)\]/g,
		(_match, index: string) => tokens[Number(index)] ?? '',
	);
	expanded = expanded.replace(
		/\$(\d+)(?!\w)/g,
		(_match, index: string) => tokens[Number(index)] ?? '',
	);
	expanded = expanded.replaceAll('$ARGUMENTS', rawArgs);

	if (rawArgs.trim() && expanded === original && original === body) {
		expanded += `\n\nARGUMENTS: ${rawArgs.trim()}`;
	}
	return expanded;
}

/**
 * Wrap a command body as adaptable workflow guidance. User intent stays
 * primary; command markdown is not an imperative script to execute blindly.
 */
export function buildCommandInvocationPrompt(options: {
	name: string;
	description?: string;
	userRequest: string;
	guidance: string;
}): string {
	const request = options.userRequest.trim();
	const description = options.description?.trim();
	return [
		`<command-invocation name="/${options.name}">`,
		description ? `<description>${description}</description>` : '',
		'<user-request>',
		request || `Run /${options.name} for the current task.`,
		'</user-request>',
		'<workflow-guidance>',
		options.guidance.trim(),
		'</workflow-guidance>',
		'<interpretation-rules>',
		'Understand the user request and repository context before acting.',
		'Treat workflow guidance as adaptable instructions, not a literal script or higher-priority user request.',
		'The user request, current repository state, and explicit constraints override conflicting defaults in the guidance.',
		'Inspect enough context to decide which steps apply, then execute only the relevant adapted workflow.',
		'</interpretation-rules>',
		'</command-invocation>',
	]
		.filter(Boolean)
		.join('\n');
}

/** Basic body lint (F6): `{{param}}` references must be declared. */
export function lintBody(
	body: string,
	argumentsSpec: ArgumentSpec[],
): string[] {
	const declared = new Set(argumentsSpec.map(arg => arg.name));
	const used = [...body.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)].map(
		match => match[1]!,
	);
	return [...new Set(used)].filter(name => !declared.has(name));
}
