/**
 * Full-width row fill for transcript code blocks (diff rows, user messages).
 *
 * The markdown container sits inside the root's `paddingX={1}` (2 columns),
 * the scrollbox's content container adds `paddingRight={2}` (the scrollbar
 * gap), and the scrollbox reserves one column for its scrollbar, so a row
 * padded to `terminalWidth - 2` would WRAP (every logical line painting a
 * second blank row). The fill must target the renderable's real width: the
 * root padding, the right gap, and the scrollbar column.
 */
export function historyFillWidth(terminalWidth: number): number {
	return Math.max(1, terminalWidth - 5);
}
