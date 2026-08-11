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
	rulesFile: '/work/AGENTS.md',
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
			'AGENTS.md',
			'Steering',
			'Watchdog',
			'Stream guard',
			'Version',
		]) {
			expect(labels).toContain(expected);
		}
	});

	test('AGENTS.md row shows the resolved rules file', () => {
		const rows = buildStatusRows(BASE);
		const row = rows.find(r => r.label === 'AGENTS.md');
		expect(row?.value).toBe('/work/AGENTS.md');
		expect(row?.valueFg).toBeUndefined();
		const none = buildStatusRows({...BASE, rulesFile: 'none'});
		expect(none.find(r => r.label === 'AGENTS.md')?.valueFg).toBe('warning');
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
