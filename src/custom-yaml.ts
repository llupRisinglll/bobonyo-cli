export interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
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
