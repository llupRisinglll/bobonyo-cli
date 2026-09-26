import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bobonyoConfigDir} from './bobonyo-paths';

export interface PluginMarketplace {
	name: string;
	repository: string;
	addedAt: number;
}

function pluginDir(): string {
	return join(bobonyoConfigDir(), 'plugins');
}

function marketplacePath(): string {
	return join(pluginDir(), 'marketplaces.json');
}

function parseRepository(value: string): {owner: string; repo: string} | null {
	const match =
		/^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
			value.trim(),
		);
	return match ? {owner: match[1]!, repo: match[2]!} : null;
}

function saveMarketplaces(items: PluginMarketplace[]): void {
	mkdirSync(pluginDir(), {recursive: true});
	writeFileSync(
		marketplacePath(),
		`${JSON.stringify(items, null, 2)}\n`,
		'utf8',
	);
}

export function listPluginMarketplaces(): PluginMarketplace[] {
	try {
		return JSON.parse(
			readFileSync(marketplacePath(), 'utf8'),
		) as PluginMarketplace[];
	} catch {
		return [];
	}
}

export function addPluginMarketplace(repository: string): PluginMarketplace {
	const parsed = parseRepository(repository);
	if (!parsed)
		throw new Error(
			'Expected a GitHub repository like DietrichGebert/ponytail.',
		);
	const item = {
		name: parsed.repo,
		repository: `${parsed.owner}/${parsed.repo}`,
		addedAt: Date.now(),
	};
	const items = listPluginMarketplaces().filter(
		entry => entry.repository.toLowerCase() !== item.repository.toLowerCase(),
	);
	saveMarketplaces([...items, item]);
	return item;
}

export async function installPlugin(spec: string): Promise<string[]> {
	const match = /^([^@\s]+)@([^@\s]+)$/.exec(spec.trim());
	if (!match) throw new Error('Expected plugin spec like ponytail@ponytail.');
	const pluginName = match[1]!;
	const marketplaceName = match[2]!;
	const marketplace = listPluginMarketplaces().find(
		entry => entry.name.toLowerCase() === marketplaceName.toLowerCase(),
	);
	if (!marketplace)
		throw new Error(`Marketplace '${marketplaceName}' is not registered.`);
	const response = await fetch(
		`https://api.github.com/repos/${marketplace.repository}/contents/skills`,
		{headers: {accept: 'application/vnd.github+json', 'user-agent': 'bobonyo'}},
	);
	if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
	const entries = (await response.json()) as Array<{
		name: string;
		type: string;
		download_url?: string;
	}>;
	const installed: string[] = [];
	for (const entry of entries) {
		if (entry.type !== 'dir' || entry.name !== pluginName) continue;
		const fileResponse = await fetch(
			`https://raw.githubusercontent.com/${marketplace.repository}/main/skills/${entry.name}/SKILL.md`,
			{headers: {'user-agent': 'bobonyo'}},
		);
		if (!fileResponse.ok)
			throw new Error(`Could not download ${entry.name}/SKILL.md.`);
		const target = join(bobonyoConfigDir(), 'skills', entry.name, 'SKILL.md');
		mkdirSync(join(target, '..'), {recursive: true});
		writeFileSync(target, await fileResponse.text(), 'utf8');
		installed.push(entry.name);
	}
	if (!installed.length)
		throw new Error(
			`Plugin '${pluginName}' not found in ${marketplace.repository}.`,
		);
	return installed;
}
