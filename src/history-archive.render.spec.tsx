import '@opentui/solid/preload';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	existsSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {History} from './components/history';
import {ScrollBoxRenderable} from '@opentui/core';
import * as state from './state';
import {
	appendTranscriptRows,
	readTranscriptPageById,
	transcriptArchiveInfo,
	seekTranscriptCursor,
} from './transcript-archive';

test('real History backreads after repeated compaction by PageUp and wheel, blocks modals, and returns latest', async () => {
	const root = mkdtempSync(join(tmpdir(), 'history-render-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
	state.clearMessages();
	state.setSessionId('history-render');
	state.configureTranscriptArchive(appendTranscriptRows);
	const all: state.ChatMessage[] = Array.from({length: 8}, (_, index) => ({
		role: 'user',
		content: `PROMPT-${index}`,
	}));
	state.setMessages(all);
	state.setContext([{role: 'user', content: 'provider latest only'}]);
	state.setMessages(state.retainArchivedDisplayWindow(all, all.slice(-2)));
	// A second compaction must not duplicate already archived rows.
	state.setMessages(
		state.retainArchivedDisplayWindow(state.messages(), all.slice(-1)),
	);
	expect(transcriptArchiveInfo('history-render').count).toBe(7);
	let reads = 0;
	const setup = await testRender(
		() => (
			<History
				width={90}
				height={24}
				archive={{
					owner: () => `${state.sessionId()}:${state.historySessionEpoch()}`,
					session: state.sessionId,
					active: state.messages,
					read: async (id, request) => {
						reads++;
						const beforeId =
							request.beforeId &&
							seekTranscriptCursor(id, request.beforeId) !== undefined
								? request.beforeId
								: undefined;
						const page = readTranscriptPageById(id, {...request, beforeId});
						return {
							rows: page.messages,
							hasOlder: page.hasOlder,
							hasNewer: page.hasNewer,
						};
					},
				}}
			/>
		),
		{width: 90, height: 24},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	const waitFor = async (expected: string) => {
		const deadline = Date.now() + 3000;
		do {
			await setup.flush();
			if (text().includes(expected)) return;
			await Bun.sleep(25);
		} while (Date.now() < deadline);
		expect(text()).toContain(expected);
	};
	try {
		await waitFor('PROMPT-7');
		expect(text()).not.toContain('PROMPT-0');
		state.setSettingsOpen(true);
		setup.mockInput.pressKey('\x1b[5~');
		await setup.mockMouse.scroll(3, 3, 'up');
		await setup.flush();
		expect(reads).toBe(0);
		state.setSettingsOpen(false);
		setup.mockInput.pressKey('\x1b[5~');
		await waitFor('PROMPT-0');
		expect(reads).toBe(1);
		expect(state.messages()).toHaveLength(1);
		expect(state.context()).toEqual([
			{role: 'user', content: 'provider latest only'},
		]);
		state.setRunning(true);
		state.setStreaming('LIVE-SHOULD-NOT-APPEAR');
		state.appendMessage({role: 'user', content: 'LATEST-NEW'});
		await Bun.sleep(200);
		await setup.flush();
		expect(text()).not.toContain('LATEST-NEW');
		expect(text()).not.toContain('LIVE-SHOULD-NOT-APPEAR');
		setup.mockInput.pressKey('END');
		await waitFor('LATEST-NEW');
		state.setRunning(false);
		state.setStreaming('');
		setup.mockInput.pressKey('HOME');
		await setup.flush();
		await setup.mockMouse.scroll(3, 3, 'up');
		await waitFor('PROMPT-0');
		expect(reads).toBe(2);
		// Switch sessions while archived: no old rows or stale ownership survives.
		state.clearMessages();
		state.setSessionId('other');
		state.setMessages([{role: 'user', content: 'OTHER-SESSION'}]);
		await waitFor('OTHER-SESSION');
		expect(text()).not.toContain('PROMPT-0');
	} finally {
		setup.renderer.destroy();
		state.setSettingsOpen(false);
		state.clearMessages();
		state.configureTranscriptArchive(() => {});
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		rmSync(root, {recursive: true, force: true});
	}
});

test('first explicit backread recovers legacy overlap once without duplicates or provider replay', async () => {
	const root = mkdtempSync(join(tmpdir(), 'history-legacy-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
	state.clearMessages();
	state.setSessionId('legacy-ui');
	state.setMessages([
		{role: 'user', content: 'RETAINED-USER'},
		{role: 'assistant', content: 'RETAINED-ANSWER'},
		{role: 'user', content: 'NEW-TURN'},
	]);
	state.setContext([{role: 'user', content: 'provider stays current'}]);
	mkdirSync(join(root, 'compaction-transcripts'));
	const path = join(root, 'compaction-transcripts', 'legacy-ui.jsonl');
	writeFileSync(
		path,
		JSON.stringify({
			sessionId: 'legacy-ui',
			messages: [
				{role: 'user', content: 'RETAINED-USER'},
				{role: 'assistant', content: 'LEGACY-ANSWER'},
				{role: 'user', content: 'RETAINED-USER'},
				{role: 'assistant', content: 'RETAINED-ANSWER'},
			],
		}),
	);
	const setup = await testRender(() => <History width={90} height={24} />, {
		width: 90,
		height: 24,
	});
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	const settle = async () => {
		await Bun.sleep(150);
		await setup.flush();
	};
	try {
		await settle();
		expect(transcriptArchiveInfo('legacy-ui').count).toBe(0);
		setup.mockInput.pressKey('\x1b[5~');
		await settle();
		expect(text()).toContain('LEGACY-ANSWER');
		expect(text().match(/RETAINED-USER/g)).toHaveLength(2);
		expect(text().match(/RETAINED-ANSWER/g)).toHaveLength(1);
		expect(text().match(/NEW-TURN/g)).toHaveLength(1);
		expect(transcriptArchiveInfo('legacy-ui').count).toBe(2);
		expect(state.context()).toEqual([
			{role: 'user', content: 'provider stays current'},
		]);
		setup.mockInput.pressKey('END');
		await settle();
		setup.mockInput.pressKey('\x1b[5~');
		await settle();
		expect(transcriptArchiveInfo('legacy-ui').count).toBe(2);
		expect(text().match(/RETAINED-USER/g)).toHaveLength(2);
		expect(existsSync(path)).toBe(true);
	} finally {
		setup.renderer.destroy();
		state.clearMessages();
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		rmSync(root, {recursive: true, force: true});
	}
});

test('oversized legacy snapshot reports retained path without importing or retrying unbounded', async () => {
	const root = mkdtempSync(join(tmpdir(), 'history-legacy-large-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
	state.clearMessages();
	state.setSessionId('legacy-large');
	state.setMessages([{role: 'user', content: 'CURRENT'}]);
	mkdirSync(join(root, 'compaction-transcripts'));
	const path = join(root, 'compaction-transcripts', 'legacy-large.jsonl');
	writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
	const setup = await testRender(() => <History width={100} height={20} />, {
		width: 100,
		height: 20,
	});
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	try {
		await setup.flush();
		setup.mockInput.pressKey('\x1b[5~');
		await Bun.sleep(100);
		await setup.flush();
		expect(text()).toContain('1 MiB recovery limit');
		expect(text()).toContain('legacy-large.jsonl');
		expect(transcriptArchiveInfo('legacy-large').count).toBe(0);
		// Replacing the file proves a second gesture does not retry this attempted recovery.
		writeFileSync(
			path,
			JSON.stringify({
				sessionId: 'legacy-large',
				messages: [{role: 'user', content: 'SHOULD-NOT-RETRY'}],
			}),
		);
		setup.mockInput.pressKey('\x1b[5~');
		await Bun.sleep(100);
		await setup.flush();
		expect(transcriptArchiveInfo('legacy-large').count).toBe(0);
		expect(existsSync(path)).toBe(true);
	} finally {
		setup.renderer.destroy();
		state.clearMessages();
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		rmSync(root, {recursive: true, force: true});
	}
});

test('legacy overlap uses archived active boundary before paging a 400-row chronology', async () => {
	const root = mkdtempSync(join(tmpdir(), 'history-order-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
	state.clearMessages();
	state.setSessionId('order-ui');
	const all: state.ChatMessage[] = Array.from({length: 400}, (_, i) => ({
		transcriptId: `r${i}`,
		role: 'user',
		content: `ORDER-${i}`,
	}));
	state.setMessages(all.slice(100));
	mkdirSync(join(root, 'compaction-transcripts'));
	writeFileSync(
		join(root, 'compaction-transcripts', 'order-ui.jsonl'),
		JSON.stringify({
			sessionId: 'order-ui',
			messages: all.slice(0, 300),
		}),
	);
	const setup = await testRender(() => <History width={80} height={18} />, {
		width: 80,
		height: 18,
	});
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	const settle = async () => {
		await Bun.sleep(120);
		await setup.flush();
	};
	try {
		await settle();
		setup.mockInput.pressKey('HOME');
		await settle();
		setup.mockInput.pressKey('\x1b[5~');
		await settle();
		setup.mockInput.pressKey('HOME');
		await settle();
		// Correct oldest page is 40..99, not imported overlap 240..299.
		expect(text()).toContain('ORDER-40');
		expect(text()).not.toContain('ORDER-240');
		state.setMessages(all.slice(-1));
		state.setHistorySessionEpoch(epoch => epoch + 1);
		await settle();
		expect(text()).toContain('ORDER-399');
		expect(text()).not.toContain('ORDER-40');
	} finally {
		setup.renderer.destroy();
		state.clearMessages();
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		rmSync(root, {recursive: true, force: true});
	}
});

test('large real history window preserves its anchor and reloads the opposite evicted boundary', async () => {
	const all: state.ChatMessage[] = Array.from({length: 700}, (_, i) => ({
		transcriptId: `r${i}`,
		role: 'user',
		content: `WINDOW-${i}`,
	}));
	state.clearMessages();
	state.setMessages(all.slice(-300));
	let requests = 0;
	const setup = await testRender(
		() => (
			<History
				width={80}
				height={18}
				archive={{
					owner: () => 'window',
					session: () => 'window',
					active: state.messages,
					read: async (_, request) => {
						requests++;
						const edge =
							request.beforeId || request.afterId
								? Number((request.beforeId ?? request.afterId)?.slice(1))
								: 400;
						const from = request.afterId
							? edge + 1
							: Math.max(0, edge - request.limit);
						const to = request.afterId
							? Math.min(400, from + request.limit)
							: edge;
						return {
							rows: all.slice(from, to),
							hasOlder: from > 0,
							hasNewer: to < 400,
						};
					},
				}}
			/>
		),
		{width: 80, height: 18},
	);
	const text = () =>
		setup
			.captureSpans()
			.lines.map(line => line.spans.map(span => span.text).join(''))
			.join('\n');
	const settle = async () => {
		await Bun.sleep(80);
		await setup.flush();
	};
	try {
		await settle();
		setup.mockInput.pressKey('HOME');
		await settle();
		const scroll = setup.renderer.root.getChildren()[0] as ScrollBoxRenderable;
		const before = text()
			.split('\n')
			.findIndex(line => line.includes('WINDOW-400'));
		expect(before).toBeGreaterThanOrEqual(0);
		setup.mockInput.pressKey('\x1b[5~');
		await settle();
		const after = text()
			.split('\n')
			.findIndex(line => line.includes('WINDOW-400'));
		expect(after).toBe(before);
		expect(requests).toBe(1);
		// The old tail was evicted, so downward paging must fetch it rather than jump to latest.
		scroll.scrollTo(scroll.scrollHeight);
		await settle();
		expect(text()).toContain('WINDOW-639');
		setup.mockInput.pressKey('\x1b[6~');
		await settle();
		expect(requests).toBe(1);
		expect(text()).toContain('WINDOW-639');
		scroll.scrollTo(scroll.scrollHeight);
		await settle();
		expect(text()).toContain('WINDOW-699');
		expect(state.messages()).toHaveLength(300);
	} finally {
		setup.renderer.destroy();
		state.clearMessages();
	}
});

test('backreading does not commit retained tool rows before their final revision', async () => {
	const root = mkdtempSync(join(tmpdir(), 'history-revision-'));
	const previous = process.env.BOBONYO_DATA_DIR;
	process.env.BOBONYO_DATA_DIR = root;
	state.clearMessages();
	state.setSessionId('revision');
	state.configureTranscriptArchive(appendTranscriptRows);
	appendTranscriptRows('revision', [
		{transcriptId: 'old', role: 'user', content: 'OLD-ROW'},
	]);
	state.setMessages([
		{transcriptId: 'user', role: 'user', content: 'CURRENT-PROMPT'},
		{
			transcriptId: 'tool',
			role: 'tool',
			content: 'partial',
			toolId: 'call',
			tool: {
				name: 'execute_bash',
				detail: 'echo check',
				output: 'PARTIAL-OUTPUT',
			},
		},
	]);
	const setup = await testRender(() => <History width={80} height={20} />, {
		width: 80,
		height: 20,
	});
	try {
		await Bun.sleep(100);
		await setup.flush();
		setup.mockInput.pressKey('\x1b[5~');
		await Bun.sleep(100);
		await setup.flush();
		expect(transcriptArchiveInfo('revision').count).toBe(1);
		state.setMessages(rows =>
			rows.map(row =>
				row.transcriptId === 'tool'
					? {
							...row,
							content: 'final',
							tool: {...row.tool!, output: 'FINAL-OUTPUT'},
						}
					: row,
			),
		);
		const outgoing = state.messages();
		state.setMessages(state.retainArchivedDisplayWindow(outgoing, []));
		const saved = readTranscriptPageById('revision', {afterId: 'user'});
		expect(saved.rows[0]?.tool?.output).toBe('FINAL-OUTPUT');
		expect(saved.rows[0]?.transcriptId).toBe('tool');
	} finally {
		setup.renderer.destroy();
		state.clearMessages();
		state.configureTranscriptArchive(() => {});
		if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
		else process.env.BOBONYO_DATA_DIR = previous;
		rmSync(root, {recursive: true, force: true});
	}
});
