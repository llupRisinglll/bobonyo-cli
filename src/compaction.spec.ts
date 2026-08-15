import {describe, expect, test} from 'bun:test';
import {ProviderError} from './client';
import {
	SUMMARY_PREFIX,
	collectCompactedUserMessages,
	compactedDisplayMessages,
	isCompactOverflowError,
} from './app';
import type {ChatMessageLike} from './client';

describe('collectCompactedUserMessages (codex build_compacted_history parity)', () => {
	const user = (content: string): ChatMessageLike => ({
		role: 'user',
		content,
	});

	test('keeps the NEWEST user messages first up to the token budget', () => {
		const ctx: ChatMessageLike[] = [
			user('oldest'),
			{role: 'assistant', content: 'ignored'},
			{role: 'tool', content: 'ignored', tool_call_id: 'c1'},
			user('middle'),
			user('newest'),
		];
		// 6-char messages ≈ 2 tokens each at the default 4 chars/token;
		// budget fits 'middle'+'newest' (4 tokens) but not 'oldest' too (6).
		const selected = collectCompactedUserMessages(ctx, 5);
		expect(selected.map(m => m.content)).toEqual(['middle', 'newest']);
	});

	test('a tiny budget keeps only a truncated trace of the newest message', () => {
		const long = 'x'.repeat(2000);
		const selected = collectCompactedUserMessages(
			[user('old'), user(long)],
			50,
		);
		expect(selected.length).toBe(1);
		expect(selected[0]!.content).toContain('… [truncated]');
		expect(selected[0]!.content!.length).toBeLessThan(300);
	});

	test('messages that fit under the budget are kept whole', () => {
		const selected = collectCompactedUserMessages(
			[user('a'), user('b'), user('c')],
			100,
		);
		expect(selected.map(m => m.content)).toEqual(['a', 'b', 'c']);
	});

	test('no user messages returns an empty selection', () => {
		expect(
			collectCompactedUserMessages([{role: 'assistant', content: 'hi'}]),
		).toEqual([]);
	});

	test('system messages are never carried into the compacted history', () => {
		// The client prepends the system prompt on EVERY request, so a
		// system message inside context would duplicate the cache head.
		const selected = collectCompactedUserMessages([
			{role: 'system', content: 'you are bobonyo'},
			user('recent'),
		]);
		expect(selected.every(m => m.role !== 'system')).toBe(true);
		expect(selected.map(m => m.content)).toEqual(['recent']);
	});

	test('previous compaction summaries are not treated as user prompts', () => {
		// Parity: codex `is_summary_message` — a second compaction must not
		// re-summarize the previous summary.
		const selected = collectCompactedUserMessages([
			user('real prompt 1'),
			user(`${SUMMARY_PREFIX}\nprevious handoff...`),
			user('real prompt 2'),
		]);
		expect(selected.map(m => m.content)).toEqual([
			'real prompt 1',
			'real prompt 2',
		]);
	});

	test('the summary is NOT part of the budget (caller appends it last)', () => {
		// A giant summary-worthy prefix must not crowd out recent user
		// prompts: selection only counts user messages.
		const ctx: ChatMessageLike[] = [user('recent')];
		expect(collectCompactedUserMessages(ctx, 10).length).toBe(1);
	});
});

describe('isCompactOverflowError (codex ContextWindowExceeded parity)', () => {
	test('400 and 413 provider errors are recoverable', () => {
		expect(
			isCompactOverflowError(new ProviderError(400, 'context length exceeded')),
		).toBe(true);
		expect(
			isCompactOverflowError(new ProviderError(413, 'payload too large')),
		).toBe(true);
	});

	test('other statuses and non-provider errors fail compaction', () => {
		expect(isCompactOverflowError(new ProviderError(429, 'rate limit'))).toBe(
			false,
		);
		expect(isCompactOverflowError(new ProviderError(500, 'server'))).toBe(
			false,
		);
		expect(isCompactOverflowError(new Error('network down'))).toBe(false);
		expect(isCompactOverflowError(undefined)).toBe(false);
	});
});

describe('compactedDisplayMessages (display parity: resume shows the compacted view)', () => {
	const userMsg = (content: string, extra: object = {}) => ({
		role: 'user' as const,
		content,
		...extra,
	});
	const asstMsg = (content: string) => ({role: 'assistant' as const, content});
	const infoMsg = (content: string) => ({
		role: 'assistant' as const,
		content,
		kind: 'info' as const,
	});
	test('keeps the NEWEST kept user prompt + its tail (the old wall is gone)', () => {
		const messages = [
			userMsg('very old prompt'),
			asstMsg('old reply'),
			userMsg('recent prompt 1'),
			asstMsg('reply 1'),
			userMsg('recent prompt 2'),
			asstMsg('reply 2'),
		];
		// The provider compaction kept the newest 2 user prompts; the
		// display must keep from the NEWEST kept prompt onward (recent
		// prompt 2 + its reply) — everything older is covered by the
		// summary and never resurfaces.
		const display = compactedDisplayMessages(messages, 2);
		expect(display.map(m => m.content)).toEqual(['recent prompt 2', 'reply 2']);
	});
	test('a zero user-prompt count returns an empty display (summary-only)', () => {
		expect(compactedDisplayMessages([userMsg('a'), asstMsg('b')], 0)).toEqual(
			[],
		);
	});
	test('info rows do not count as user prompts', () => {
		const messages = [userMsg('old'), infoMsg('a notice'), userMsg('recent')];
		// The notice is not a user prompt; keeping 1 prompt keeps `recent`
		// (the newest kept prompt) + its tail.
		expect(compactedDisplayMessages(messages, 1).map(m => m.content)).toEqual([
			'recent',
		]);
	});
});
