import type {TextChunk} from '@opentui/core';
import {themeColors} from './highlight';
import type {Colors} from './theme';
import {
	tokenizeAgentRow,
	tokenizeBashRow,
	tokenizeCommandRow,
	tokenizeDiffRow,
	tokenizeFileDiff,
	tokenizeFileRow,
	tokenizeTaskRow,
	tokenizeThought,
	tokenizeToolRow,
	type RowStatus,
} from './row-highlight';

export interface LiveRowSegments {
	header: TextChunk[];
	body: TextChunk[][];
}

/**
 * LIVE tool-row chunk building (pure, unit-tested).
 *
 * Running tool rows MUST NOT go through OpenTUI's `<markdown>` pipeline:
 * every content update re-parses the whole node and repaints it, which reads
 * as flicker while a tool streams. Instead the row text is tokenized ONCE per
 * throttled update with the SAME tokenizers the settled rows use (identical
 * colors, syntax highlighting and spacing), and the resulting chunks render
 * as plain `<text>` cells — OpenTUI only repaints the cells that changed.
 * The glyph is rendered separately (blinking) and is NOT part of these
 * chunks, so blink frames never re-tokenize anything.
 */

/** Split a tokenizer chunk stream (newline separators) into per-line chunks. */
export function splitChunksByLine(chunks: TextChunk[]): TextChunk[][] {
	const lines: TextChunk[][] = [];
	let current: TextChunk[] = [];
	for (const chunkEntry of chunks) {
		const parts = chunkEntry.text.split('\n');
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) {
				lines.push(current);
				current = [];
			}
			const text = parts[i];
			if (!text) continue;
			current.push({...chunkEntry, text});
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

/** Extract `<path>` from a row's first line (`✦ Write <path>`). */
function rowPath(text: string): string {
	// The fenced content can start with the blank line after the opener
	// (` ```filerow:done\n\n✦ Write …`), so the FIRST NON-EMPTY line is the
	// header — reading index 0 would yield '' and the language detection
	// would fall back to plain text (no syntax colors on Write/Edit rows).
	const line = text.split('\n').find(candidate => candidate.trim()) ?? '';
	return line.replace(/^[✦⚙]\s*[A-Za-z ]+?\s+/, '').trim();
}

/**
 * Build the live segments for one running tool row: the HEADER line chunks
 * (glyph already stripped — it renders separately) and the BODY line chunks.
 * Mirrors the settled `renderNode` tokenizer dispatch per row language.
 */
export function liveRowSegments(
	text: string,
	lang: string,
	status: RowStatus,
	colors: Colors,
	width: number,
): LiveRowSegments {
	// Strip the leading glyph (it renders separately and blinks; it must
	// never be part of the row chunks or the blink would re-tokenize).
	const trimmed = text.replace(/\s+$/, '').replace(/^[✦⚙]\s*/, '');
	let chunks: TextChunk[];
	// Multi-block previews (file writes) carry their OWN fences; tokenizing
	// them as a single row would miscolor the fence markers. They complete in
	// one call and barely stream, so fall back to plain dim lines.
	if (/^```/.test(trimmed.trimStart())) {
		// File-write/edit rows (filerow/filediff) carry a NESTED header fence
		// plus the numbered code / diff body. Strip the outer fence markers
		// and tokenize the INNER content so the component path keeps the
		// file/diff syntax colors (the same chunks markdown produced).
		const inner = trimmed
			.split('\n')
			.filter(line => !/^\s*```/.test(line))
			.join('\n');
		chunks =
			lang === 'filerow'
				? tokenizeFileRow(
						inner,
						rowPath(inner),
						status,
						colors,
					)
				: lang === 'filediff'
					? tokenizeFileDiff(
							inner,
							rowPath(inner),
							status,
							colors,
							width,
						)
					: trimmed
							.split('\n')
							.map(line => ({
								__isChunk: true as const,
								text: line,
								fg: themeColors(colors).fg.secondary,
							}));
	} else {
		switch (lang) {
			case 'bashrow':
				chunks = tokenizeBashRow(trimmed, status, colors);
				break;
			case 'diffrow':
				chunks = tokenizeDiffRow(trimmed, status, colors);
				break;
			case 'agentrow':
				chunks = tokenizeAgentRow(trimmed, status, colors);
				break;
			case 'taskrow':
				chunks = tokenizeTaskRow(trimmed, status, colors);
				break;
			case 'thought':
				chunks = tokenizeThought(trimmed, status, colors);
				break;
			case 'commandrow':
				chunks = tokenizeCommandRow(trimmed, status, colors);
				break;
			case 'filerow':
				chunks = tokenizeFileRow(
					trimmed,
					rowPath(trimmed),
					status,
					colors,
				);
				break;
			case 'filediff':
				chunks = tokenizeFileDiff(
					trimmed,
					rowPath(trimmed),
					status,
					colors,
					width,
				);
				break;
			default:
				chunks = tokenizeToolRow(trimmed, status, colors);
		}
	}
	const lines = splitChunksByLine(chunks);
	const [header, ...body] = lines;
	return {header: header ?? [], body};
}
