import type {LiveRowSegments} from './live-tool-row';
import type {RowStatus} from './row-highlight';

/**
 * One renderable block of the settled transcript.
 *
 * - `md`: consecutive non-reply parts grouped into ONE markdown node.
 * - `reply`: an assistant reply (own padded node so the `✦` glyph and the
 *   content never glue together).
 * - `tool`: a settled tool/thought row rendered as a plain component
 *   (SettledToolRow) with pre-tokenized segments.
 */
export type SettledBlock =
	| {kind: 'md'; parts: Array<{text: string; key?: string}>}
	| {kind: 'reply'; parts: Array<{text: string; key?: string}>}
	| {
			kind: 'tool';
			part: {text: string; key?: string};
			segments: LiveRowSegments;
			status: RowStatus;
			glyph: '✦' | '⚙';
			/** Model brief rendered ONCE above the tool entry (bash box). */
			brief?: string;
			/** Part of a briefed batch: shares the single glyph/indent. */
			batchBriefed?: boolean;
	  };

/**
 * Content signature of a settled block — EVERYTHING the block renders.
 * Tool blocks include the tokenized segments (colors/status/width), so a
 * theme or terminal resize rebuilds the block instead of reusing a stale
 * one. Pure, unit-tested.
 */
export function settledBlockCacheKey(block: SettledBlock): string {
	if (block.kind === 'tool') {
		return [
			'tool',
			block.status,
			block.glyph,
			block.brief ?? '',
			block.batchBriefed ? '1' : '',
			block.part.text,
			JSON.stringify(block.segments),
		].join('\u0000');
	}
	return [block.kind, ...block.parts.map(part => part.text)].join('\u0000');
}

/**
 * Stable block identity across memo recomputes.
 *
 * Solid's `<For>` re-renders EVERY child whose item reference changed
 * (mapArray reference equality). When a bash row settles, `messages()`
 * changes, the settled-blocks memo rebuilds the block list, and fresh block
 * objects would make the WHOLE transcript repaint (the post-bash blink).
 * Blocks whose content is unchanged are reused by reference so Solid skips
 * them; only genuinely new/changed blocks get fresh objects. Pure,
 * unit-tested.
 */
export function stableSettledBlocks(
	cache: Map<string, SettledBlock>,
	blocks: SettledBlock[],
): SettledBlock[] {
	const activeKeys = new Set<string>();
	const stable = blocks.map(block => {
		const key = settledBlockCacheKey(block);
		activeKeys.add(key);
		const cached = cache.get(key);
		if (cached) return cached;
		cache.set(key, block);
		return block;
	});
	for (const key of cache.keys()) {
		if (!activeKeys.has(key)) cache.delete(key);
	}
	return stable;
}
