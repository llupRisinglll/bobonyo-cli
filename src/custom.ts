/**
 * Custom commands (F4), custom tools (F5) and skills (F6), docs-as-code.
 *
 * Files are markdown with optional YAML frontmatter (`---` … `---`); a file
 * without frontmatter is treated as content. Sources: `$NANOCODER_CONFIG_DIR`
 * subfolders (`commands/`, `tools/`, `skills/`) plus the project-local
 * `.nanocoder` equivalents (project wins on name conflict).
 */

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
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

function baseDirs(): string[] {
	const dirs: string[] = [];
	const configBase =
		process.env.NANOCODER_CONFIG_DIR ??
		join(homedir(), '.local', 'share', 'bobonyo');
	dirs.push(join(configBase));
	dirs.push(join(process.cwd(), '.nanocoder'));
	return dirs;
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
		for (const file of readdirSync(dir)) {
			if (!file.endsWith('.md')) continue;
			files.push(join(dir, file));
		}
	}
	return files;
}

export function loadCustomCommands(): CustomCommand[] {
	const commands: CustomCommand[] = [];
	for (const file of findFiles('commands')) {
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		const name = (
			(typeof frontmatter.name === 'string' ? frontmatter.name : '') ||
			(file.split('/').pop()?.replace(/\.md$/, '') ?? '')
		);
		const argsRaw = Array.isArray(frontmatter.arguments) ? frontmatter.arguments : [];
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

export function loadCustomTools(): CustomTool[] {
	const tools: CustomTool[] = [];
	for (const file of findFiles('tools')) {
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		const name = (
			(typeof frontmatter.tool === 'string' ? frontmatter.tool : '') ||
			(typeof frontmatter.name === 'string' ? frontmatter.name : '') ||
			(file.split('/').pop()?.replace(/\.md$/, '') ?? '')
		);
		tools.push({
			name,
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			readOnly: frontmatter.readOnly === true,
			approval: frontmatter.approval === true,
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
 * The harness-shipped caveman skill (see `src/builtin/caveman.md`).
 * Reads the bundled markdown at runtime so a future caveman update is just a
 * file replacement; `null` if the file is missing/unreadable.
 */
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
	const skills: Skill[] = [];
	// Caveman is bundled with the harness and ON by default; the settings
	// toggle gates it. A project/global `caveman.md` wins over the built-in
	// on name conflict (project wins, same as command/skill layering).
	const builtin = cavemanMode() ? builtinCavemanSkill() : null;
	if (builtin) skills.push(builtin);
	for (const file of findFiles('skills')) {
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		const name = (
			(typeof frontmatter.name === 'string' ? frontmatter.name : '') ||
			(file.split('/').pop()?.replace(/\.md$/, '') ?? '')
		);
		if (builtin && name === 'caveman') {
			const builtinIndex = skills.indexOf(builtin);
			if (builtinIndex >= 0) skills.splice(builtinIndex, 1);
		}
		const subscribe = frontmatter.subscribe;
		skills.push({
			name,
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			subscribe: Array.isArray(subscribe)
				? subscribe.map(String)
				: undefined,
			body,
			source: file,
		});
	}
	return skills;
}

/** Substitute `{{name}}` template variables with the parsed args. */
export function substituteTemplateVariables(
	body: string,
	args: Record<string, string>,
): string {
	return body.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, name: string) => {
		return args[name] ?? '';
	});
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
