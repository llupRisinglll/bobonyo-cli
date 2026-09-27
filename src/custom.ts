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
import {parseCommandFile} from './custom-yaml';
import {
	mapCommandArguments,
	parseArgumentSpecs,
	type ArgumentSpec,
	type CustomCommand,
} from './custom-args';
import {substituteTemplateVariables} from './custom-prompts';
export {parseCommandFile, parseYaml} from './custom-yaml';
export type {ParsedFrontmatter} from './custom-yaml';
export {
	builtinCavemanSkill,
	builtinHerdrSkill,
	loadSkills,
} from './custom-skills';
export type {Skill} from './custom-skills';

export {
	parseCommandArguments,
	mapCommandArguments,
	parseArgumentSpecs,
} from './custom-args';
export type {ArgumentSpec, CustomCommand} from './custom-args';
export {
	substituteTemplateVariables,
	expandCommandPrompt,
	buildCommandInvocationPrompt,
} from './custom-prompts';
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
			argumentHint:
				typeof frontmatter['argument-hint'] === 'string'
					? frontmatter['argument-hint']
					: undefined,
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
