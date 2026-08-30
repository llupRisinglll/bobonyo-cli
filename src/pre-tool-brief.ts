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

/** Split first pre-tool sentence from remaining assistant prose. */
export function splitPreToolText(value: string): {
	brief: string;
	remainder: string;
} {
	const compact = value.replace(/\s+/g, ' ').trim();
	if (!compact) return {brief: '', remainder: ''};
	const segment = new Intl.Segmenter(undefined, {granularity: 'sentence'})
		.segment(compact)
		[Symbol.iterator]()
		.next().value;
	const first = segment?.segment?.trim() || compact;
	// Long one-sentence prose is an answer, not a tool-call brief. Keep it
	// visible as ordinary assistant text instead of hiding it above the tool.
	if (!segment?.segment && compact.length > 160) {
		return {brief: '', remainder: compact};
	}
	const brief = first.length > 160 ? '' : first;
	if (!brief) return {brief: '', remainder: compact};
	return {brief, remainder: compact.slice(brief.length).trim()};
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
