import {RGBA, createTextAttributes, type TextChunk} from '@opentui/core';
import type {Colors} from './theme';
import type {Palette, RowStatus} from './row-highlight';
import {glyphColor} from './row-highlight';

function chunk(text: string, fg: RGBA | undefined, attributes = 0): TextChunk {
	return {__isChunk: true, text, ...(fg ? {fg} : {}), attributes};
}

function bold(): number {
	return createTextAttributes({bold: true});
}

/**
 * Cap tool headers at renderable width, preserving filename and action.
 */
export function capToolHeader(
	glyph: string,
	name: string,
	rest: string,
	width: number,
): {glyph: string; name: string; rest: string} {
	if (width <= 0) return {glyph, name, rest};
	const budget = Math.max(1, width - glyph.length - name.length);
	if (rest.length <= budget) return {glyph, name, rest};
	const slash = rest.lastIndexOf('/');
	const tail = slash === -1 ? rest : rest.slice(slash + 1);
	let capped = ` …${tail}`;
	if (capped.length > budget) {
		capped = ` ${tail.slice(-Math.max(1, budget - 1))}`;
	}
	return {glyph, name, rest: capped};
}

/** Longest unchanged prefix and suffix of a pair of changed lines. */
export function commonAffix(
	a: string,
	b: string,
): [prefix: string, middle: string, suffix: string] {
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	const prefix = a.slice(0, p);
	let s = 0;
	while (
		s < a.length - p &&
		s < b.length - p &&
		a[a.length - 1 - s] === b[b.length - 1 - s]
	) {
		s++;
	}
	const suffix = s > 0 ? a.slice(a.length - s) : '';
	const middle = a.slice(p, a.length - s);
	return [prefix, middle, suffix];
}

/** Color compact `Ran Tool ×N and Tool (hint)` headers. */
export function groupHeaderChunks(
	line: string,
	status: RowStatus,
	palette: Palette,
	headerChunks: (
		line: string,
		status: RowStatus,
		palette: Palette,
		defaultFg: RGBA,
	) => TextChunk[],
): TextChunk[] {
	const m = line.match(/^([✦⚙]\s*)?(Ran\s+)(.*)$/);
	if (!m) return headerChunks(line, status, palette, palette.fg.text);
	const chunks: TextChunk[] = [];
	if (m[1]) chunks.push(chunk(m[1], glyphColor(status, palette)));
	chunks.push(chunk(m[2] ?? '', palette.fg.text));
	const rest = m[3] ?? '';
	const hintAt = rest.search(/\(ctrl-o|\(ctrl \+ t/);
	const hintStart =
		hintAt === -1
			? -1
			: hintAt > 0 && rest[hintAt - 1] === ' '
				? hintAt - 1
				: hintAt;
	const names = hintStart === -1 ? rest : rest.slice(0, hintStart);
	const hint = hintStart === -1 ? '' : rest.slice(hintStart);
	for (const token of names.trim().split(/( and |, | ×\d+)/)) {
		if (!token) continue;
		if (/^( and |, | ×\d+)$/.test(token) || /^\s+$/.test(token)) {
			chunks.push(chunk(token, palette.fg.text));
		} else {
			chunks.push(chunk(token, palette.fg.primary, bold()));
		}
	}
	if (hint) chunks.push(chunk(hint, palette.fg.secondary));
	return chunks;
}

/** `✦ Name(detail)` header: glyph by status, name primary bold, detail secondary. */
export function headerChunks(
	line: string,
	status: RowStatus,
	palette: Palette,
	defaultFg: RGBA,
	inside?: (text: string) => TextChunk[],
): TextChunk[] {
	const chunks: TextChunk[] = [];
	let rest = line;
	const glyph = rest.match(/^[✦⚙]\s*/);
	if (glyph) {
		chunks.push(chunk(glyph[0], glyphColor(status, palette)));
		rest = rest.slice(glyph[0].length);
	}
	const open = rest.indexOf('(');
	if (open === -1) {
		chunks.push(chunk(rest, palette.fg.primary, bold()));
		return chunks;
	}
	chunks.push(chunk(rest.slice(0, open), palette.fg.primary, bold()));
	chunks.push(chunk('(', palette.fg.secondary));
	const inner = rest.slice(open + 1);
	const close = inner.lastIndexOf(')');
	if (close === -1) {
		chunks.push(...(inside ? inside(inner) : [chunk(inner, defaultFg)]));
		return chunks;
	}
	const content = inner.slice(0, close);
	chunks.push(...(inside ? inside(content) : [chunk(content, defaultFg)]));
	chunks.push(chunk(')', palette.fg.secondary));
	const tail = inner.slice(close + 1);
	if (tail) chunks.push(chunk(tail, palette.fg.secondary));
	return chunks;
}
