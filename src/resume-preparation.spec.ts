import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveSession, type SessionData} from './session';
import {prepareSessionAsync} from './session-list-async';
import {prepareResume} from './resume-preparation';

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
			expect(restored?.display.length).toBe(301);
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
