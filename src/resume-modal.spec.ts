import {describe, expect, test} from 'bun:test';
import {sessionInFolder, sessionLabel} from './components/resume-modal';

const base = {
	id: 'sess_abc_1',
	createdAt: 0,
	updatedAt: 0,
	firstMessage: '',
};

describe('sessionLabel', () => {
	test('shows session_id: conversation_name when named', () => {
		expect(sessionLabel({...base, name: 'Refactor theme'})).toBe(
			'sess_abc_1: Refactor theme',
		);
	});

	test('omits the name when it is the default "New conversation"', () => {
		expect(sessionLabel({...base, name: 'New conversation'})).toBe(
			'sess_abc_1',
		);
	});

	test('omits the name when missing or blank', () => {
		expect(sessionLabel({...base, name: ''})).toBe('sess_abc_1');
		expect(sessionLabel({...base, name: '   '})).toBe('sess_abc_1');
	});
});

describe('sessionInFolder (resume scope filter)', () => {
	const cwd = '/mnt/data/KSProjects/bobonyo';
	const folder = {...base, name: 'x', cwd};
	const other = {...base, name: 'y', cwd: '/mnt/data/KSProjects/Hilinga'};
	const legacy = {...base, name: 'old'};

	test('shows only the current folder by default', () => {
		expect(sessionInFolder(folder, cwd, false)).toBe(true);
		expect(sessionInFolder(other, cwd, false)).toBe(false);
	});

	test('shows everything when toggled to ALL', () => {
		expect(sessionInFolder(folder, cwd, true)).toBe(true);
		expect(sessionInFolder(other, cwd, true)).toBe(true);
	});

	test('legacy sessions without a cwd always show (never silently drop)', () => {
		expect(sessionInFolder(legacy, cwd, false)).toBe(true);
		expect(sessionInFolder(legacy, cwd, true)).toBe(true);
	});
});
