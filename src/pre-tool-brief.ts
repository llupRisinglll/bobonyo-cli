/** Keep model pre-tool narration compact when provider ignores prompt rules. */
export function oneSentencePreToolBrief(value: string): string {
	const compact = value.replace(/\s+/g, ' ').trim();
	if (!compact) return '';
	const segment = new Intl.Segmenter(undefined, {granularity: 'sentence'})
		.segment(compact)
		[Symbol.iterator]()
		.next().value;
	return segment?.segment?.trim() || compact;
}

/** Keep later tool rounds aligned under an earlier brief in the same turn. */
export function toolCallBrief(
	brief: string,
	callIndex: number,
	priorRoundBriefed: boolean,
): string | undefined {
	if (brief) return callIndex === 0 ? brief : ' ';
	return priorRoundBriefed ? ' ' : undefined;
}
