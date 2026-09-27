import {RGBA, createTextAttributes, type TextChunk} from '@opentui/core';
import type {Colors} from './theme';
import {
	bold,
	chunk,
	dim,
	emitLines,
	glyphColor,
	readableOn,
	type RowStatus,
} from './row-highlight';
import {languageForPath, themeColors, tokenizeCode} from './highlight';
import {capToolHeader, commonAffix, headerChunks} from './row-highlight-tools';

/**
 * File edit diff: `✦ Edit <path>` header, ` ⎿ N lines → N lines`, then
 * colored +/- rows with line numbers (green add / red remove / dim context).
 */
export function tokenizeFileDiff(
	text: string,
	path: string,
	status: RowStatus,
	colors: Colors,
	width = 0,
): TextChunk[] {
	const palette = themeColors(colors);
	const defaultFg = palette.fg.text;
	// Only real code files get syntax colors — .txt/unknown extensions stay
	// plain text (a `.txt` diff must never highlight `new` as a keyword).
	const language = languageForPath(path);
	// The fenced token text carries a leading blank line after the opener,
	// strip it so the header is line 0 and the body cursor stays aligned
	// (the parse loop indexes body rows from the same `lines` array).
	// TABS BREAK THE NATIVE LAYOUT: a `\t` in a text chunk makes OpenTUI
	// render a BLANK ROW after every tab-indented diff line (seen only in a
	// real terminal, not the test renderer). Expand tabs to spaces first —
	// the code's indentation is preserved (never flush) and the rows stay
	// contiguous.
	const lines = text
		.replace(/^\n+/, '')
		.replace(/\n+$/, '')
		.replace(/\t/g, '  ')
		.split('\n');
	const headerAt = lines.findIndex(line => line.trim() !== '');
	// Parse the diff BODY (everything after the `✦ Edit`/`⎿` header rows)
	// into structured rows so remove/add runs can be paired 1:1 like the
	// original DiffView, never diff a line against an arbitrary neighbor.
	interface DiffBodyRow {
		raw: string;
		kind: 'context' | 'remove' | 'add';
		indent: string;
		sigil?: string;
		number?: string;
		text: string;
		language: string;
		// Word-diff middle span (char offsets within `text`); absent when the
		// line is unpaired or too different to word-highlight (parity:
		// computeDiffLines' changeRatioThreshold).
		word?: [number, number];
	}
	const body: DiffBodyRow[] = [];
	let bodyLanguage = language;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (i === headerAt) {
			const fileHeader = line.match(
				/^(?:[✦⚙]\s*)?(?:[├└]\s+)?(?:Create|Edit|Delete|Move)\s+(.+?)(?:\s+→\s+(.+?))?\s+\(\+\d+\s+-\d+\)$/,
			);
			if (fileHeader)
				bodyLanguage = languageForPath(fileHeader[2] ?? fileHeader[1] ?? '');
			continue;
		}
		// ` ⎿ N lines → M lines` summary rows render through their own early
		// branch in the emit callback (they never consume a body entry).
		if (line.startsWith(' ⎿') || line.startsWith('  ⎿')) continue;
		const fileHeader = line.match(
			/^\s*(?:[├└]\s+)?(?:Create|Edit|Delete|Move)\s+(.+?)(?:\s+→\s+(.+?))?\s+\(\+\d+\s+-\d+\)$/,
		);
		if (fileHeader) {
			bodyLanguage = languageForPath(fileHeader[2] ?? fileHeader[1] ?? '');
			body.push({
				raw: line,
				kind: 'context',
				indent: '',
				text: line,
				language: bodyLanguage,
			});
			continue;
		}
		// Number-first gutter (parity: the reference DiffView):
		// `   5 + function …` / `   5 - function …`. The sigil takes EXACTLY
		// one separator space, so the code's own leading indentation (tabs
		// in real code) stays in `text` — a greedy `\s+` would swallow it
		// and the added lines would render flush at column 0.
		const change = line.match(/^(\s*)(\d+\s+)([-+]) (.*)$/);
		if (change) {
			body.push({
				raw: line,
				kind: change[3] === '+' ? 'add' : 'remove',
				indent: change[1] ?? '',
				sigil: change[3],
				number: change[2],
				text: change[4] ?? '',
				language: bodyLanguage,
			});
			continue;
		}
		const context = line.match(/^(\s*)(\d+\s+)(.*)$/);
		if (context) {
			body.push({
				raw: line,
				kind: 'context',
				indent: context[1] ?? '',
				number: context[2],
				text: context[3] ?? '',
				language: bodyLanguage,
			});
			continue;
		}
		// Stray rows (not a numbered context line) are opaque body rows,
		// they render dim and stay out of pairing.
		body.push({
			raw: line,
			kind: 'context',
			indent: '',
			text: line,
			language: bodyLanguage,
		});
	}
	// Pair adjacent remove/add runs 1:1, in order (removal[i] <-> addition[i]),
	// and mark only pairs within the 0.6 change-ratio threshold with a
	// word-level highlight (parity: nanocoder's emitChangeRun).
	{
		let runStart = 0;
		for (let i = 0; i <= body.length; i++) {
			const changed =
				i < body.length &&
				(body[i]?.kind === 'remove' || body[i]?.kind === 'add');
			if (changed) continue;
			const removals = body
				.slice(runStart, i)
				.filter(row => row.kind === 'remove');
			const additions = body
				.slice(runStart, i)
				.filter(row => row.kind === 'add');
			const pairCount = Math.min(removals.length, additions.length);
			for (let p = 0; p < pairCount; p++) {
				const oldRow = removals[p]!;
				const newRow = additions[p]!;
				const [pre, oldMiddle, post] = commonAffix(oldRow.text, newRow.text);
				const unchanged = pre.length + post.length;
				const ratio =
					1 - unchanged / Math.max(oldRow.text.length, newRow.text.length, 1);
				const oldEnd = pre.length + oldMiddle.length;
				const newEnd = newRow.text.length - post.length;
				if (ratio <= 0.6 && oldEnd > pre.length && newEnd > pre.length) {
					// Old/new changed spans can have different lengths. Reusing the
					// removal length for the addition clipped long replacements
					// (`getByLabel("To")` → `getByPlaceholder("you@example.com")`).
					oldRow.word = [pre.length, oldEnd];
					newRow.word = [pre.length, newEnd];
				}
			}
			runStart = i + 1;
		}
	}
	// Render a changed row: sigil + number on the row bg, code text with
	// syntax colors (row bg underneath), optional darker word bg on the
	// paired middle, and the row bg extended across the full width.
	const renderChange = (row: DiffBodyRow): TextChunk[] => {
		const kind = row.kind;
		const fg = kind === 'add' ? palette.fg.success : palette.fg.error;
		const rowBg = RGBA.fromHex(
			kind === 'add' ? colors.diffAdded : colors.diffRemoved,
		);
		const wordBg = RGBA.fromHex(
			kind === 'add' ? colors.diffAddedWord : colors.diffRemovedWord,
		);
		const text = row.text;
		// WRAP INSIDE THE CONTAINER: a diff line longer than the renderable
		// width must split into continuation pieces (indented to the code
		// column, row bg preserved) — leaving it to overflow makes the
		// TERMINAL wrap the orphan tail onto a phantom row (the
		// "additional lines" bug: unit tests never caught it because the
		// test renderer clips, but in the real TUI long diff rows painted
		// an extra line that vanished on resize). The continuation pieces
		// are joined with an embedded newline + the code-column indent, so
		// splitChunksByLine turns them into their own painted rows that
		// still carry the row/word background.
		const prefixLen =
			row.indent.length +
			(row.number ?? '').length +
			// The sigil emits WITH its trailing space (the parse regex
			// takes exactly one separator); without it `+const` glues to
			// the code.
			(row.sigil ? 2 : 0);
		const maxText = width > 0 ? Math.max(1, width - prefixLen) : text.length;
		// Split the row into width-budget PIECES; each piece keeps its own
		// word-diff segments (pre/mid/post within the piece), so the darker
		// word background only tints the changed middle, never the whole
		// wrapped line.
		const pieces: Array<Array<{text: string; word: boolean}>> = [];
		for (let offset = 0; offset < text.length; offset += maxText) {
			const piece = text.slice(offset, offset + maxText);
			const pieceEnd = offset + piece.length;
			const wordStart = row.word ? Math.max(offset, row.word[0]) : pieceEnd;
			const wordEnd = row.word ? Math.min(pieceEnd, row.word[1]) : pieceEnd;
			const segments: Array<{text: string; word: boolean}> = [];
			if (wordEnd > wordStart) {
				segments.push(
					{text: piece.slice(0, wordStart - offset), word: false},
					{text: piece.slice(wordStart - offset, wordEnd - offset), word: true},
					{text: piece.slice(wordEnd - offset), word: false},
				);
			} else {
				segments.push({text: piece, word: false});
			}
			pieces.push(segments.filter(segment => segment.text.length > 0));
		}
		if (pieces.length === 0) pieces.push([{text: '', word: false}]);
		const code: TextChunk[] = [];
		for (let i = 0; i < pieces.length; i++) {
			for (const part of pieces[i]!) {
				if (!part.text) continue;
				const chunks = row.language
					? tokenizeCode(part.text, row.language, palette, defaultFg)
					: [chunk(part.text, fg)];
				const partBg = part.word ? wordBg : rowBg;
				if (i > 0 && part === pieces[i]![0]) {
					// Continuation rows align their code with the parent's
					// code column (indent + number + sigil) and inherit the
					// row bg.
					code.push({
						...chunk(
							`\n${' '.repeat(prefixLen)}`,
							readableDiffFg(rowBg, defaultFg, colors),
						),
						bg: rowBg,
					});
				}
				code.push(
					...chunks.map(c => ({
						...c,
						// Readability guard: the syntax color (or the row fg)
						// must stay readable on the row/word background.
						fg: readableDiffFg(partBg, c.fg ?? fg, colors),
						bg: partBg,
					})),
				);
			}
		}
		const firstPieceLen = pieces[0]!.reduce(
			(sum, segment) => sum + segment.text.length,
			0,
		);
		const used =
			row.indent.length +
			(row.sigil ?? '').length +
			1 +
			(row.number ?? '').length +
			firstPieceLen;
		return fill(
			[
				{
					...chunk(row.indent, readableDiffFg(rowBg, defaultFg, colors)),
					bg: rowBg,
				},
				{
					...chunk(
						row.number ?? '',
						readableDiffFg(rowBg, palette.fg.secondary, colors),
					),
					bg: rowBg,
				},
				{
					...chunk(
						`${row.sigil ?? ''} `,
						readableDiffFg(rowBg, fg, colors),
						bold(),
					),
					bg: rowBg,
				},
				...code,
			],
			used,
		);
	};
	let bodyCursor = 0;
	// Context rows wrap the same way: a numbered unchanged line longer than
	// the renderable width splits with the code column re-indented, so no
	// row can overflow and wrap in the terminal.
	const contextChunks = (
		indent: string,
		number: string,
		text: string,
		rowLanguage = language,
	): TextChunk[] => {
		const prefixLen = indent.length + number.length;
		const maxText = width > 0 ? Math.max(1, width - prefixLen) : text.length;
		const out: TextChunk[] = [
			chunk(indent, defaultFg),
			chunk(number, palette.fg.secondary),
		];
		for (let offset = 0; offset < text.length; offset += maxText) {
			const piece = text.slice(offset, offset + maxText);
			if (offset > 0) {
				out.push(chunk(`\n${' '.repeat(prefixLen)}`, defaultFg));
			}
			out.push(
				...(rowLanguage
					? tokenizeCode(piece, rowLanguage, palette, defaultFg)
					: [chunk(piece, defaultFg)]),
			);
		}
		return out;
	};
	const fill = (chunks: TextChunk[], used: number): TextChunk[] => {
		if (width <= 0) return chunks;
		const padding = Math.max(0, width - used);
		return padding > 0
			? [
					...chunks,
					{...chunk(' '.repeat(padding), defaultFg), bg: chunks[0]?.bg},
				]
			: chunks;
	};
	return emitLines(
		lines,
		(line, index, isHeader) => {
			if (isHeader) {
				const patchFile = line.match(
					/^([✦⚙]\s*)?([├└]\s+)?(Create|Edit|Delete|Move)(\s+.+?)(\s+\(\+\d+)(\s+)(-\d+\))$/,
				);
				if (patchFile) {
					return [
						...(patchFile[1]
							? [chunk(patchFile[1], glyphColor(status, palette))]
							: []),
						...(patchFile[2]
							? [chunk(patchFile[2], palette.fg.secondary, dim())]
							: []),
						chunk(patchFile[3] ?? '', palette.fg.primary, bold()),
						chunk(patchFile[4] ?? '', defaultFg),
						chunk(patchFile[5] ?? '', palette.fg.success),
						chunk(patchFile[6] ?? '', defaultFg),
						chunk(patchFile[7] ?? '', palette.fg.error),
					];
				}
				// `✦ Edit <path>`, ONLY the action name (Edit) is primary bold;
				// the glyph is status-colored and the path stays secondary.
				// The path is capped to the renderable width (capToolHeader):
				// a long repo path overflows on narrow terminals and the
				// terminal wraps a phantom blank row after the header.
				const m = line.match(/^([✦⚙]\s*)([A-Za-z]+)(\s+.*)$/);
				if (m) {
					const capped = capToolHeader(
						m[1] ?? '',
						m[2] ?? '',
						m[3] ?? '',
						width,
					);
					return [
						chunk(capped.glyph, glyphColor(status, palette)),
						chunk(capped.name, palette.fg.primary, bold()),
						chunk(capped.rest, palette.fg.secondary),
					];
				}
				return headerChunks(line, status, palette, defaultFg);
			}
			if (line.startsWith(' ⎿') || line.startsWith('  ⎿')) {
				return [chunk(line, palette.fg.secondary, dim())];
			}
			const patchFile = line.match(
				/^(\s*)([├└]\s+)?(Create|Edit|Delete|Move)(\s+.+?)(\s+\(\+\d+)(\s+)(-\d+\))$/,
			);
			if (patchFile) {
				if (body[bodyCursor]?.raw === line) bodyCursor++;
				return [
					chunk(patchFile[1] ?? '', defaultFg),
					...(patchFile[2]
						? [chunk(patchFile[2], palette.fg.secondary, dim())]
						: []),
					chunk(patchFile[3] ?? '', palette.fg.primary, bold()),
					chunk(patchFile[4] ?? '', defaultFg),
					chunk(patchFile[5] ?? '', palette.fg.success),
					chunk(patchFile[6] ?? '', defaultFg),
					chunk(patchFile[7] ?? '', palette.fg.error),
				];
			}
			// Diff body rows: consume from the parsed list in order. Header and
			// summary rows do not consume a body entry (bodyCursor tracks only
			// rows that were parsed above).
			const row = body[bodyCursor];
			if (row && row.raw === line) {
				bodyCursor++;
				if (row.kind === 'context') {
					if (row.number !== undefined && row.text) {
						return contextChunks(
							row.indent,
							row.number,
							row.text,
							row.language,
						);
					}
					// Summary / opaque row.
					return [chunk(line, palette.fg.secondary, dim())];
				}
				return renderChange(row);
			}
			const context = line.match(/^(\s*)(\d+\s+)(.*)$/);
			if (context) {
				return contextChunks(
					context[1] ?? '',
					context[2] ?? '',
					context[3] ?? '',
				);
			}
			return fill([chunk(line, palette.fg.secondary, dim())], line.length);
		},
		defaultFg,
	);
}

/** Readable foreground for each diff background. */
function readableDiffFg(
	bg: RGBA,
	preferred: RGBA | undefined,
	colors: Colors,
): RGBA {
	return readableOn(
		bg,
		preferred,
		RGBA.fromHex(colors.text),
		RGBA.fromHex(colors.base),
	);
}

export {lineDiff} from './row-highlight-diff-algorithm';
export type {DiffLine} from './row-highlight-diff-algorithm';
