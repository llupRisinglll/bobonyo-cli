import {describe, expect, test} from 'bun:test';
import {
	sessionInFolder,
	sessionLabel,
	sessionMatchesQuery,
} from './components/resume-modal';

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

describe('sessionMatchesQuery (resume search)', () => {
	const session = {
		...base,
		name: 'Refactor theme',
		firstMessage: 'Please extract the color tokens',
	};

	test('empty or whitespace query matches everything', () => {
		expect(sessionMatchesQuery(session, '')).toBe(true);
		expect(sessionMatchesQuery(session, '   ')).toBe(true);
	});

	test('matches by SESSION ID (exact and partial, case-insensitive)', () => {
		expect(sessionMatchesQuery(session, 'sess_abc_1')).toBe(true);
		expect(sessionMatchesQuery(session, 'abc_1')).toBe(true);
		expect(sessionMatchesQuery(session, 'SESS_ABC')).toBe(true);
	});

	test('matches by conversation name and last prompt', () => {
		expect(sessionMatchesQuery(session, 'theme')).toBe(true);
		expect(sessionMatchesQuery(session, 'color tokens')).toBe(true);
	});

	test('no match returns false', () => {
		expect(sessionMatchesQuery(session, 'definitely-not-here')).toBe(false);
	});

	test('missing id/name/firstMessage never crashes', () => {
		expect(sessionMatchesQuery({...base, id: '', name: ''}, 'x')).toBe(false);
		expect(
			sessionMatchesQuery(
				{...base, name: '', firstMessage: ''},
				'sess_abc_1',
			),
		).toBe(true);
	});
});
