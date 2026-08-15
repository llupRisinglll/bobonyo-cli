/**
 * Kitty keyboard protocol (CSI-u) → xterm modifyOtherKeys normalization.
 *
 * bobonyo ENABLES the kitty keyboard protocol at startup (`CSI > 1 u`) so
 * terminals that support it (herdr, kitty, wezterm, foot, ghostty) report
 * MODIFIED keys distinctly — most importantly Shift+Enter as `\x1b[13;2u`
 * instead of a plain `\r` that is byte-identical to Enter (the per-pane
 * Shift+Enter bug: some panes delivered shift-return, others could not).
 *
 * OpenTUI's OWN kitty parser mis-maps some CSI-u shapes (herdr backspace
 * arrives as `\x1b[8u` and OpenTUI names it `\b`, NOT `backspace` — the
 * reason kitty mode was previously disabled), so this module converts every
 * CSI-u sequence to the xterm modifyOtherKeys form `\x1b[27;mod;code~`,
 * which OpenTUI's NATIVE parser handles correctly for every key.
 *
 * Kitty stores the modifier mask with a +1 OFFSET (0 = none, 1 = shift,
 * 2 = alt, 4 = ctrl, … — same bits as OpenTUI's fromKittyMods(mod - 1)).
 * xterm modifier: 1 + shift + 2*alt + 4*ctrl.
 */
export const KITTY_CSI_U = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+))?u$/;

/**
 * Convert a raw kitty CSI-u sequence to the xterm modifyOtherKeys sequence
 * OpenTUI parses natively. Returns null when the input is NOT a kitty key
 * (legacy sequences pass through untouched). Pure, unit-tested.
 */
export function kittyToXterm(raw: string): string | null {
	const match = KITTY_CSI_U.exec(raw);
	if (!match) return null;
	const code = parseInt(match[1] ?? '', 10);
	// kitty offset mask: stored value minus 1 (missing field = no modifiers).
	const stored = match[2] ? parseInt(match[2], 10) : 0;
	const mask = Math.max(0, stored - 1);
	const mod =
		1 +
		(mask & 1 ? 1 : 0) + // shift
		(mask & 2 ? 2 : 0) + // alt
		(mask & 4 ? 4 : 0); // ctrl
	return `\x1b[27;${mod};${code}~`;
}
