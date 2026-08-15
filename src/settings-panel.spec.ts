import {describe, expect, test} from 'bun:test';
import {
	SETTING_OPTIONS,
	SETTINGS_TABS,
	settingsRows,
} from './components/settings-panel';

describe('settings model rows (main Model lives in Capabilities only)', () => {
	test('Capabilities shows exactly one Model row', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Capabilities'));
		expect(rows.filter(row => row.key === 'model')).toHaveLength(1);
	});

	test('Advanced has no duplicate Model row', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Advanced'));
		expect(rows.some(row => row.key === 'model')).toBe(false);
	});

	test('Advanced keeps its session/infra rows', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Advanced'));
		const keys = rows.map(row => row.key);
		expect(keys).toContain('session');
		expect(keys).toContain('checkpoints');
		expect(keys).toContain('developerMode');
	});
});

describe('thinking display setting', () => {
	test('Behavior exposes a hidden/show/line Thinking display row', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Behavior'));
		const row = rows.find(candidate => candidate.key === 'thinkingMode');
		expect(row?.label).toBe('Thinking display');
		expect(['hidden', 'show', 'line']).toContain(row!.value);
		expect(SETTING_OPTIONS.thinkingMode).toEqual(['hidden', 'show', 'line']);
	});
});

describe('caveman mode setting', () => {
	test('Behavior exposes an on/off Caveman mode row', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Behavior'));
		const row = rows.find(candidate => candidate.key === 'cavemanMode');
		expect(row?.label).toBe('Caveman mode');
		expect(['on', 'off']).toContain(row!.value);
		expect(SETTING_OPTIONS.cavemanMode).toEqual(['on', 'off']);
	});

	test('Behavior exposes the Resume working dir mode selector', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Behavior'));
		const row = rows.find(candidate => candidate.key === 'resumeCwd');
		expect(row?.label).toBe('Resume working dir');
		expect(['session', 'current', 'ask']).toContain(row!.value);
		expect(SETTING_OPTIONS.resumeCwd).toEqual(['session', 'current', 'ask']);
	});
});

describe('system prompt setting', () => {
	test('Behavior exposes the System prompt style selector', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Behavior'));
		const row = rows.find(candidate => candidate.key === 'systemPrompt');
		expect(row?.label).toBe('System prompt');
		expect(SETTING_OPTIONS.systemPrompt).toEqual([
			'default',
			'opencode',
			'claudecode',
			'codex',
			'custom',
		]);
	});
});

describe('providers tab is replaced by the connect-provider modal entry', () => {
	test('the Providers tab is GONE (the modal replaces it)', () => {
		expect(SETTINGS_TABS).not.toContain('Providers');
	});

	test('Capabilities exposes a Connect provider row (opens the modal)', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Capabilities'));
		const row = rows.find(candidate => candidate.key === 'connectProvider');
		expect(row?.label).toBe('Connect provider');
	});

	test('MCP servers + tool approval moved to Advanced', () => {
		const keys = settingsRows(
			SETTINGS_TABS.indexOf('Advanced'),
		).map(row => row.key);
		expect(keys).toContain('mcp');
		expect(keys).toContain('toolApproval');
	});
});
