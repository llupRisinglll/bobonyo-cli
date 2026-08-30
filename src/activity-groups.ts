export interface ActivityCall {
	name: string;
	detail: string;
}

export interface ActivityMessage {
	tool?: ActivityCall;
}

export interface ActivityGroup {
	key: string;
	title: string;
}

const EXPLORATION_TOOLS = new Set(['read_file', 'glob', 'grep', 'lsp']);
const WEB_TOOLS = new Set(['web_search', 'fetch_url']);

export function mcpServerTitle(serverId: string): string {
	const words = serverId
		.replace(/(?:^|_)mcp$/i, '')
		.split('_')
		.filter(Boolean)
		.map(word => word[0]?.toUpperCase() + word.slice(1));
	return `${words.join(' ') || 'MCP'}${words.length ? ' MCP' : ''}`;
}

/** Only these tool families get Codex-style chronological activity trees. */
export function activityGroupForTool(name: string): ActivityGroup | null {
	if (EXPLORATION_TOOLS.has(name)) return {key: 'explore', title: 'Explored'};
	if (WEB_TOOLS.has(name)) return {key: 'web', title: 'Navigated Web'};
	const mcp = /^mcp__([^_].*?)__/.exec(name);
	if (mcp) {
		return {key: `mcp:${mcp[1]}`, title: mcpServerTitle(mcp[1] ?? '')};
	}
	return null;
}

function actionName(name: string): string {
	const known: Record<string, string> = {
		read_file: 'Read',
		glob: 'Glob',
		grep: 'Search',
		lsp: 'LSP',
		web_search: 'WebSearch',
		fetch_url: 'WebFetch',
	};
	if (known[name]) return known[name]!;
	const mcpTool = /^mcp__[^_].*?__(.+)$/.exec(name)?.[1] ?? name;
	return mcpTool.replace(/^browser_/, '').replaceAll('_', ' ');
}

export function activityCallLabel(call: ActivityCall): string {
	const action = actionName(call.name);
	if (!call.detail) return action;
	if (call.name === 'web_search') return `${action} "${call.detail}"`;
	if (call.name.startsWith('mcp__')) return `${action}(${call.detail})`;
	return `${action} ${call.detail}`;
}

function wrapActivityLabel(label: string, width: number): string[] {
	const max = Math.max(12, width - 6);
	const words = label.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if (!current) current = word;
		else if (current.length + 1 + word.length <= max) current += ` ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines.length ? lines : [''];
}

/**
 * Format one activity tree. Intermediate calls use `├`; final call uses `└`.
 * Wrapped intermediate details retain `│`, making chronology visually joined.
 */
export function formatActivityTree(
	group: ActivityGroup,
	calls: ActivityCall[],
	width = 84,
): string {
	const rows = calls.flatMap((call, index) => {
		const final = index === calls.length - 1;
		const wrapped = wrapActivityLabel(activityCallLabel(call), width);
		return wrapped.map((line, lineIndex) => {
			if (lineIndex === 0) return `  ${final ? '└' : '├'} ${line}`;
			return `  ${final ? ' ' : '│'}   ${line}`;
		});
	});
	return `✦ ${group.title}${rows.length ? `\n${rows.join('\n')}` : ''}`;
}

export function formatActivityMessages(
	group: ActivityGroup,
	messages: ActivityMessage[],
	width = 84,
): string {
	return formatActivityTree(
		group,
		messages.flatMap(message => (message.tool ? [message.tool] : [])),
		width,
	);
}
