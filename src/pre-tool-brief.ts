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
	const source = value.trim();
	if (!source) return {brief: '', remainder: ''};
	// A real assistant entry keeps its line/paragraph structure. Collapsing
	// multi-line prose into a pre-tool sentence made Markdown and ordinary text
	// disappear from history between tool rounds.
	if (source.includes('\n')) return {brief: '', remainder: source};
	// Markdown is substantive response content, not a one-line tool brief.
	// Keep headings, lists, fences, links, and paragraph structure intact.
	if (
		/(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\|)/m.test(source) ||
		/\[[^\]]+\]\([^\)]+\)|\*\*|__/.test(source)
	) {
		return {brief: '', remainder: source};
	}
	const compact = source.replace(/\s+/g, ' ');
	const segment = new Intl.Segmenter(undefined, {granularity: 'sentence'})
		.segment(source)
		[Symbol.iterator]()
		.next().value;
	const first = segment?.segment?.trim() || compact;
	// Long one-sentence prose is an answer, not a tool-call brief. Keep it
	// visible as ordinary assistant text instead of hiding it above the tool.
	if (!segment?.segment && compact.length > 160) {
		return {brief: '', remainder: source};
	}
	const brief = first.length > 160 ? '' : first;
	if (!brief) return {brief: '', remainder: source};
	// A plain declarative sentence is normal assistant prose, not tool
	// narration. Only concise action-oriented lead-ins become brief chrome;
	// otherwise they vanish from the transcript as if the model said nothing.
	if (
		!/^(?:I['’]ll|I will|I['’]m going to|Let me|We need to|I need to|First\b|Next\b|Now\b|Check\b|Inspect\b|Read\b|Search\b|Run\b|Confirm\b|Review\b|Trace\b|Open\b|Look at\b|Use\b|Update\b|Fix\b|Add\b|Remove\b|Create\b|Test\b|Verify\b|Implement\b|Explore\b)/i.test(
			brief,
		)
	) {
		return {brief: '', remainder: source};
	}
	const firstEnd = (segment?.index ?? 0) + (segment?.segment?.length ?? 0);
	return {brief, remainder: source.slice(firstEnd).trim()};
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
