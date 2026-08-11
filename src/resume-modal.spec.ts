import {describe, expect, test} from 'bun:test';
import {sessionLabel} from './components/resume-modal';

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
