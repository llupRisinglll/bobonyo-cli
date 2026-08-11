import type {StatusRow} from './components/status-modal';

/** All runtime state the `/status` modal surfaces (pure, unit-tested). */
export interface StatusData {
	sessionLabel: string;
	provider: string;
	messagesLabel: string;
	checkpoints: number;
	skills: number;
	customCommands: number;
	mcpServers: string[];
	mcpConfigured: string[];
	lspLabel: string;
	/** Resolved AGENTS.md path actually embedded in the system prompt. */
	rulesFile: string;
	steeringLabel: string;
	watchdogLabel: string;
	streamGuardLabel: string;
	version: string;
}

/** Build the `/status` modal rows from live app state. */
export function buildStatusRows(data: StatusData): StatusRow[] {
	return [
		{label: 'Session', value: data.sessionLabel},
		{label: 'Provider', value: data.provider},
		{label: 'Messages', value: data.messagesLabel},
		{label: 'Checkpoints', value: String(data.checkpoints)},
		{label: 'Skills', value: `${data.skills} loaded`},
		{label: 'Custom commands', value: `${data.customCommands} loaded`},
		{
			label: 'MCP servers',
			value:
				data.mcpServers.length === 0
					? data.mcpConfigured.length === 0
						? 'none configured'
						: `${data.mcpConfigured.join(', ')} (connecting…)`
					: data.mcpServers.join(', '),
			valueFg:
				data.mcpServers.length > 0
					? 'success'
					: data.mcpConfigured.length > 0
						? 'warning'
						: undefined,
		},
		{
			label: 'LSP',
			value: data.lspLabel,
			// GREEN when servers are detected (the label is the server
			// list — it never literally says "no issues", which is why the
			// old check never turned green); warning when none are detected
			// or diagnostics found real issues (`N issues`).
			valueFg: /\d+ issues?/.test(data.lspLabel)
				? 'warning'
				: data.lspLabel.startsWith('no language servers')
					? 'warning'
					: 'success',
		},
		{
			label: 'AGENTS.md',
			value: data.rulesFile,
			valueFg: data.rulesFile === 'none' ? 'warning' : undefined,
		},
		{label: 'Steering', value: data.steeringLabel},
		{label: 'Watchdog', value: data.watchdogLabel},
		{label: 'Stream guard', value: data.streamGuardLabel},
		{label: 'Version', value: data.version},
	];
}
