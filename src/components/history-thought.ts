import {
	gearGlyph,
	workingDots,
	formatElapsed,
	expandedBlocks,
	thoughtExpanded,
	toolsExpanded,
} from '../state';
import {formatCount, formatDuration} from '../format';
import {fence} from '../tool-display';
import {wrapText} from '../text-wrap';

const PREVIEW_LINES = 3;
const THOUGHT_BODY_LEAD = '  └   ';
const THOUGHT_BODY_CONT = '      ';

/** Animated thinking header with spinner and elapsed timer. */
export function liveThinkingHeader(
	frame: number,
	elapsedSeconds: number,
): string {
	return `${gearGlyph(frame)} Thinking ${workingDots(frame)} (${formatElapsed(elapsedSeconds)})`;
}

/** Latest one-line reasoning tail, clipped to available width. */
export function liveThoughtOneLine(text: string, width: number): string {
	const max = Math.max(0, width - 4);
	const flat = text.replace(/\s*\n\s*/g, ' ').trim();
	if (flat.length <= max) return flat;
	return flat.slice(flat.length - max);
}

/** Wrap reasoning text inside tool-row indentation. */
export function wrapThoughtBody(text: string, width: number): string {
	if (!text.trim()) return '';
	const safe = Math.max(1, width);
	const contentWidth = Math.max(1, safe - THOUGHT_BODY_CONT.length);
	const wrapped: string[] = [];
	for (const line of text.replace(/\n+$/, '').split('\n')) {
		for (const piece of wrapText(line, contentWidth)) wrapped.push(piece);
	}
	if (wrapped.length === 0) return '';
	return wrapped
		.map(
			(piece, index) =>
				(index === 0 ? THOUGHT_BODY_LEAD : THOUGHT_BODY_CONT) + piece,
		)
		.join('\n');
}

/** Settled thought row with a compact preview unless expanded. */
export function settledThought(
	reasoningText: string,
	durationSec: number | undefined,
	key: string,
	width: number,
): string {
	const tokens = Math.max(1, Math.ceil(reasoningText.length / 4));
	const header =
		`⚙ Thought${durationSec ? ` (${formatDuration(durationSec)})` : ''}` +
		` · ~${formatCount(tokens)} tokens`;
	const body = wrapThoughtBody(reasoningText, width);
	const lines = body.split('\n');
	const expanded = expandedBlocks()[key] ?? thoughtExpanded();
	if (expanded || lines.length <= PREVIEW_LINES)
		return fence('thought', 'done', `${header}\n${body}`);
	const preview = lines.slice(0, PREVIEW_LINES).join('\n');
	return fence(
		'thought',
		'done',
		`${header}\n${preview}\n     … +${lines.length - PREVIEW_LINES} more lines`,
	);
}
