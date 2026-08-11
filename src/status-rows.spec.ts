import {describe, expect, test} from 'bun:test';
import {buildStatusRows, type StatusData} from './status-rows';

const BASE: StatusData = {
	sessionLabel: 'sess (id)',
	provider: 'mock',
	modelLabel: 'mock-model-1[medium]',
	tune: 'full',
	mode: 'yolo mode on',
	contextTokens: 100,
	contextWindow: 128_000,
	contextPercent: 1,
	directory: '/x',
	messagesLabel: '2 transcript · 3 provider',
	bgRunning: 0,
	bgTotal: 0,
	agents: 0,
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
			'Model',
			'Tune',
			'Mode',
			'Context',
			'Directory',
			'Messages',
			'Background',
			'Agents',
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

	test('model[effort] badge flows through', () => {
		const rows = buildStatusRows(BASE);
		const model = rows.find(row => row.label === 'Model');
		expect(model?.value).toBe('mock-model-1[medium]');
	});

	test('mode row is error-colored', () => {
		const rows = buildStatusRows(BASE);
		const mode = rows.find(row => row.label === 'Mode');
		expect(mode?.valueFg).toBe('error');
	});

	test('context warns only above 75%', () => {
		const safe = buildStatusRows(BASE);
		expect(safe.find(row => row.label === 'Context')?.valueFg).toBeUndefined();
		const hot = buildStatusRows({...BASE, contextPercent: 90});
		expect(hot.find(row => row.label === 'Context')?.valueFg).toBe('warning');
	});

	test('background shows running counts and warns while active', () => {
		const idle = buildStatusRows(BASE);
		expect(idle.find(row => row.label === 'Background')?.value).toBe('none');
		const active = buildStatusRows({...BASE, bgRunning: 1, bgTotal: 2});
		const row = active.find(r => r.label === 'Background');
		expect(row?.value).toBe('1 running · 2 total');
		expect(row?.valueFg).toBe('warning');
	});

	test('agents show active count only when nonzero', () => {
		const idle = buildStatusRows(BASE);
		expect(idle.find(row => row.label === 'Agents')?.value).toBe('none');
		const active = buildStatusRows({...BASE, agents: 2});
		expect(active.find(row => row.label === 'Agents')?.value).toBe('2 active');
	});
});
