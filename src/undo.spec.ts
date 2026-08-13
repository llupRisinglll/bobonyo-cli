import {describe, expect, test} from 'bun:test';
import {promptHistoryFromMessages, undoExchange} from './app';
import type {ChatMessageLike} from './client';
import type {ChatMessage} from './state';

const user = (content: string): ChatMessage => ({
	role: 'user',
	content,
});
const assistant = (content: string): ChatMessage => ({
	role: 'assistant',
	content,
});
const ctxUser = (content: string): ChatMessageLike => ({
	role: 'user',
	content,
});
const ctxAssistant = (content: string): ChatMessageLike => ({
	role: 'assistant',
	content,
});

describe('undoExchange (opencode-style session revert)', () => {
	test('nothing to undo on an empty or assistant-only transcript', () => {
		expect(undoExchange([], []).undonePrompt).toBeNull();
		expect(undoExchange([assistant('hi')], [ctxAssistant('hi')]).undonePrompt).toBeNull();
	});

	test('truncates transcript AND context at the last user message', () => {
		const messages = [
			user('hello'),
			assistant('hi'),
			user('tell me a story'),
			assistant('Once upon a time…'),
		];
		const context: ChatMessageLike[] = [
			ctxUser('hello'),
			ctxAssistant('hi'),
			ctxUser('tell me a story'),
			ctxAssistant('Once upon a time…'),
		];
		const {keptMessages, keptContext, undonePrompt} = undoExchange(
			messages,
			context,
		);
		expect(undonePrompt).toBe('tell me a story');
		expect(keptMessages).toEqual([user('hello'), assistant('hi')]);
		expect(keptContext).toEqual([ctxUser('hello'), ctxAssistant('hi')]);
	});

	test('CACHE INVARIANT: kept context is a strict PREFIX of the old list', () => {
		const context: ChatMessageLike[] = [
			ctxUser('hello'),
			ctxAssistant('hi'),
			ctxUser('second'),
			ctxAssistant('ok'),
			ctxUser('third'),
			ctxAssistant('done'),
		];
		const {keptContext} = undoExchange(
			[
				user('hello'),
				assistant('hi'),
				user('second'),
				assistant('ok'),
				user('third'),
				assistant('done'),
			],
			context,
		);
		expect(keptContext.length).toBeLessThan(context.length);
		expect(JSON.stringify(context.slice(0, keptContext.length))).toBe(
			JSON.stringify(keptContext),
		);
	});

	test('multi-level: undoing twice walks back two exchanges', () => {
		const messages = [
			user('one'),
			assistant('a'),
			user('two'),
			assistant('b'),
			user('three'),
			assistant('c'),
		];
		const context: ChatMessageLike[] = [...messages];
		const first = undoExchange(messages, context);
		expect(first.undonePrompt).toBe('three');
		const second = undoExchange(first.keptMessages, first.keptContext);
		expect(second.undonePrompt).toBe('two');
		expect(second.keptMessages).toEqual([user('one'), assistant('a')]);
	});

	test('tool runs after the last user message are dropped with it', () => {
		const messages = [
			user('fix the bug'),
			{role: 'assistant', content: ''} as ChatMessage,
			{
				role: 'tool',
				content: '✦ Bash(ls)',
			} as ChatMessage,
			user('now ship it'),
			assistant('done'),
		];
		const context: ChatMessageLike[] = [
			ctxUser('fix the bug'),
			{role: 'assistant', content: '', tool_calls: [{id: 'c1', name: 'bash', arguments: '{}'}]},
			{role: 'tool', content: '✦ Bash(ls)', tool_call_id: 'c1'},
			ctxUser('now ship it'),
			ctxAssistant('done'),
		];
		const {keptMessages, keptContext, undonePrompt} = undoExchange(
			messages,
			context,
		);
		expect(undonePrompt).toBe('now ship it');
		expect(keptMessages.map(m => m.content)).toEqual([
			'fix the bug',
			'',
			'✦ Bash(ls)',
		]);
		expect(keptContext.length).toBe(3);
		// Still a strict prefix of the original context.
		expect(JSON.stringify(context.slice(0, keptContext.length))).toBe(
			JSON.stringify(keptContext),
		);
	});

	test('a lagged context (fewer users) is rebuilt from the kept transcript', () => {
		const messages = [user('one'), assistant('a'), user('two'), assistant('b')];
		// Context never got the second exchange (interrupted-turn lag).
		const context: ChatMessageLike[] = [ctxUser('one'), ctxAssistant('a')];
		const {keptMessages, keptContext, undonePrompt} = undoExchange(
			messages,
			context,
		);
		expect(undonePrompt).toBe('two');
		expect(keptMessages).toEqual([user('one'), assistant('a')]);
		expect(keptContext).toEqual([ctxUser('one'), ctxAssistant('a')]);
	});
});

describe('promptHistoryFromMessages (arrow-up history after resume)', () => {
	test('collects every user prompt in order, newest last', () => {
		const messages: ChatMessage[] = [
			{role: 'user', content: 'first'},
			{role: 'assistant', content: 'reply'},
			{role: 'user', content: 'second'},
			{role: 'tool', content: '✦ Bash(ls)'},
			{role: 'user', content: 'third'},
		];
		expect(promptHistoryFromMessages(messages)).toEqual([
			'first',
			'second',
			'third',
		]);
	});

	test('uses the TYPED command text, not the injected body', () => {
		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: 'long injected body',
				command: {
					kind: 'command',
					name: 'worktree',
					original: '/worktree purpose: fix build',
					body: 'long injected body',
				},
			},
		];
		expect(promptHistoryFromMessages(messages)).toEqual([
			'/worktree purpose: fix build',
		]);
	});

	test('skips errored user messages and collapses consecutive duplicates', () => {
		const messages: ChatMessage[] = [
			{role: 'user', content: 'dup'},
			{role: 'user', content: 'dup'},
			{role: 'user', content: 'next', error: 'network failed'},
			{role: 'user', content: 'dup'},
		];
		// The errored `next` is skipped; the trailing `dup` is then
		// CONSECUTIVE to the earlier `dup`, so the collapse removes it.
		expect(promptHistoryFromMessages(messages)).toEqual(['dup']);
	});

	test('caps at 100 entries like the live per-turn history', () => {
		const messages: ChatMessage[] = Array.from({length: 120}, (_, i) => ({
			role: 'user' as const,
			content: `prompt-${i}`,
		}));
		const history = promptHistoryFromMessages(messages);
		expect(history).toHaveLength(100);
		expect(history[0]).toBe('prompt-20');
		expect(history[99]).toBe('prompt-119');
	});
});
