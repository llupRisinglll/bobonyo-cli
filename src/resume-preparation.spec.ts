import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveSession, type SessionData} from './session';
import {prepareSessionAsync} from './session-list-async';
import {prepareResume} from './resume-preparation';
import {readTranscriptPage, transcriptArchiveInfo} from './transcript-archive';
import {DISPLAY_MESSAGE_CAP} from './state';

test('worker resolves id, last and index, prepares a bounded display and heals context', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'resume-worker-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	const previousLegacy = process.env.NANOCODER_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = directory;
	process.env.NANOCODER_DATA_DIR = directory;
	const session: SessionData = {
		id: 'sess_worker',
		name: 'Worker test',
		createdAt: 1,
		updatedAt: 1,
		firstMessage: 'hello',
		context: [],
		messages: Array.from({length: 1000}, (_, index) => ({
			role: index % 2 ? ('assistant' as const) : ('user' as const),
			content: `message ${index}`,
		})),
	};
	try {
		saveSession(session);
		for (const ref of [session.id, 'last', '0']) {
			const restored = await prepareSessionAsync(ref, 50);
			expect(restored?.session.id).toBe(session.id);
			expect(restored?.display.length).toBe(DISPLAY_MESSAGE_CAP);
			expect(restored?.session.messages).toHaveLength(DISPLAY_MESSAGE_CAP);
			expect(restored?.session.messages[0]?.content).toBe('message 700');
			expect(restored?.display[0]?.content).toBe('message 700');
			expect(
				restored?.display.every(message => Boolean(message.transcriptId)),
			).toBe(true);
			expect(restored?.archiveError).toBe('');
			expect(transcriptArchiveInfo(session.id).count).toBe(700);
			expect(
				readTranscriptPage(session.id, {beforeCursor: 1}).messages[0]?.content,
			).toBe('message 0');
			expect(restored?.display.at(-1)?.content).toBe('message 999');
			expect(restored?.context.length).toBe(50);
			expect(restored?.promptHistory.length).toBe(100);
		}
		expect(await prepareSessionAsync('99', 50)).toBeNull();
		expect(await prepareSessionAsync('sess_missing', 50)).toBeNull();
		const controller = new AbortController();
		controller.abort();
		await expect(
			prepareSessionAsync('last', 50, controller.signal),
		).rejects.toHaveProperty('name', 'AbortError');
	} finally {
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		if (previousLegacy === undefined) delete process.env.NANOCODER_DATA_DIR;
		else process.env.NANOCODER_DATA_DIR = previousLegacy;
		rmSync(directory, {recursive: true, force: true});
	}
});

test('healthy provider context is reused verbatim; task lookup selects the newest row', () => {
	const session: SessionData = {
		id: 'sess_healthy',
		name: 'Healthy',
		createdAt: 1,
		updatedAt: 1,
		firstMessage: 'hello',
		messages: [
			{role: 'user', content: 'hello'},
			{role: 'assistant', content: 'world'},
		],
		context: [
			{role: 'user', content: 'hello'},
			{role: 'assistant', content: 'world'},
		],
	};
	expect(prepareResume(session, 100).context).toBe(session.context);
	session.messages.push(
		...['old', 'new'].map(title => ({
			role: 'tool' as const,
			content: '',
			tool: {name: 'write_tasks', detail: '', output: '', args: {title}},
		})),
	);
	expect(prepareResume(session, 100).taskMessage?.tool?.args?.title).toBe(
		'new',
	);
});
test('resume establishes legacy history before outgoing tail and returns only bounded session rows', () => {
	const root = mkdtempSync(join(tmpdir(), 'resume-legacy-order-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
	try {
		mkdirSync(join(root, 'compaction-transcripts'));
		writeFileSync(
			join(root, 'compaction-transcripts', 'order.jsonl'),
			JSON.stringify({
				sessionId: 'order',
				messages: [
					{role: 'user', content: 'old prompt'},
					{role: 'user', content: 'tail 0'},
				],
			}),
		);
		const session: SessionData = {
			id: 'order',
			name: 'Order',
			firstMessage: 'tail 0',
			createdAt: 1,
			updatedAt: 1,
			context: [],
			messages: Array.from({length: 400}, (_, i) => ({
				role: 'user',
				content: `tail ${i}`,
			})),
		};
		const restored = prepareResume(session, 50);
		expect(restored.session.messages).toHaveLength(300);
		expect(restored.session.messages[0]?.content).toBe('tail 100');
		const archived = readTranscriptPage('order', {beforeCursor: 3}).rows;
		expect(archived.map(row => row.content)).toEqual([
			'old prompt',
			'tail 0',
			'tail 1',
		]);
		expect(transcriptArchiveInfo('order').count).toBe(101);
		prepareResume(session, 50);
		expect(transcriptArchiveInfo('order').count).toBe(101);
		const small = {
			...session,
			id: 'small',
			messages: session.messages.slice(-2),
		};
		writeFileSync(
			join(root, 'compaction-transcripts', 'small.jsonl'),
			JSON.stringify({
				sessionId: 'small',
				messages: [{role: 'user', content: 'lazy old'}],
			}),
		);
		prepareResume(small, 50);
		expect(transcriptArchiveInfo('small').count).toBe(0);
	} finally {
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		rmSync(root, {recursive: true, force: true});
	}
});
test('resume archive failure retains all rows and keeps healthy provider context untouched', () => {
	const directory = mkdtempSync(join(tmpdir(), 'resume-archive-failure-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = directory;
	try {
		const session: SessionData = {
			id: 'failure',
			name: 'Failure',
			firstMessage: 'row 0',
			createdAt: 1,
			updatedAt: 1,
			messages: Array.from({length: 301}, (_, i) => ({
				role: 'user',
				content: `row ${i}`,
			})),
			context: [{role: 'user', content: 'row 300'}],
		};
		// A real filesystem boundary failure, not a mocked successful write.
		writeFileSync(join(directory, 'transcript-archives'), 'not a directory');
		const restored = prepareResume(session, 50);
		expect(restored.display).toHaveLength(301);
		expect(restored.session.messages).toHaveLength(301);
		expect(restored.archiveError).toContain('earlier rows retained');
		expect(restored.context).toBe(session.context);
	} finally {
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		rmSync(directory, {recursive: true, force: true});
	}
});

test('resume keeps accepted steering visible but never heals it into provider history', () => {
	const pending = {id: 'accepted-1', value: 'undelivered direction'};
	const session: SessionData = {
		id: 'sess_pending',
		name: 'Pending',
		createdAt: 1,
		updatedAt: 1,
		firstMessage: 'old prompt',
		messages: [
			{role: 'user', content: 'old prompt'},
			{role: 'assistant', content: 'old answer'},
			{
				role: 'user',
				content: pending.value,
				steeringId: pending.id,
				steeringStatus: 'accepted',
			},
		],
		context: [],
		steeringInbox: [pending],
	};
	const restored = prepareResume(session, 100);
	expect(restored.display.at(-1)?.content).toBe(pending.value);
	expect(restored.session.steeringInbox).toEqual([pending]);
	expect(restored.context.map(message => message.content)).toEqual([
		'old prompt',
		'old answer',
	]);
});
