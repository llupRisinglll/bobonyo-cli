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
/**
 * Tokenizer fill budget for a tool row body, minus the 2-wide brief indent
 * box that FileToolRow prepends to every row when the entry carries a
 * pre-tool brief (`✦ ` = 2 cols, so the diff rows line up under the brief's
 * text column).
 *
 * Without the shrink the padded row is `fillWidth + 2` cells wide while the
 * renderable is only `fillWidth` — the TERMINAL wraps the 2-cell overflow
 * onto a phantom line after EVERY diff row (the "blank line between diff
 * rows" bug: seen only on briefed entries, and only in a real terminal,
 * because the OpenTUI test renderer clips instead of wrapping).
 */
export function toolRowFillWidth(
	terminalWidth: number,
	brief?: string,
): number {
	const fill = historyFillWidth(terminalWidth);
	// The indent box renders when the brief is non-empty OR the batch marker
	// (`' '`) — matching FileToolRow's `briefed() || batchBriefed`.
	return brief !== undefined && brief !== '' ? Math.max(1, fill - 2) : fill;
}
