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

import {existsSync, readdirSync, readFileSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {configSearchDirs} from './project-paths';
import {parseCommandFile} from './custom';
import {listProviders, loadPreferences, savePreferences} from './config';

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
	path: string;
}

function subagentDirs(): Array<{dir: string; source: Subagent['source']}> {
	const dirs = configSearchDirs();
	return [
		{dir: join(dirs[0]!, 'agents'), source: 'user'},
		...dirs
			.slice(1)
			.map(dir => ({dir: join(dir, 'agents'), source: 'project' as const})),
	];
}

function loadFromDir(dir: string, source: Subagent['source']): Subagent[] {
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
					path,
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
	for (const entry of subagentDirs().slice(1)) {
		for (const agent of loadFromDir(entry.dir, entry.source)) {
			byName.set(agent.name.toLowerCase(), agent);
		}
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
	const override = loadPreferences().agentModels?.[name.toLowerCase()];
	if (override === 'inherit') return undefined;
	if (override) return override;
	const agent = loadSubagents().find(
		candidate => candidate.name.toLowerCase() === name.toLowerCase(),
	);
	return agent?.model && agent.model !== 'inherit' ? agent.model : undefined;
}

export interface SubagentEndpoint {
	id: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	sdkProvider?: string;
	codexAccount?: boolean;
	providerOptions?: Record<string, unknown>;
	promptCacheKey?: boolean;
}

/** Resolve full provider endpoint chosen through shared model modal. */
export function subagentEndpoint(
	name: string,
): string | SubagentEndpoint | undefined {
	const key = name.toLowerCase();
	const prefs = loadPreferences();
	const model = subagentModel(name);
	if (!model) return undefined;
	const providerId = prefs.agentProviders?.[key];
	if (!providerId) return model;
	const provider = listProviders().find(
		candidate => candidate.id.toLowerCase() === providerId.toLowerCase(),
	);
	if (!provider) return model;
	return {
		id: provider.id,
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKeyResolved,
		model,
		sdkProvider: provider.sdkProvider,
		codexAccount: provider.codexAccount,
		providerOptions: provider.providerOptions,
		promptCacheKey: provider.promptCacheKey,
	};
}

/** Persist model/provider choice without rewriting agent markdown. */
export function saveSubagentModel(
	name: string,
	model?: string,
	providerId?: string,
): void {
	const prefs = loadPreferences();
	const agentModels = {...(prefs.agentModels ?? {})};
	const agentProviders = {...(prefs.agentProviders ?? {})};
	const key = name.toLowerCase();
	agentModels[key] = model || 'inherit';
	if (providerId && model) agentProviders[key] = providerId;
	else delete agentProviders[key];
	savePreferences({...prefs, agentModels, agentProviders});
}

/** Delete a discovered custom agent. Built-ins have no file and cannot be deleted. */
export function deleteSubagent(name: string): boolean {
	const agent = loadSubagents().find(
		candidate => candidate.name.toLowerCase() === name.toLowerCase(),
	);
	if (!agent?.path) return false;
	unlinkSync(agent.path);
	const prefs = loadPreferences();
	const agentModels = {...(prefs.agentModels ?? {})};
	const agentProviders = {...(prefs.agentProviders ?? {})};
	delete agentModels[name.toLowerCase()];
	delete agentProviders[name.toLowerCase()];
	savePreferences({...prefs, agentModels, agentProviders});
	return true;
}
