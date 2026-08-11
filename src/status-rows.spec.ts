import {describe, expect, test} from 'bun:test';
import {buildStatusRows, type StatusData} from './status-rows';

const BASE: StatusData = {
	sessionLabel: 'sess (id)',
	provider: 'mock',
	messagesLabel: '2 transcript · 3 provider',
	checkpoints: 2,
	skills: 3,
	customCommands: 4,
	mcpServers: [],
	mcpConfigured: [],
	lspLabel: 'no issues · refreshed after code changes',
	steeringLabel: 'disabled',
	watchdogLabel: 'off',
	streamGuardLabel: 'off',
	version: 'bobonyo 0.1.0',
};

describe('buildStatusRows', () => {
	test('includes every tracked detail', () => {
		const rows = buildStatusRows(BASE);
		const labels = rows.map(row => row.label);
		for (const expected of [
			'Session',
			'Provider',
			'Messages',
			'Checkpoints',
			'Skills',
			'Custom commands',
			'MCP servers',
			'LSP',
			'Steering',
			'Watchdog',
			'Stream guard',
			'Version',
		]) {
			expect(labels).toContain(expected);
		}
	});

	test('does not duplicate the status line or input corner', () => {
		const rows = buildStatusRows(BASE);
		const labels = rows.map(row => row.label);
		for (const duplicate of [
			'Model',
			'Tune',
			'Mode',
			'Context',
			'Directory',
			'Background',
			'Agents',
		]) {
			expect(labels).not.toContain(duplicate);
		}
	});
});
