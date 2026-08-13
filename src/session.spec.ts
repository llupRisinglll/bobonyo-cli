import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
	convertNanocoderSession,
	healResumedContext,
	listSessions,
	loadSession,
	migrateNanocoderSessions,
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

	test('rebuilt tool results reference the SAME synthesized id as their declaration', () => {
		// A transcript tool row without a toolId must not produce a tool
		// result with an EMPTY tool_call_id (the provider rejects it) — the
		// heal synthesizes one id and uses it for BOTH the assistant
		// tool_calls entry and the tool result.
		const transcript: ChatMessage[] = [
			{role: 'user', content: 'check ports'},
			{
				role: 'tool',
				content: '✦ Bash(ss -tlnp)',
				tool: {name: 'execute_bash', detail: '', output: 'ok'},
			},
			{role: 'assistant', content: 'ports are fine'},
		];
		const healed = healResumedContext([{role: 'user', content: 'old'}], transcript);
		const declaration = healed.find(
			message => message.role === 'assistant' && message.tool_calls,
		);
		const result = healed.find(
			message => message.role === 'tool' && message.tool_call_id,
		);
		expect(declaration?.tool_calls?.[0]!.id).toBe('call-0');
		expect(result?.tool_call_id).toBe('call-0');
	});
});

describe('nanocoder session migration', () => {
	const originalBobonyoData = process.env.BOBONYO_DATA_DIR;
	const originalNanoData = process.env.NANOCODER_DATA_DIR;
	let tempRoot = '';
	let bobonyoDir = '';
	let nanoDir = '';

	const legacyFile = (id: string): string =>
		join(nanoDir, 'sessions', `${id}.json`);

	beforeAll(() => {
		tempRoot = mkdtempSync(join(tmpdir(), 'bobonyo-sess-migrate-'));
		bobonyoDir = join(tempRoot, 'bobonyo');
		nanoDir = join(tempRoot, 'nanocoder');
		process.env.BOBONYO_DATA_DIR = bobonyoDir;
		process.env.NANOCODER_DATA_DIR = nanoDir;
	});

	afterAll(() => {
		rmSync(tempRoot, {recursive: true, force: true});
		if (originalBobonyoData === undefined) {
			delete process.env.BOBONYO_DATA_DIR;
		} else {
			process.env.BOBONYO_DATA_DIR = originalBobonyoData;
		}
		if (originalNanoData === undefined) {
			delete process.env.NANOCODER_DATA_DIR;
		} else {
			process.env.NANOCODER_DATA_DIR = originalNanoData;
		}
	});

	test('converts every legacy UUID session, skipping the sessions.json index', () => {
		mkdirSync(join(nanoDir, 'sessions'), {recursive: true});
		writeFileSync(
			legacyFile('e785d2e1-218f-4196-8071-116ffaf1e9ac'),
			JSON.stringify({
				id: 'e785d2e1-218f-4196-8071-116ffaf1e9ac',
				title: 'I want to merge them all',
				createdAt: '2026-08-10T08:57:02.703Z',
				lastAccessedAt: '2026-08-10T09:00:00.000Z',
				messages: [
					{role: 'user', content: 'hello'},
					{role: 'assistant', content: 'hi there'},
				],
			}),
		);
		writeFileSync(
			join(nanoDir, 'sessions', 'sessions.json'),
			JSON.stringify([{id: 'e785d2e1-218f-4196-8071-116ffaf1e9ac'}]),
		);

		expect(migrateNanocoderSessions()).toBe(1);
		const migrated = join(
			bobonyoDir,
			'sessions',
			'e785d2e1-218f-4196-8071-116ffaf1e9ac.json',
		);
		expect(existsSync(migrated)).toBe(true);
		const data = JSON.parse(readFileSync(migrated, 'utf8')) as {
			name: string;
			context?: unknown[];
		};
		expect(data.name).toBe('I want to merge them all');
		// The bobonyo shape carries a rebuilt provider context.
		expect(Array.isArray(data.context)).toBe(true);
		// The legacy index file must NOT be treated as a session.
		expect(
			existsSync(join(bobonyoDir, 'sessions', 'sessions.json')),
		).toBe(false);
	});

	test('migration is idempotent and skips already-present ids', () => {
		expect(migrateNanocoderSessions()).toBe(0);
	});

	test('loadSession falls back to the legacy file and persists the copy', () => {
		const id = '0afdcbec-3270-42cd-8b3b-446e5929f75b';
		writeFileSync(
			legacyFile(id),
			JSON.stringify({
				id,
				title: 'return 403',
				createdAt: '2026-08-10T05:26:47.876Z',
				lastAccessedAt: '2026-08-10T05:26:47.876Z',
				messages: [{role: 'user', content: 'why 403?'}],
			}),
		);
		// No migration run yet — the bobonyo file does not exist.
		const session = loadSession(id);
		expect(session).not.toBeNull();
		expect(session!.name).toBe('return 403');
		// The fallback persisted the converted copy for the next resume.
		expect(
			existsSync(join(bobonyoDir, 'sessions', `${id}.json`)),
		).toBe(true);
	});

	test('listSessions includes migrated legacy sessions', () => {
		const ids = listSessions().map(meta => meta.id);
		expect(ids).toContain('e785d2e1-218f-4196-8071-116ffaf1e9ac');
		expect(ids).toContain('0afdcbec-3270-42cd-8b3b-446e5929f75b');
	});

	test('empty and corrupt legacy files never migrate', () => {
		writeFileSync(
			legacyFile('empty-session'),
			JSON.stringify({id: 'empty-session', messages: []}),
		);
		writeFileSync(legacyFile('corrupt-session'), '{not json');
		expect(migrateNanocoderSessions()).toBe(0);
		expect(
			existsSync(join(bobonyoDir, 'sessions', 'empty-session.json')),
		).toBe(false);
	});
});
