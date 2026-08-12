import {describe, expect, test} from 'bun:test';
import {interruptedContext} from './app';
import type {ChatMessageLike} from './client';

describe('interruptedContext (Esc commits the turn to the provider context)', () => {
	const history: ChatMessageLike[] = [
		{role: 'user', content: 'connect to the prod db and check availments'},
	];

	test('no partial text: the user message still lands in context', () => {
		expect(interruptedContext(history, '')).toEqual(history);
	});

	test('partial text rides on top of the FULL history, not just old context', () => {
		expect(interruptedContext(history, 'Running fine')).toEqual([
			...history,
			{role: 'assistant', content: 'Running fine'},
		]);
	});

	test('returns a copy — the caller history is never mutated', () => {
		const before = JSON.stringify(history);
		interruptedContext(history, 'partial');
		expect(JSON.stringify(history)).toBe(before);
	});
});
