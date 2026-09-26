export interface ActivityCall {
	name: string;
	detail: string;
	args?: Record<string, unknown>;
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

const SKILL_TOOLS = new Set(['skill']);

/**
 * Display classification, not a shell security boundary. Only literal search
 * commands and search-only pipelines/chains qualify. Unknown syntax stays Bash.
 * custom.parseCommandArguments is a slash-argument tokenizer: it loses shell
 * operators and accepts incomplete quotes, so it cannot serve here.
 */
export function isExplorationCommand(command: unknown): boolean {
	if (typeof command !== 'string' || !command.trim()) return false;
	const commands: string[][] = [[]];
	let word = '';
	let started = false;
	let quote = '';
	const flush = () => {
		if (started) commands.at(-1)!.push(word);
		word = '';
		started = false;
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		// Quoted expansions are also deliberately outside this small grammar.
		if ('$`\n\r'.includes(char)) return false;
		if (char === '\\' && quote !== "'") {
			const next = command[++i];
			if (!next || '$`\n\r'.includes(next)) return false;
			if (quote === '"' && !'"\\'.includes(next)) word += '\\';
			word += next;
			started = true;
		} else if (quote) {
			if (char === quote) quote = '';
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if ('<>()[{}#!~*?'.includes(char)) return false;
		else if ('|;&'.includes(char)) {
			flush();
			if (!commands.at(-1)!.length) return false;
			if (char === '&' && command[++i] !== '&') return false;
			if (char === '|' && command[i + 1] === '|') i++;
			commands.push([]);
		} else if (/\s/.test(char)) flush();
		else {
			word += char;
			started = true;
		}
	}
	if (quote) return false;
	flush();
	return commands.every(([name, ...args]) => {
		if (!name || !['find', 'grep', 'rg'].includes(name)) return false;
		return args.every(arg => {
			if (!arg.startsWith('-')) return true;
			if (name === 'find')
				return /^-(?:H|L|P|O[0-3]|name|iname|path|ipath|regex|iregex|type|xtype|size|mtime|mmin|atime|amin|ctime|cmin|newer|newermt|user|group|uid|gid|perm|links|inum|samefile|empty|readable|writable|executable|mindepth|maxdepth|mount|xdev|depth|follow|ignore_readdir_race|noleaf|regextype|true|false|not|a|and|o|or|print|print0|printf|ls|prune|quit)$/.test(
					arg,
				);
			// rg --pre/--pre-glob/--hostname-bin can execute programs.
			return (
				arg === '--' ||
				/^-[nirlLoOhHvVcsqwaAbBFPEzuxyUSN0123456789]+$/.test(arg) ||
				/^-(?:e|f|g|t|T|m|A|B|C)$/.test(arg) ||
				/^--(?:files|hidden|no-ignore|no-ignore-vcs|line-number|files-with-matches|files-without-match|count|count-matches|ignore-case|smart-case|fixed-strings|word-regexp|line-regexp|invert-match|only-matching|with-filename|no-filename|null|null-data|text|quiet|recursive|follow|no-messages|pcre2|multiline|stats|json|help|version|regexp|file|glob|iglob|type|type-not|max-count|max-depth|context|before-context|after-context|color|colors|sort|sortr|encoding|include|exclude|exclude-dir)(?:=.*)?$/.test(
					arg,
				)
			);
		});
	});
}

export function mcpServerTitle(serverId: string): string {
	const words = serverId
		.replace(/(?:^|_)mcp$/i, '')
		.split('_')
		.filter(Boolean)
		.map(word => word[0]?.toUpperCase() + word.slice(1));
	return `${words.join(' ') || 'MCP'}${words.length ? ' MCP' : ''}`;
}

/** Only these tool families get Codex-style chronological activity trees. */
export function activityGroupForTool(
	name: string,
	args?: Record<string, unknown>,
): ActivityGroup | null {
	if (name === 'execute_bash' && isExplorationCommand(args?.command))
		return {key: 'explore', title: 'Explored'};
	if (SKILL_TOOLS.has(name)) return {key: 'skills', title: 'Skills triggered'};
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
		skill: '',
		read_file: 'Read',
		glob: 'Glob',
		grep: 'Search',
		execute_bash: 'Search',
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
	if (call.name === 'execute_bash' && typeof call.args?.command === 'string')
		return `${action} ${call.args.command}`;
	if (!call.detail) return action;
	if (call.name === 'skill') return call.detail;
	if (call.name === 'web_search') return `${action} "${call.detail}"`;
	if (call.name.startsWith('mcp__')) return `${action}(${call.detail})`;
	return `${action} ${call.detail}`;
}

function wrapActivityLabel(label: string, width: number): string[] {
	// Group rows render inside transcript chrome and a code cell. Leave enough
	// room for both layers so OpenTUI does not wrap our already-indented path
	// again at a different column.
	const max = Math.max(12, width - 10);
	const words = label.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if (word.length > max) {
			if (current) {
				lines.push(current);
				current = '';
			}
			for (let offset = 0; offset < word.length; offset += max) {
				const part = word.slice(offset, offset + max);
				if (part.length === max || offset + max < word.length) {
					lines.push(part);
				} else {
					current = part;
				}
			}
		} else if (!current) current = word;
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
			return `  │   ${line}`;
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
