import {describe, expect, test} from 'bun:test';
import {ProviderError} from './client';
import {
	SUMMARY_PREFIX,
	SUMMARIZATION_PROMPT,
	buildSummarizationPrompt,
	collectCompactedUserMessages,
	compactedDisplayMessages,
	dropOldestPreservedTurn,
	isCompactionSummary,
	isCompactionControlMessage,
	isCompactOverflowError,
	normalizeCompactionSummary,
	partitionCompactionHistory,
	prepareCompactionSummaryHistory,
	trimOldestCompactionTurn,
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
		// re-summarize either current or pre-upgrade summaries.
		const legacy =
			'Another language model started to solve this problem and produced a summary of its thinking process. Here is the summary:';
		const selected = collectCompactedUserMessages([
			user('real prompt 1'),
			user(`${SUMMARY_PREFIX}\nprevious handoff...`),
			user(`${legacy}\nolder handoff...`),
			user('real prompt 2'),
		]);
		expect(selected.map(m => m.content)).toEqual([
			'real prompt 1',
			'real prompt 2',
		]);
		expect(isCompactionSummary(`${SUMMARY_PREFIX}\ncurrent`)).toBe(true);
		expect(isCompactionSummary(`${legacy}\nold`)).toBe(true);
		expect(isCompactionSummary('ordinary user prompt')).toBe(false);
	});

	test('generated state is never treated as an ordinary user prompt', () => {
		const state = '[BOBONYO_AUTHORITATIVE_COMPACTION_STATE_V1]\n{"version":1}';
		const selected = collectCompactedUserMessages([
			user('real prompt'),
			user(state),
		]);
		expect(selected.map(message => message.content)).toEqual(['real prompt']);
		expect(isCompactionControlMessage(state)).toBe(true);
	});

	test('the summary is NOT part of the budget (caller appends it last)', () => {
		// A giant summary-worthy prefix must not crowd out recent user
		// prompts: selection only counts user messages.
		const ctx: ChatMessageLike[] = [user('recent')];
		expect(collectCompactedUserMessages(ctx, 10).length).toBe(1);
	});
});

describe('compaction checkpoint contract', () => {
	test('preserves operating procedure and environment, not only task state', () => {
		for (const required of [
			'# Operating procedure',
			'command templates',
			'tool names',
			'skill names',
			'hosts/IPs',
			'SSH user',
			'verification queries',
			'Failed approaches',
		]) {
			expect(SUMMARIZATION_PROMPT).toContain(required);
		}
		const prompt = buildSummarizationPrompt('/mnt/data/KSProjects/Hilinga');
		expect(prompt).toContain(
			'Current working directory at compaction: "/mnt/data/KSProjects/Hilinga"',
		);
		expect(prompt).toContain('NEVER copy secret values');
	});

	test('mentions retained verbatim turns when present', () => {
		const prompt = buildSummarizationPrompt('/repo', 2);
		expect(prompt).toContain('2 newest complete conversation turns');
	});

	test('strips common model drafting wrappers', () => {
		expect(
			normalizeCompactionSummary(
				'<analysis>draft</analysis>\n<summary># Current state\nReady</summary>',
			),
		).toBe('# Current state\nReady');
		expect(normalizeCompactionSummary('```markdown\n# State\nReady\n```')).toBe(
			'# State\nReady',
		);
	});
});

describe('recent working-set compaction', () => {
	const user = (content: string): ChatMessageLike => ({role: 'user', content});

	test('preserves complete recent turns including tool calls and results', () => {
		const ctx: ChatMessageLike[] = [
			user('old request'),
			{role: 'assistant', content: 'old answer'},
			user('upload image'),
			{
				role: 'assistant',
				content: 'running upload',
				tool_calls: [{id: 'c1', name: 'execute_bash', arguments: '{}'}],
			},
			{role: 'tool', content: 'uploaded id=42', tool_call_id: 'c1'},
			user('verify it'),
			{role: 'assistant', content: 'verified'},
		];
		const partition = partitionCompactionHistory(ctx, 100, 'test-model');
		expect(partition.summarize.map(message => message.content)).toEqual([
			'old request',
			'old answer',
		]);
		expect(partition.preserve).toEqual(ctx.slice(2));
		expect(partition.preservedTurns).toBe(2);
	});

	test('overflow retry drops one whole oldest turn', () => {
		const ctx: ChatMessageLike[] = [
			user('old'),
			{role: 'assistant', content: 'calling', tool_calls: []},
			{role: 'tool', content: 'result', tool_call_id: 'c1'},
			user('new'),
			{role: 'assistant', content: 'answer'},
		];
		expect(trimOldestCompactionTurn(ctx)).toEqual(ctx.slice(3));
		expect(trimOldestCompactionTurn(ctx.slice(3))).toEqual(ctx.slice(3));
	});

	test('post-compact guard can drop the final preserved turn', () => {
		const turn = [user('only turn'), {role: 'assistant', content: 'reply'}];
		expect(dropOldestPreservedTurn(turn)).toEqual([]);
		expect(
			dropOldestPreservedTurn([
				...turn,
				user('new turn'),
				{role: 'assistant', content: 'new reply'},
			]),
		).toEqual([user('new turn'), {role: 'assistant', content: 'new reply'}]);
	});

	test('updates prior checkpoint deliberately and drops generated state', () => {
		const previous = user(`${SUMMARY_PREFIX}\n# Current state\nold fact`);
		const state = user(
			'[BOBONYO_AUTHORITATIVE_COMPACTION_STATE_V1]\n{"version":1}',
		);
		const prepared = prepareCompactionSummaryHistory([
			previous,
			state,
			user('new correction'),
		]);
		expect(prepared[0]?.content).toContain('PRIOR COMPACTION CHECKPOINT');
		expect(prepared[0]?.content).toContain('old fact');
		expect(prepared.some(message => message.content === state.content)).toBe(
			false,
		);
		expect(prepared.at(-1)?.content).toBe('new correction');
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

	test('Responses SSE context-window failures are recoverable', () => {
		expect(
			isCompactOverflowError(
				new Error(
					'Your input exceeds the context window of this model. Please adjust your input and try again.',
				),
			),
		).toBe(true);
		expect(
			isCompactOverflowError(
				new Error('maximum context length is 400000 tokens'),
			),
		).toBe(true);
	});
	test('other statuses and unrelated errors fail compaction', () => {
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
		// Provider context preserves two complete recent turns; display must
		// retain those same turns instead of hiding one of them.
		const display = compactedDisplayMessages(messages, 2);
		expect(display.map(m => m.content)).toEqual([
			'recent prompt 1',
			'reply 1',
			'recent prompt 2',
			'reply 2',
		]);
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
