import {stripTerminalControl} from './bash';
import type {RowStatus} from './tool-display-types';

export const PREVIEW_COLLAPSED_LINES = 3;
export const PREVIEW_EXPANDED_LINES = 50;
export const PREVIEW_LINE_MAX_CHARS = 2000;
export const PREVIEW_MAX_ROWS = {
	collapsed: PREVIEW_COLLAPSED_LINES,
	expanded: PREVIEW_EXPANDED_LINES * 4,
} as const;

export function formatOutputTail(
	output: string,
	expanded: boolean,
	width = 84,
	prefix = '  └   ',
): string {
	const source = stripTerminalControl(output).replace(/^Error:\s*/, '');
	const lines = source
		.replace(/\r\n/g, '\n')
		.replace(/\s+$/, '')
		.split('\n')
		.filter(line => line !== '');
	if (lines.length === 0) return '';
	const cap = expanded ? PREVIEW_EXPANDED_LINES : PREVIEW_COLLAPSED_LINES;
	const tail = lines.slice(-cap);
	const hidden = lines.length - tail.length;
	const wrappedLines: string[] = [];
	for (const line of tail) {
		const preview =
			line.length > PREVIEW_LINE_MAX_CHARS
				? `${line.slice(0, PREVIEW_LINE_MAX_CHARS)}…`
				: line;
		for (const piece of wordWrap(preview, Math.max(1, width - 3)))
			wrappedLines.push(piece);
	}
	const maxRows = expanded
		? PREVIEW_MAX_ROWS.expanded
		: PREVIEW_MAX_ROWS.collapsed;
	const visibleRows = wrappedLines.slice(-maxRows);
	const hiddenRows = wrappedLines.length - visibleRows.length;
	const contPrefix = prefix === '  └   ' ? '      ' : '';
	const body = visibleRows
		.map((line, index) => `${index === 0 ? prefix : contPrefix}${line}`)
		.join('\n');
	const footerLines = hidden + hiddenRows;
	const footer =
		footerLines > 0
			? `\n… +${footerLines} more line${footerLines === 1 ? '' : 's'}`
			: '';
	return `${body}${footer}`;
}

export function wordWrap(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = '';
			}
			for (let i = 0; i < word.length; i += width)
				lines.push(word.slice(i, i + width));
			continue;
		}
		if (!current) {
			current = word;
			continue;
		}
		if (current.length + 1 + word.length <= width) current += ` ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

export function fence(
	language: string,
	status: RowStatus,
	content: string,
	extra = '',
): string {
	const fenceChar = content.includes('```') ? '````' : '```';
	return `${fenceChar}${language}:${status}${extra ? `:${extra}` : ''}\n\n${content.replace(/\n+$/, '')}\n${fenceChar}`;
}
