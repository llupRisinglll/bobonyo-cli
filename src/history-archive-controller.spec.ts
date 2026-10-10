import {expect, test} from 'bun:test';
import {
	createHistoryArchiveController,
	boundHistoryWindow,
	HISTORY_WINDOW_BYTES,
} from './history-archive-controller';
import type {ChatMessage} from './state';
const row = (i: number): ChatMessage => ({
	transcriptId: `r${i}`,
	role: 'user',
	content: `row ${i}`,
});
test('all 400 failure-retained active rows remain reachable in bounded pages before disk', async () => {
	const active = Array.from({length: 400}, (_, i) => row(i));
	let reads = 0;
	const controller = createHistoryArchiveController({
		owner: () => 'a',
		session: () => 'a',
		active: () => active,
		read: async () => {
			reads++;
			return {rows: [], hasOlder: false, hasNewer: false};
		},
	});
	await controller.load('older');
	expect(controller.rows()?.[0]?.transcriptId).toBe('r40');
	expect(controller.rows()).toHaveLength(300);
	await controller.load('older');
	expect(controller.rows()?.[0]?.transcriptId).toBe('r0');
	expect(reads).toBe(0);
	expect(active).toHaveLength(400);
	await controller.load('older');
	expect(reads).toBe(1);
});
test('oversized newest active row becomes a bounded navigable placeholder', async () => {
	const giant = {...row(10), content: '界'.repeat(HISTORY_WINDOW_BYTES)};
	const active = [giant];
	let requestBefore: string | undefined;
	const controller = createHistoryArchiveController({
		owner: () => 'a',
		session: () => 'a',
		active: () => active,
		read: async (_, request) => {
			requestBefore = request.beforeId;
			return {rows: [row(9)], hasOlder: false, hasNewer: false};
		},
	});
	expect(boundHistoryWindow(active, 'newer')[0]?.content).toContain(
		'Oversized transcript row',
	);
	expect(await controller.load('older')).toBe(true);
	expect(requestBefore).toBe('r10');
	expect(controller.rows()?.map(row => row.transcriptId)).toEqual([
		'r9',
		'r10',
	]);
	expect(giant.content).toHaveLength(HISTORY_WINDOW_BYTES);
});
test('navigation never archives or loses running rows between settled active rows', async () => {
	const active = [
		row(3),
		{...row(4), running: true, role: 'tool' as const},
		row(5),
	];
	const requests: Array<string | undefined> = [];
	const controller = createHistoryArchiveController({
		owner: () => 'a',
		session: () => 'a',
		active: () => active,
		read: async (_, request) => {
			requests.push(request.beforeId);
			return {rows: [row(1), row(2)], hasOlder: false, hasNewer: false};
		},
	});
	await controller.load('older');
	expect(requests).toEqual(['r3']);
	expect(controller.rows()?.map(row => row.transcriptId)).toEqual([
		'r1',
		'r2',
		'r3',
		'r4',
		'r5',
	]);
	active[1] = {...active[1]!, running: false, content: 'final revised output'};
	await controller.load('newer');
	expect(controller.rows()).toBeNull();
	expect(active[1]?.content).toBe('final revised output');
});
test('windows enforce rows and UTF8 bytes and dedupe only identities', () => {
	const rows = Array.from({length: 700}, (_, i) => row(i));
	expect(boundHistoryWindow(rows, 'older')).toHaveLength(300);
	expect(boundHistoryWindow(rows, 'newer')[0]?.transcriptId).toBe('r400');
	expect(boundHistoryWindow([row(1), row(1), row(2)], 'older')).toHaveLength(2);
	const large = rows.map(r => ({...r, content: '界'.repeat(1000)}));
	const bounded = boundHistoryWindow(large, 'older');
	expect(
		bounded.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0),
	).toBeLessThanOrEqual(HISTORY_WINDOW_BYTES);
});
test('discard stale resume/session loads', async () => {
	let owner = 'a';
	const pending = Promise.withResolvers<{
		rows: ChatMessage[];
		hasOlder: boolean;
		hasNewer: boolean;
	}>();
	const controller = createHistoryArchiveController({
		owner: () => owner,
		session: () => owner,
		active: () => [row(100)],
		read: () => pending.promise,
	});
	const load = controller.load('older');
	owner = 'b';
	controller.reset();
	pending.resolve({rows: [row(1)], hasOlder: false, hasNewer: true});
	expect(await load).toBe(false);
	expect(controller.rows()).toBeNull();
	expect(controller.loading()).toBe(false);
});
test('reload evicted newer rows without active appends mutating the archived viewport', async () => {
	const all = Array.from({length: 700}, (_, i) => row(i));
	let active = all.slice(-300);
	const controller = createHistoryArchiveController({
		owner: () => 'a',
		session: () => 'a',
		active: () => active,
		read: async (_, request) => {
			const edge =
				request.beforeId || request.afterId
					? Number((request.beforeId ?? request.afterId)?.slice(1))
					: 400;
			const from = request.afterId
				? edge + 1
				: Math.max(0, edge - request.limit);
			const to = request.afterId ? Math.min(400, from + request.limit) : edge;
			return {
				rows: all.slice(from, to),
				hasOlder: from > 0,
				hasNewer: to < 400,
			};
		},
	});
	await controller.load('older');
	expect(controller.rows()?.[0]?.transcriptId).toBe('r340');
	expect(controller.rows()?.at(-1)?.transcriptId).toBe('r639');
	active = [...active, row(700)];
	expect(controller.rows()?.at(-1)?.transcriptId).toBe('r639');
	await controller.load('newer');
	expect(controller.rows()?.at(-1)?.transcriptId).toBe('r699');
	await controller.load('newer');
	expect(controller.rows()).toBeNull();
});
