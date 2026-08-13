import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
	convertNanocoderSession,
	healResumedContext,
	listSessions,
	newSessionId,
	resolveSession,
	saveSession,
} from './session';
import type {ChatMessage} from './state';
import type {ChatMessageLike} from './client';

describe('convertNanocoderSession', () => {
	test('maps title/messages into bobonyo SessionData', () => {
		const session = convertNanocoderSession({
			id: 'nc-1',
			title: 'Old chat',
			createdAt: '2026-08-10T08:57:02.703Z',
			lastAccessedAt: '2026-08-10T09:00:00.000Z',
			messages: [
				{role: 'user', content: 'hello'},
				{role: 'assistant', content: 'hi there'},
			],
		});
		expect(session).not.toBeNull();
		expect(session!.name).toBe('Old chat');
		expect(session!.messages.map(m => m.role)).toEqual(['user', 'assistant']);
		expect(session!.context.length).toBe(2);
	});

	test('converts assistant tool_calls + tool results into tool rows', () => {
		const session = convertNanocoderSession({
			id: 'nc-2',
			messages: [
				{role: 'user', content: 'run it'},
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'call_1',
							function: {
								name: 'execute_bash',
								arguments: '{"command":"echo hi"}',
							},
						},
					],
				},
				{role: 'tool', content: 'hi\n', tool_call_id: 'call_1', name: 'execute_bash'},
				{role: 'assistant', content: 'Done.'},
			],
		});
		expect(session).not.toBeNull();
		const toolRow = session!.messages[1]!;
		expect(toolRow.role).toBe('tool');
		expect(toolRow.tool?.name).toBe('execute_bash');
		expect(toolRow.tool?.output).toBe('hi\n');
		expect(toolRow.tool?.args).toEqual({command: 'echo hi'});
		expect(session!.messages[2]!.role).toBe('assistant');
	});

	test('returns null for a missing id', () => {
		expect(convertNanocoderSession({} as never)).toBeNull();
	});
});

describe('session cwd (resume folder filter)', () => {
	test('saveSession persists the cwd and listSessions returns it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bobonyo-sess-'));
		const prev = process.env.NANOCODER_DATA_DIR;
		process.env.NANOCODER_DATA_DIR = dir;
		try {
			const id = newSessionId();
			saveSession({
				id,
				name: 'work chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				firstMessage: 'fix the bug',
				cwd: '/mnt/data/KSProjects/Hilinga',
				messages: [{role: 'user', content: 'fix the bug'}],
				context: [],
			});
			const meta = listSessions().find(session => session.id === id);
			expect(meta?.cwd).toBe('/mnt/data/KSProjects/Hilinga');
			// Sessions without a cwd (legacy) surface as undefined, not junk.
			const legacy = listSessions().find(session => session.id === 'missing-cwd');
			expect(legacy).toBeUndefined();
		} finally {
			process.env.NANOCODER_DATA_DIR = prev;
			rmSync(dir, {recursive: true, force: true});
		}
	});

	test('saveSession persists provider/model and resolveSession round-trips it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bobonyo-sess-model-'));
		const prev = process.env.NANOCODER_DATA_DIR;
		process.env.NANOCODER_DATA_DIR = dir;
		try {
			const id = newSessionId();
			saveSession({
				id,
				name: 'model chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				firstMessage: 'hi',
				// The model the conversation ran on — /resume restores THIS,
				// not the most-recently used model.
				provider: 'Xiaomi',
				model: 'mimo-v2.5',
				messages: [{role: 'user', content: 'hi'}],
				context: [],
			});
			const resolved = resolveSession(id);
			expect(resolved?.provider).toBe('Xiaomi');
			expect(resolved?.model).toBe('mimo-v2.5');
			// Legacy sessions (no model fields) resolve with undefined, so
			// resume keeps the current model instead of crashing.
			expect(resolveSession('does-not-exist')).toBeNull();
		} finally {
			process.env.NANOCODER_DATA_DIR = prev;
			rmSync(dir, {recursive: true, force: true});
		}
	});
});

describe('healResumedContext (pre-fix sessions: context lagging the transcript)', () => {
	const transcript: ChatMessage[] = [
		{role: 'user', content: 'connect to the prod db'},
		{role: 'assistant', content: '', reasoning: 'thinking about tools'},
		{
			role: 'tool',
			content: '✦ Skill(hilinga-prod-ops)',
			toolId: 'call-1',
			tool: {name: 'skill', detail: 'hilinga-prod-ops', output: 'Loaded skill …'},
		},
		{
			role: 'tool',
			content: '✦ Bash(ssh …)',
			toolId: 'call-2',
			tool: {
				name: 'execute_bash',
				detail: 'ssh …',
				output: 'DB_NAME=ks_erp',
				args: {command: 'ssh …'},
			},
		},
		{role: 'assistant', content: 'Interrupted by user.', error: 'Interrupted by user.'},
		{role: 'user', content: 'continue'},
	];

	test('healthy context (all user messages present) is returned untouched', () => {
		const healthy: ChatMessageLike[] = [
			{role: 'user', content: 'connect to the prod db'},
			{role: 'user', content: 'continue'},
		];
		expect(healResumedContext(healthy, transcript)).toBe(healthy);
	});

	test('divergent context is rebuilt: user rows kept, error rows dropped, tool runs batched', () => {
		// The context ends BEFORE the transcript (missing the newest user
		// turn — the interrupted-turn lag the heal exists for).
		const stale: ChatMessageLike[] = [
			{role: 'user', content: 'connect to the prod db'},
		];
		const healed = healResumedContext(stale, transcript);
		expect(healed).toEqual([
			{role: 'user', content: 'connect to the prod db'},
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{id: 'call-1', name: 'skill', arguments: '{}'},
					{id: 'call-2', name: 'execute_bash', arguments: '{"command":"ssh …"}'},
				],
			},
			{role: 'tool', content: 'Loaded skill …', tool_call_id: 'call-1'},
			{role: 'tool', content: 'DB_NAME=ks_erp', tool_call_id: 'call-2'},
			{role: 'user', content: 'continue'},
		]);
	});

	test('assistant TEXT rows survive; reasoning-only rows do not', () => {
		const withText: ChatMessage[] = [
			...transcript.slice(0, 2),
			{role: 'assistant', content: 'Running fine'},
		];
		const healed = healResumedContext([], withText);
		expect(healed).toEqual([
			{role: 'user', content: 'connect to the prod db'},
			{role: 'assistant', content: 'Running fine'},
		]);
	});

	test('a CAPPED context ending at the transcript tail is reused untouched (cache parity)', () => {
		// The live loop caps the provider context to the newest N messages,
		// so a long conversation legitimately has fewer users than the full
		// transcript. Rebuilding it on resume sent a bigger, byte-different
		// head that busted the prefix cache — the heal must skip it.
		const longTranscript: ChatMessage[] = [
			{role: 'user', content: 'oldest'},
			{role: 'assistant', content: 'old reply'},
			{role: 'user', content: 'newest'},
			{role: 'assistant', content: 'new reply'},
		];
		const capped: ChatMessageLike[] = [
			{role: 'user', content: 'newest'},
			{role: 'assistant', content: 'new reply'},
		];
		expect(healResumedContext(capped, longTranscript)).toBe(capped);
	});

	test('rebuilt contexts respect the newest-N budget like the live loop', () => {
		const longTranscript: ChatMessage[] = [
			{role: 'user', content: 'u1'},
			{role: 'assistant', content: 'a1'},
			{role: 'user', content: 'u2'},
			{role: 'assistant', content: 'a2'},
			{role: 'user', content: 'u3'},
		];
		const healed = healResumedContext([], longTranscript, 2);
		expect(healed).toEqual([
			{role: 'assistant', content: 'a2'},
			{role: 'user', content: 'u3'},
		]);
	});
});
