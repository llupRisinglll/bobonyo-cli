/**
 * Full-width row fill for transcript code blocks (diff rows, user messages).
 *
 * The markdown container sits inside the root's `paddingX={1}` (2 columns)
 * AND the scrollbox reserves one column for its scrollbar, so a row padded to
 * `terminalWidth - 2` is ONE column too wide and WRAPS, every logical line
 * then paints two screen rows (the second one blank), which looked like a
 * wall of line breaks. The fill must target the renderable's real width:
 * `terminalWidth - 3`.
 */
export function historyFillWidth(terminalWidth: number): number {
	return Math.max(1, terminalWidth - 3);
}
