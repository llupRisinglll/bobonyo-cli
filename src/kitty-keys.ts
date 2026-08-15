/**
 * Kitty keyboard protocol (CSI-u) → xterm modifyOtherKeys normalization.
 *
 * bobonyo enables the kitty keyboard protocol at startup so terminals that
 * support it report MODIFIED keys distinctly — most importantly Shift+Enter
 * as `\x1b[13;2u` instead of a plain `\r` that is byte-identical to Enter
 * (the per-pane Shift+Enter bug: some panes delivered shift-return, others
 * could not).
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
 * Enable sequences. BOTH are written, each terminal honors whichever it
 * implements:
 *  - `CSI >1u`  — kitty keyboard protocol (herdr, kitty, wezterm, foot,
 *    ghostty, iTerm2, windows-terminal).
 *  - `CSI >4;2m` — xterm modifyOtherKeys level 2 (tmux accepts ONLY this —
 *    it does not forward the kitty sequence to the outer terminal, so
 *    Shift+Enter inside tmux panes would stay a plain `\r` without it).
 */
export const KITTY_KEYBOARD_ENABLE = '\x1b[>1u';
export const MODIFY_OTHER_KEYS_ENABLE = '\x1b[>4;2m';
export const KITTY_KEYBOARD_DISABLE = '\x1b[<u';
export const MODIFY_OTHER_KEYS_DISABLE = '\x1b[<4;2m';

/**
 * Terminals KNOWN to implement extended key reporting correctly. The
 * allowlist guards against terminals that HONOR the enable sequence but
 * emit codepoints the parser cannot handle (xterm.js/VS Code, some SSH
 * wrappers) — enabling there silently breaks normal typing. herdr is the
 * primary target (verified: kitty backspace/Shift+Enter both work).
 * Mirrors the proven openclaude approach (OPENCLAUDE_ENABLE_EXTENDED_KEYS).
 */
const EXTENDED_KEYS_TERMINALS = [
	'herdr',
	'kitty',
	'wezterm',
	'ghostty',
	'foot',
	'iterm.app',
	'windows-terminal',
];

/** Whether extended key reporting is safe for the current terminal. */
export function supportsExtendedKeys(): boolean {
	// Explicit opt-out wins (troubleshooting / SSH / xterm.js hosts).
	if (process.env.BOBONYO_DISABLE_EXTENDED_KEYS === '1') return false;
	// herdr multiplexer: marks every pane with HERDR_ENV=1 (TERM_PROGRAM is
	// NOT set, only TERM=xterm-256color, so the marker is the only signal).
	// herdr implements both >1u and >4;2m (verified: kitty backspace and
	// Shift+Enter work), so panes inside herdr always get extended keys.
	if (process.env.HERDR_ENV === '1') return true;
	const term = process.env.TERM_PROGRAM?.toLowerCase() ?? '';
	if (EXTENDED_KEYS_TERMINALS.includes(term)) return true;
	// herdr also surfaces as TERM=herdr-direct / TERM=xterm-herdr.
	const termEnv = (process.env.TERM ?? '').toLowerCase();
	if (termEnv.includes('herdr')) return true;
	// Unlisted terminals default OFF — safe behavior over Shift+Enter.
	return false;
}

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
