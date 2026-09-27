import type {MockToolCall} from './client';

/** Display names used by tool rows; unlisted tool names remain unchanged. */
const CLAUDE_CODE_NAMES: Record<string, string> = {
	execute_bash: 'Bash',
	'execute_bash:user': 'Executed Bash',
	read_file: 'Read',
	write_file: 'Write',
	edit_file: 'Edit',
	string_replace: 'Edit',
	diff_edit: 'Edit',
	apply_patch: 'ApplyPatch',
	delete_file: 'Delete',
	glob: 'Glob',
	grep: 'Grep',
	web_search: 'WebSearch',
	fetch_url: 'WebFetch',
	agent: 'agent',
	agent_message: 'AgentMessage',
	agent_status: 'AgentStatus',
	agent_history: 'AgentHistory',
	agent_wait: 'AgentWait',
	agent_cancel: 'AgentCancel',
	question: 'Question',
	request_permissions: 'RequestPermissions',
	process_start: 'ProcessStart',
	process_input: 'ProcessInput',
	process_status: 'ProcessStatus',
	process_stop: 'ProcessStop',
	service_check: 'ServiceCheck',
	service_start: 'ServiceStart',
	service_status: 'ServiceStatus',
	service_logs: 'ServiceLogs',
	service_restart: 'ServiceRestart',
	service_stop: 'ServiceStop',
	lsp: 'LSP',
	enter_worktree: 'EnterWorktree',
	exit_worktree: 'ExitWorktree',
	list_worktrees: 'ListWorktrees',
	remove_worktree: 'RemoveWorktree',
	skill: 'Skill',
	command: 'Command',
	check_skill: 'Skill',
	write_tasks: 'Tasks',
	task_create: 'TaskCreate',
	task_list: 'TaskList',
	task_get: 'TaskGet',
	task_update: 'TaskUpdate',
};

export function displayToolName(name: string): string {
	return CLAUDE_CODE_NAMES[name] ?? name;
}

const CANONICAL_BY_ALIAS: Record<string, string> = Object.fromEntries(
	Object.entries(CLAUDE_CODE_NAMES).map(([canonical, alias]) => [
		alias,
		canonical,
	]),
);

export function resolveToolName(name: string): string {
	return CANONICAL_BY_ALIAS[name] ?? name;
}

const FILE_WRITE_TOOLS = new Set([
	'write_file',
	'edit_file',
	'string_replace',
	'diff_edit',
	'apply_patch',
]);

export function isFileWriteTool(name: string): boolean {
	return FILE_WRITE_TOOLS.has(name);
}

export function toolArgsSummary(call: MockToolCall): string {
	const args = call.arguments;
	const order =
		call.name === 'skill'
			? ['name', 'path', 'description']
			: [
					'command',
					'path',
					'pattern',
					'query',
					'element',
					'target',
					'url',
					'name',
					'description',
				];
	for (const key of order) {
		const value = args?.[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

export function toolDisplayDetail(call: MockToolCall): string {
	if (call.name === 'agent') {
		const type = String(call.arguments.subagent_type ?? 'general');
		const task = toolArgsSummary(call);
		return `agent:${type}${task ? `(${task})` : ''}`;
	}
	if (call.name.startsWith('agent_')) {
		return String(call.arguments.agent_id ?? toolArgsSummary(call));
	}
	if (call.name === 'lsp') {
		return [call.arguments.operation, call.arguments.query]
			.filter(value => typeof value === 'string' && value)
			.join(' ');
	}
	return toolArgsSummary(call);
}

export function toolResultTail(
	content: string,
	maxLines = 3,
	maxWidth = 100,
): string {
	return content
		.split('\n')
		.slice(0, maxLines)
		.map(line =>
			line.length > maxWidth ? `${line.slice(0, maxWidth)}…` : line,
		)
		.join('\n');
}
