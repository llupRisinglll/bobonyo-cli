/**
 * Subagent discovery (parity: nanocoder's `subagents/subagent-loader.ts`).
 *
 * Agents are markdown files with YAML frontmatter (`name`, `description`,
 * optional `model` / `tools`), the body being the agent's system prompt.
 * Sources, lowest to highest priority:
 *   1. built-ins (General / Explore, from the tool registry)
 *   2. user level: `$BOBONYO_CONFIG_DIR/agents/*.md`
 *   3. project level: `.bobonyo/agents/*.md` (legacy `.nanocoder` too)
 * Project wins on name conflict. The discovered set is what the agents
 * modal lists and the `agent` tool can delegate to.
 */

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {bobonyoConfigDir} from './bobonyo-paths';
import {parseCommandFile} from './custom';

export interface Subagent {
	name: string;
	title?: string;
	description: string;
	/** Model override; 'inherit' (default) uses the parent's model. */
	model?: string;
	tools?: string[];
	disallowedTools?: string[];
	systemPrompt: string;
	source: 'built-in' | 'user' | 'project';
}

function subagentDirs(): Array<{dir: string; source: Subagent['source']}> {
	const configBase =
		process.env.BOBONYO_CONFIG_DIR ??
		process.env.NANOCODER_CONFIG_DIR ??
		bobonyoConfigDir();
	// Exactly TWO dirs (the loader reads [0] and [1]): project agents live in
	// `.bobonyo/agents`, falling back to the legacy `.nanocoder/agents`.
	const projectDir = existsSync(join(process.cwd(), '.bobonyo', 'agents'))
		? join(process.cwd(), '.bobonyo', 'agents')
		: join(process.cwd(), '.nanocoder', 'agents');
	return [
		{dir: join(configBase, 'agents'), source: 'user'},
		{dir: projectDir, source: 'project'},
	];
}

function loadFromDir(
	dir: string,
	source: Subagent['source'],
): Subagent[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter(file => file.endsWith('.md'))
			.map(file => {
				const path = join(dir, file);
				const parsed = parseCommandFile(readFileSync(path, 'utf8'));
				const fm = parsed.frontmatter;
				const name = String(fm.name ?? '').trim();
				if (!name) return undefined;
				const description = String(fm.description ?? '').trim();
				const tools = Array.isArray(fm.tools)
					? fm.tools.map(tool => String(tool))
					: undefined;
				const disallowedTools = Array.isArray(fm.disallowedTools)
					? fm.disallowedTools.map(tool => String(tool))
					: undefined;
				return {
					name,
					...(fm.title ? {title: String(fm.title)} : {}),
					description,
					...(fm.model ? {model: String(fm.model)} : {}),
					...(tools ? {tools} : {}),
					...(disallowedTools ? {disallowedTools} : {}),
					systemPrompt: parsed.body.trim(),
					source,
				} satisfies Subagent;
			})
			.filter((agent): agent is Subagent => Boolean(agent));
	} catch {
		return [];
	}
}

/**
 * All discoverable subagents: project overrides user overrides built-ins on
 * name. Reads the filesystem on every call (cheap: a handful of markdown
 * reads) so the modal and the `agent` tool always see fresh configs.
 */
export function loadSubagents(): Subagent[] {
	const byName = new Map<string, Subagent>();
	for (const agent of loadFromDir(
		subagentDirs()[0]!.dir,
		subagentDirs()[0]!.source,
	)) {
		byName.set(agent.name.toLowerCase(), agent);
	}
	for (const agent of loadFromDir(
		subagentDirs()[1]!.dir,
		subagentDirs()[1]!.source,
	)) {
		byName.set(agent.name.toLowerCase(), agent);
	}
	return [...byName.values()];
}

/**
 * Resolve the system prompt for a delegated subagent: a discovered file's
 * body wins; an empty string means "no file agent" so the caller falls back
 * to the built-in personalities (General / Explore).
 */
export function subagentSystemPrompt(name: string): string {
	const agent = loadSubagents().find(
		candidate => candidate.name.toLowerCase() === name.toLowerCase(),
	);
	return agent?.systemPrompt ?? '';
}

export function subagentModel(name: string): string | undefined {
	const agent = loadSubagents().find(
		candidate => candidate.name.toLowerCase() === name.toLowerCase(),
	);
	return agent?.model && agent.model !== 'inherit' ? agent.model : undefined;
}
