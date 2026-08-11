import type {StatusRow} from './components/status-modal';

/** All runtime state the `/status` modal surfaces (pure, unit-tested). */
export interface StatusData {
	sessionLabel: string;
	provider: string;
	modelLabel: string;
	tune: string;
	mode: string;
	contextTokens: number;
	contextWindow: number;
	contextPercent: number;
	directory: string;
	messagesLabel: string;
	bgRunning: number;
	bgTotal: number;
	agents: number;
	checkpoints: number;
	skills: number;
	customCommands: number;
	mcpServers: string[];
	lspLabel: string;
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
		{label: 'Model', value: data.modelLabel},
		{label: 'Tune', value: data.tune},
		{label: 'Mode', value: data.mode, valueFg: 'error'},
		{
			label: 'Context',
			value: `${data.contextTokens} / ${data.contextWindow} tokens (~${data.contextPercent}%)`,
			valueFg: data.contextPercent > 75 ? 'warning' : undefined,
		},
		{label: 'Directory', value: data.directory},
		{label: 'Messages', value: data.messagesLabel},
		{
			label: 'Background',
			value:
				data.bgTotal === 0
					? 'none'
					: `${data.bgRunning} running · ${data.bgTotal} total`,
			valueFg: data.bgRunning > 0 ? 'warning' : undefined,
		},
		{
			label: 'Agents',
			value: data.agents > 0 ? `${data.agents} active` : 'none',
		},
		{label: 'Checkpoints', value: String(data.checkpoints)},
		{label: 'Skills', value: `${data.skills} loaded`},
		{label: 'Custom commands', value: `${data.customCommands} loaded`},
		{
			label: 'MCP servers',
			value:
				data.mcpServers.length === 0
					? 'none connected'
					: data.mcpServers.join(', '),
			valueFg: data.mcpServers.length === 0 ? undefined : 'success',
		},
		{
			label: 'LSP',
			value: data.lspLabel,
			valueFg: data.lspLabel.includes('no issues')
				? 'success'
				: data.lspLabel.includes('issue')
					? 'warning'
					: undefined,
		},
		{label: 'Steering', value: data.steeringLabel},
		{label: 'Watchdog', value: data.watchdogLabel},
		{label: 'Stream guard', value: data.streamGuardLabel},
		{label: 'Version', value: data.version},
	];
}
