/** Fixed-size, width-capped tail for chat and `/ps` agent rows. */
export function subagentCompactTail(
	output: string,
	maxLines = 4,
	maxWidth = 100,
): string[] {
	return output
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.slice(-Math.max(1, maxLines))
		.map(line =>
			line.length > maxWidth
				? `${line.slice(0, Math.max(1, maxWidth - 1))}…`
				: line,
		);
}

/** Chat-style `└` lead plus aligned continuation lines. */
export function formatSubagentCompactTail(
	output: string,
	maxLines = 4,
	maxWidth = 100,
): string {
	const lines = subagentCompactTail(output, maxLines, maxWidth);
	if (lines.length === 0) return '  └  Working…';
	return lines
		.map((line, index) => `${index === 0 ? '  └  ' : '     '}${line}`)
		.join('\n');
}
