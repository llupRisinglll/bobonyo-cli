import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChatMessageLike} from './client';
import {
	assertGraphToolExecution,
	graphToolCatalog,
	GraphContextStore,
} from './graph-context';
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
test('evidence-only recovery exposes no tools and rejects hallucinated calls before execution or checklist mutation', () => {
	const store = new GraphContextStore();
	store.begin(
		'foreground',
		history('private foreground'),
		false,
		checklist('foreground'),
	);
	const lease = store.begin(
		'missing',
		history('private foreground'),
		true,
		checklist('foreground'),
	);
	const before = store.snapshot();
	let executed = 0;
	const dispatch = (calls: unknown[], text = false) => {
		assertGraphToolExecution(lease, calls, text);
		executed++;
		lease.checklist.push(...checklist('hallucinated checklist'));
		store.commitChecklist(lease, lease.checklist);
	};
	expect(
		graphToolCatalog(lease, ['execute_bash', 'write_tasks', 'mcp_tool']),
	).toEqual([]);
	for (const name of [
		'execute_bash',
		'write_tasks',
		'task_update',
		'task_create',
		'multi_tool_use.parallel',
		'mcp_tool',
	]) {
		expect(() => dispatch([{name, arguments: {}}])).toThrow(
			'no tools were executed',
		);
	}
	expect(() => dispatch([], true)).toThrow('no tools were executed');
	expect(executed).toBe(0);
	expect(lease.history).toEqual([]);
	expect(lease.checklist).toEqual([]);
	expect(store.commitChecklist(lease, checklist('forbidden mutation'))).toBe(
		false,
	);
	expect(store.snapshot()).toEqual(before);
	expect(() => assertGraphToolExecution(lease, [])).not.toThrow();
	const normal = store.begin('foreground', [], true);
	expect(graphToolCatalog(normal, ['write_tasks'])).toEqual(['write_tasks']);
	expect(() =>
		assertGraphToolExecution(normal, [{name: 'write_tasks'}], true),
	).not.toThrow();
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	const boundary = app.indexOf(
		'result.toolCalls,',
		app.indexOf(
			'assertGraphToolExecution',
			app.indexOf('result = await streamChat'),
		),
	);
	expect(boundary).toBeGreaterThan(0);
	expect(boundary).toBeLessThan(
		app.indexOf('const parsed = parseToolCalls(result.text)', boundary),
	);
	expect(boundary).toBeLessThan(app.indexOf('executeTool(call,', boundary));
	expect(app).toMatch(/graphToolCatalog\(\s*contextLease,/);
	expect(app).toContain('disableTools: contextLease.evidenceOnly === true');
});
test('revision ownership lookup never clones stored histories', () => {
	const store = new GraphContextStore();
	const lease = store.begin('owner', history('large history'));
	const clone = globalThis.structuredClone;
	globalThis.structuredClone = (() => {
		throw new Error('unexpected clone');
	}) as typeof structuredClone;
	try {
		expect(store.owns(lease)).toBe(true);
		expect(store.owns({...lease, revision: lease.revision + 1})).toBe(false);
		expect(store.owns({...lease, graphId: 'missing'})).toBe(false);
	} finally {
		globalThis.structuredClone = clone;
	}
});
describe('graph-owned parent checklists', () => {
	test('new work does not inherit a completed checklist or resurrect it from a late completion', () => {
		const store = new GraphContextStore();
		const completed: SessionTask[] = [
			{id: 'resume', title: 'Released resume fix', status: 'completed'},
		];
		store.begin('resume', [], false, completed);
		const next = store.begin('new-question', [], false, completed);
		expect(next.checklist).toEqual([]);
		const late = store.begin('resume', [], true, []);
		expect(late.checklist).toEqual(completed);
		expect(store.selectedChecklist(late.checklist, late)).toEqual([]);
	});
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
	test('old Finance completion cannot declare revised SDK request finished', () => {
		const store = new GraphContextStore();
		const a = store.begin('finance', []);
		store.commit(a, history('Prepare Finance PR'));
		const b = store.begin('sdk', history('Prepare Finance PR'));
		store.commit(
			b,
			history('Extract SDK worker and release it; Finance consumer only'),
		);
		const scope = store.completionScopeGuidance('finance');
		expect(scope).toContain('newer user request');
		expect(scope).toContain('must not cancel, narrow, or declare');
		expect(scope).not.toContain('Extract SDK');
		expect(store.completionScopeGuidance('sdk')).toBe('');
		expect(store.begin('finance', [], true).history).toEqual(
			history('Prepare Finance PR'),
		);
		const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
		expect(app).toContain(
			'turnContextStore.completionScopeGuidance(workGraphId)',
		);
	});
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

	test('legacy completion creates an evidence-only owner without borrowing supplied context', () => {
		const store = new GraphContextStore();
		expect(store.begin('A', history('B'), true).history).toEqual([]);
		expect(store.snapshot().latestGraphId).toBeUndefined();
		expect(store.completionScopeGuidance('A')).toContain(
			'original provider context is unavailable',
		);
		expect(() => store.begin(undefined, history('B'), true)).toThrow(
			'no work graph owner',
		);
		expect(store.snapshot().graphs.A?.checklist).toEqual([]);
		expect(
			store.begin('new-user-work', history('legacy conversation')).history,
		).toEqual(history('legacy conversation'));
	});

	test('missing older owner recovers after continue without adopting or selecting foreground context', () => {
		const store = new GraphContextStore();
		store.begin(
			'continue',
			history('unrelated foreground secret'),
			false,
			checklist('foreground'),
		);
		const before = store.snapshot().graphs.continue;
		const owner = store.begin(
			'missing-legacy-owner',
			history('unrelated foreground secret'),
			true,
			checklist('foreground'),
		);
		expect(owner.history).toEqual([]);
		expect(owner.checklist).toEqual([]);
		expect(store.commit(owner, history('own completion evidence'))).toBe(false);
		expect(store.snapshot().latestGraphId).toBe('continue');
		expect(store.snapshot().graphs.continue).toEqual(before);
		const resumed = new GraphContextStore(store.snapshot());
		expect(
			resumed.begin(
				'missing-legacy-owner',
				history('unrelated foreground secret'),
				true,
			).history,
		).toEqual(history('own completion evidence'));
		expect(resumed.completionScopeGuidance('missing-legacy-owner')).toContain(
			'Do not execute tools',
		);
		expect(resumed.completionScopeGuidance('continue')).toBe('');
		expect(resumed.latestChecklist()).toEqual(checklist('foreground'));
	});

	test('an explicit foreground turn replaces evidence-only mode while retaining its own evidence', () => {
		const store = new GraphContextStore();
		const completion = store.begin('legacy', history('foreign'), true);
		store.commit(completion, history('own evidence'));
		const resumed = store.begin('legacy', history('foreign'));
		expect(resumed.evidenceOnly).toBeUndefined();
		expect(resumed.history).toEqual(history('own evidence'));
		expect(store.completionScopeGuidance('legacy')).toBe('');
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
			expect(
				new GraphContextStore(legacy.graphContexts).begin(
					'A',
					legacy.context,
					true,
				).history,
			).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
			else process.env.BOBONYO_DATA_DIR = previous;
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
