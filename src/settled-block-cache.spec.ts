import {describe, expect, test} from 'bun:test';
import {
	settledBlockCacheKey,
	stableSettledBlocks,
	type SettledBlock,
} from './settled-block-cache';

const mdBlock = (text: string): SettledBlock => ({
	kind: 'md',
	parts: [{text}],
});
const chunk = (text: string, attributes = 0) => ({
	__isChunk: true as const,
	text,
	attributes,
});

describe('stableSettledBlocks (no whole-history re-render on bash settle)', () => {
	test('identical blocks are reused by reference', () => {
		const cache = new Map<string, SettledBlock>();
		const first = stableSettledBlocks(cache, [mdBlock('hello')]);
		// Same content, NEW object instance (exactly what the memo produces
		// on every recompute when messages() changes).
		const second = stableSettledBlocks(cache, [mdBlock('hello')]);
		expect(second[0]).toBe(first[0]);
	});

	test('changed content gets a fresh block, unchanged neighbors stay put', () => {
		const cache = new Map<string, SettledBlock>();
		const first = stableSettledBlocks(cache, [
			mdBlock('welcome'),
			mdBlock('user message'),
		]);
		// A bash row settles: the memo re-runs, the existing two blocks are
		// rebuilt as NEW objects, and a third block (the tool row) appears.
		const second = stableSettledBlocks(cache, [
			mdBlock('welcome'),
			mdBlock('user message'),
			{
				kind: 'tool',
				part: {text: '```bash:done\nls\n```', key: 'tool-2'},
				segments: {
					header: [chunk('Bash')],
					body: [],
				},
				status: 'done',
				glyph: '✦',
			},
		]);
		// The pre-existing blocks keep their identity (Solid skips them);
		// only the new tool block is fresh.
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
		expect(second[2]).not.toBe(first[0]);
		expect(second[2]!.kind).toBe('tool');
	});

	test('removed blocks drop out of the rendered list', () => {
		const cache = new Map<string, SettledBlock>();
		const first = stableSettledBlocks(cache, [mdBlock('a'), mdBlock('b')]);
		// /undo truncated the transcript back to one message.
		const second = stableSettledBlocks(cache, [mdBlock('a')]);
		expect(second).toHaveLength(1);
		expect(second[0]).toBe(first[0]);
		expect(cache).toHaveLength(1);
	});
	test('content and width variants do not accumulate after replacement', () => {
		const cache = new Map<string, SettledBlock>();
		stableSettledBlocks(cache, [mdBlock('old-width')]);
		stableSettledBlocks(cache, [mdBlock('new-width')]);
		expect(cache).toHaveLength(1);
		expect([...cache.keys()][0]).toContain('new-width');
	});
});

describe('settledBlockCacheKey', () => {
	test('tool blocks include status, glyph, text and tokenized segments', () => {
		const block: SettledBlock = {
			kind: 'tool',
			part: {text: '```bash:running\nls\n```', key: 'k'},
			segments: {
				header: [chunk('Bash', 1)],
				body: [[chunk('out')]],
			},
			status: 'running',
			glyph: '✦',
		};
		const changed = {
			...block,
			status: 'done' as const,
		};
		expect(settledBlockCacheKey(block)).not.toBe(settledBlockCacheKey(changed));
		// A theme/width change alters the tokenized segments -> new key.
		const recolored = {
			...block,
			segments: {
				header: [chunk('Bash', 2)],
				body: [[chunk('out')]],
			},
		};
		expect(settledBlockCacheKey(block)).not.toBe(
			settledBlockCacheKey(recolored),
		);
	});

	test('identical tool blocks share a key', () => {
		const make = (): SettledBlock => ({
			kind: 'tool',
			part: {text: '```bash:done\nls\n```', key: 'k'},
			segments: {
				header: [chunk('Bash')],
				body: [],
			},
			status: 'done',
			glyph: '✦',
		});
		expect(settledBlockCacheKey(make())).toBe(settledBlockCacheKey(make()));
	});
});
