import {wrapText} from '../text-wrap';

const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

/** Wrap display rows without splitting a terminal-wide Unicode grapheme. */
export function wrapQuestionText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines = /^[\x20-\x7e\n▌]*$/.test(text)
		? wrapText(text, safeWidth).map(line =>
				// Shared wrapping retains trailing separators for chat caret mapping.
				// An overflowing separator must not become an empty display row here.
				line.trim() && Bun.stringWidth(line) > safeWidth
					? line.trimEnd()
					: line,
			)
		: text.split('\n');
	return lines.flatMap(line => {
		const rows: string[] = [];
		let row = '';
		let cells = 0;
		for (const {segment} of graphemes.segment(line)) {
			const size = Bun.stringWidth(segment);
			if (cells + size > safeWidth && row) {
				rows.push(row);
				row = '';
				cells = 0;
			}
			row += segment;
			cells += size;
		}
		rows.push(row);
		return rows;
	});
}
