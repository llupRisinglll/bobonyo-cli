/**
 * Description wrapping shared by the settings list modal and the `/`
 * command-suggestion popup: wrap a description to at most 2 lines, appending
 * `…` when it was truncated (parity: the reference truncates long
 * descriptions instead of clipping them mid-word).
 */
import {wrapText} from './text-wrap';

export function wrapDescription(text: string, width: number): string[] {
	const lines = wrapText(text, Math.max(1, width));
	const kept = lines.slice(0, 2);
	if (lines.length > 2) {
		const last = kept[1] ?? '';
		const trimmed = last.slice(0, Math.max(1, last.length - 3));
		kept[1] = `${trimmed}…`;
	}
	return kept;
}
