/**
 * Word wrapping shared by the input box (caret mapping), the history
 * reflow, and description wrapping. Moved OUT of input-box.tsx so the
 * settings list modal and description-wrap can import it without a module
 * cycle.
 */

/** Wrap free text at `width` (words preserved; long words hard-split). */
export function wrapText(text: string, width: number): string[] {
	return wrapTextDetailed(text, width).map(entry => entry.text);
}

/**
 * Wrap like {@link wrapText} but ALSO record each line's raw-input start
 * offset, so a raw-string cursor can be mapped to the rendered (line,
 * column) where the caret should paint.
 */
export function wrapTextDetailed(
	text: string,
	width: number,
): Array<{text: string; start: number}> {
	const safe = Math.max(1, width);
	const lines: Array<{text: string; start: number}> = [];
	if (text === '') return [{text: '', start: 0}];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const nl = text.indexOf('\n', i);
		const segmentEnd = nl === -1 ? n : nl;
		const segment = text.slice(i, segmentEnd);
		if (segment === '') {
			lines.push({text: '', start: i});
		} else {
			let lineStart = i;
			let current = '';
			let charOffset = 0;
			for (const word of segment.split(/(\s+)/)) {
				if (!word) continue;
				const wordStart = i + charOffset;
				if (word.length > safe) {
					if (current.trim()) {
						// Keep trailing spaces: the CARET must map to the raw
						// offset after a typed space (trimming snapped it back
						// before the space, hiding the space under the block
						// caret).
						lines.push({text: current, start: lineStart});
						current = '';
					}
					for (let k = 0; k < word.length; k += safe) {
						lines.push({
							text: word.slice(k, k + safe),
							start: wordStart + k,
						});
					}
					lineStart = wordStart + word.length;
				} else {
					const candidate = current + word;
					if (current.trim() && candidate.trim().length > safe) {
						lines.push({text: current, start: lineStart});
						current = word.trimStart();
						lineStart =
							wordStart + (word.length - word.trimStart().length);
					} else {
						current = candidate;
					}
				}
				charOffset += word.length;
			}
			if (current.trim()) {
				lines.push({text: current, start: lineStart});
			}
		}
		if (nl === -1) break;
		i = segmentEnd + 1;
	}
	// A trailing newline keeps an EMPTY final row (the caret's resting spot
	// right after the Enter, parity: `'a\n'.split('\n')` → `['a', '']`).
	if (text.endsWith('\n')) lines.push({text: '', start: n});
	return lines;
}
