import type {StatusRow} from './components/status-modal';
import {knownPresetFor} from './components/connect-provider-modal';

/** All runtime state the `/status` modal surfaces (pure, unit-tested). */
export interface StatusData {
	sessionLabel: string;
	provider: string;
	messagesLabel: string;
	/** Monthly usage label (`1.24M tokens · …`) or undefined when none. */
	providerUsageLabel?: string;
	/** Live codex usage-limit rows (`5h limit: [█…] 55% left …`). */
	codexLimitRows?: StatusRow[];
	checkpoints: number;
	skills: number;
	customCommands: number;
	mcpServers: string[];
	mcpConfigured: string[];
	lspLabel: string;
	/** DeepSeek prompt-cache hit ratio from the last turn (`n/a` elsewhere). */
	cacheLabel: string;
	/** Resolved AGENTS.md path actually embedded in the system prompt. */
	rulesFile: string;
	steeringLabel: string;
	watchdogLabel: string;
	streamGuardLabel: string;
	version: string;
}

/**
 * Status-modal provider label: the user-given connection name with the REAL
 * provider name beside it (`opencode-go (OpenCode Go)`), only when they
 * differ. Pure, unit-tested.
 */
export function providerStatusLabel(
	id: string,
	name: string,
	baseUrl: string,
): string {
	const given = name || id;
	const real = knownPresetFor({id, baseUrl})?.title;
	return real && real !== given ? `${given} (${real})` : given;
}

/** Build the `/status` modal rows from live app state. */
export function buildStatusRows(data: StatusData): StatusRow[] {
	return [
		{label: 'Session', value: data.sessionLabel},
		{label: 'Provider', value: data.provider},
		{label: 'Messages', value: data.messagesLabel},
		...(data.providerUsageLabel
			? [{label: 'Provider usage', value: data.providerUsageLabel}]
			: []),
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
			label: 'Prompt cache',
			value: data.cacheLabel,
			// A low cache-hit share is exactly the cost driver the alert
			// exists for; surface it in warning yellow here too.
			valueFg: cacheHitPercent(data.cacheLabel),
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
		// Codex usage limits render at the BOTTOM of the card (parity: the
		// codex CLI's /status lists limits after usage/context, never in the
		// middle of the connection details).
		...(data.codexLimitRows ?? []),
	];
}

/** 'success' above 30% cache-hit, 'warning' below, undefined for `n/a`. */
function cacheHitPercent(label: string): 'success' | 'warning' | undefined {
	const percent = Number(label.match(/(\d+)%/)?.[1]);
	if (!Number.isFinite(percent)) return undefined;
	return percent < 30 ? 'warning' : 'success';
}
