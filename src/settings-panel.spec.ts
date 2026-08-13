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

describe('hide thinking setting', () => {
	test('Behavior exposes an on/off Hide thinking row', () => {
		const rows = settingsRows(SETTINGS_TABS.indexOf('Behavior'));
		const row = rows.find(candidate => candidate.key === 'hideThinking');
		expect(row?.label).toBe('Hide thinking');
		expect(['on', 'off']).toContain(row!.value);
		expect(SETTING_OPTIONS.hideThinking).toEqual(['on', 'off']);
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
