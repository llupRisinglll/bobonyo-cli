import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChatMessageLike} from './client';
import {GraphContextStore} from './graph-context';
import type {SessionTask} from './state';
import {
	forkSession,
	loadCheckpoint,
	loadSession,
	saveCheckpoint,
	saveSession,
	type SessionData,
} from './session';

const history = (content: string): ChatMessageLike[] => [
	{role: 'user', content},
];
const checklist = (title: string): SessionTask[] => [
	{id: 'task', title, status: 'in_progress', dependsOn: ['prerequisite']},
];
describe('graph-owned parent checklists', () => {
	test('selected presentation hides background execution and retains foreground edits', () => {
		const store = new GraphContextStore();
		store.begin('A', [], false, checklist('A'));
		const b = store.begin('B', [], false, checklist('A'));
		const foreground = checklist('B edited');
		expect(store.selectedChecklist(foreground, b)).toBe(foreground);
		const completion = store.begin('A', [], true, foreground);
		expect(store.selectedChecklist(completion.checklist, completion)).toEqual(
			foreground,
		);
		completion.checklist[0]!.status = 'completed';
		store.commitChecklist(completion, completion.checklist);
		expect(store.selectedChecklist(completion.checklist, completion)).toEqual(
			foreground,
		);
		expect(store.selectedChecklist(foreground)).toBe(foreground);
	});
	test('empty selected checklist never falls back to background tasks', () => {
		const store = new GraphContextStore();
		store.begin('A', [], false, checklist('A'));
		store.begin('B', [], false, []);
		const completion = store.begin('A', [], true, []);
		expect(store.selectedChecklist(completion.checklist, completion)).toEqual(
			[],
		);
	});
	test('completion for selected graph presents live execution edits', () => {
		const store = new GraphContextStore();
		store.begin('A', [], false, checklist('A'));
		const completion = store.begin('A', [], true);
		const edited = checklist('A live');
		expect(store.selectedChecklist(edited, completion)).toBe(edited);
	});
	test('captures A before switching; new foreground B inherits current checklist', () => {
		const store = new GraphContextStore();
		store.begin('A', [], false, checklist('A initial'));
		const b = store.begin('B', [], false, checklist('A edited'));
		expect(b.checklist).toEqual(checklist('A edited'));
		expect(store.snapshot().graphs.A?.checklist).toEqual(checklist('A edited'));
	});
	test('completion executes with A tasks and finally restores B even on failure', () => {
		const store = new GraphContextStore();
		store.begin('A', [], false, checklist('A'));
		store.begin('B', [], false, checklist('A'));
		let visible = checklist('B');
		const owner = store.begin('A', [], true, visible);
		visible = owner.checklist;
		expect(visible).toEqual(checklist('A'));
		try {
			visible[0]!.status = 'completed';
			throw new Error('tool failed');
		} catch {
			// Failure must not discard completed task edits.
		} finally {
			store.commitChecklist(owner, visible);
			visible = store.latestChecklist()!;
		}
		expect(visible).toEqual(checklist('B'));
		expect(store.begin('A', [], true, visible).checklist[0]?.status).toBe(
			'completed',
		);
		expect(store.snapshot().latestGraphId).toBe('B');
	});
	test('completion for selected owner keeps its updated checklist', () => {
		const store = new GraphContextStore();
		store.begin('A', [], false, checklist('A'));
		const completion = store.begin('A', [], true, checklist('A edited'));
		completion.checklist[0]!.status = 'completed';
		store.commitChecklist(completion, completion.checklist);
		expect(store.latestChecklist()?.[0]?.status).toBe('completed');
	});
	test('stale leases cannot overwrite checklist revisions', () => {
		const store = new GraphContextStore();
		const stale = store.begin('A', [], false, checklist('old'));
		const current = store.begin('A', [], true);
		expect(store.commitChecklist(current, checklist('new'))).toBe(true);
		expect(store.commitChecklist(stale, checklist('stale'))).toBe(false);
		expect(store.latestChecklist()).toEqual(checklist('new'));
	});
	test('snapshots, inputs, commits, and leases deep-clone checklist dependencies', () => {
		const original = checklist('A');
		const store = new GraphContextStore();
		const lease = store.begin('A', [], false, original);
		original[0]!.dependsOn!.push('input mutation');
		lease.checklist[0]!.dependsOn!.push('lease mutation');
		expect(store.latestChecklist()).toEqual(checklist('A'));
		store.commitChecklist(lease, original);
		original[0]!.title = 'commit mutation';
		const snapshot = store.snapshot();
		const resumed = new GraphContextStore(snapshot);
		snapshot.graphs.A!.checklist![0]!.title = 'snapshot mutation';
		const latest = resumed.latestChecklist()!;
		latest[0]!.title = 'read mutation';
		expect(resumed.latestChecklist()?.[0]?.title).toBe('A');
	});
	test('legacy background graph without tasks does not adopt selected B tasks', () => {
		const store = new GraphContextStore({
			latestGraphId: 'B',
			graphs: {
				A: {revision: 1, history: history('A')},
				B: {revision: 1, history: history('B')},
			},
		});
		expect(store.begin('A', [], true, checklist('B')).checklist).toEqual([]);
		expect(store.latestChecklist()).toEqual(checklist('B'));
	});
});

describe('graph-owned provider context', () => {
	test('A completion uses A history after B, without replacing latest B', () => {
		const store = new GraphContextStore();
		const a = store.begin('A', []);
		let latest = history('goal A with detached agent');
		expect(store.commit(a, latest)).toBe(true);
		const b = store.begin('B', latest);
		latest = history('unrelated goal B');
		expect(store.commit(b, latest)).toBe(true);
		const completion = store.begin('A', latest, true);
		expect(completion.history).toEqual(history('goal A with detached agent'));
		const integrated = [
			...completion.history,
			{role: 'assistant' as const, content: 'A result'},
		];
		if (store.commit(completion, integrated)) latest = integrated;
		expect(latest).toEqual(history('unrelated goal B'));
		expect(store.begin('A', latest, true).history).toEqual(integrated);
		expect(store.snapshot().graphs.B?.history).toEqual(latest);
	});

	test('same-graph revisions supersede stale writers without losing other graphs', () => {
		const store = new GraphContextStore();
		const a = store.begin('A', history('original A'));
		store.commit(a, history('A revision 1'));
		const revision = store.begin('A', history('unrelated latest'), true);
		store.commit(revision, history('A revision 2'));
		expect(store.commit(a, history('stale A'))).toBe(false);
		expect(store.begin('A', [], true).history).toEqual(history('A revision 2'));
	});

	test('detached foreground writer cannot replace newer foreground B', () => {
		const store = new GraphContextStore();
		const a = store.begin('A', history('A'));
		store.begin('B', history('B'));
		expect(store.commit(a, history('A final tool output'))).toBe(false);
		expect(store.snapshot().graphs.A?.history).toEqual(
			history('A final tool output'),
		);
		expect(store.snapshot().graphs.B?.history).toEqual(history('B'));
	});

	test('foreground compaction revises its graph, not older background graph', () => {
		const store = new GraphContextStore();
		store.begin('A', history('A'));
		const b = store.begin('B', history('B'));
		store.reviseLatest(history('B summary'));
		expect(store.commit(b, history('stale B'))).toBe(false);
		expect(store.begin('A', [], true).history).toEqual(history('A'));
		expect(store.begin('B', [], true).history).toEqual(history('B summary'));
	});

	test('snapshots and leases do not alias mutable provider history', () => {
		const store = new GraphContextStore();
		const original = history('A');
		const lease = store.begin('A', original);
		original[0]!.content = 'mutated input';
		lease.history[0]!.content = 'mutated lease';
		const snapshot = store.snapshot();
		snapshot.graphs.A!.history[0]!.content = 'mutated snapshot';
		expect(store.begin('A', [], true).history).toEqual(history('A'));
	});

	test('legacy or missing ownership fails explicitly rather than adopting latest B', () => {
		const store = new GraphContextStore();
		expect(() => store.begin('A', history('B'), true)).toThrow(
			'Provider context unavailable for work graph A',
		);
		expect(() => store.begin(undefined, history('B'), true)).toThrow(
			'no work graph owner',
		);
		expect(store.snapshot().graphs).toEqual({});
		expect(
			store.begin('new-user-work', history('legacy conversation')).history,
		).toEqual(history('legacy conversation'));
	});

	test('session roundtrip and fork preserve independent owners; legacy remains unowned', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bobonyo-graph-context-'));
		const previous = process.env.BOBONYO_DATA_DIR;
		process.env.BOBONYO_DATA_DIR = dir;
		try {
			const store = new GraphContextStore();
			store.begin('A', history('A saved'), false, checklist('A'));
			store.begin('B', history('B latest'), false, checklist('A'));
			store.captureLatestChecklist(checklist('B'));
			const session: SessionData = {
				id: 'graph-context-session',
				name: 'graphs',
				createdAt: 1,
				updatedAt: 1,
				firstMessage: 'A',
				messages: [{role: 'user', content: 'visible A and B'}],
				context: history('B latest'),
				graphContexts: store.snapshot(),
			};
			saveSession(session);
			const loaded = loadSession(session.id)!;
			const checkpointName = saveCheckpoint(
				'graph-owners',
				loaded.messages,
				loaded.context,
				loaded.graphContexts,
			);
			expect(loadCheckpoint(checkpointName)?.graphContexts).toEqual(
				loaded.graphContexts,
			);
			const resumed = new GraphContextStore(loaded.graphContexts);
			expect(resumed.latestChecklist()).toEqual(checklist('B'));
			expect(resumed.begin('A', loaded.context, true).checklist).toEqual(
				checklist('A'),
			);
			expect(resumed.begin('A', loaded.context, true).history).toEqual(
				history('A saved'),
			);
			expect(loaded.messages).toEqual(session.messages);
			const forked = forkSession(loaded);
			forked.graphContexts!.graphs.A!.checklist![0]!.dependsOn!.push('fork');
			expect(loaded.graphContexts!.graphs.A!.checklist).toEqual(checklist('A'));
			forked.graphContexts!.graphs.A!.history[0]!.content = 'fork revision';
			expect(loaded.graphContexts!.graphs.A!.history).toEqual(
				history('A saved'),
			);
			delete session.graphContexts;
			saveSession(session);
			const legacy = loadSession(session.id)!;
			expect(() =>
				new GraphContextStore(legacy.graphContexts).begin(
					'A',
					legacy.context,
					true,
				),
			).toThrow('Provider context unavailable');
		} finally {
			if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
			else process.env.BOBONYO_DATA_DIR = previous;
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
