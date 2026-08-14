/**
 * Whether an OpenTUI key event means DELETE-BACKWARD (backspace).
 *
 * ONE shared definition for EVERY text input in the app (chat box, modal
 * search boxes, wizard inputs). Terminals deliver the physical Backspace
 * key in several encodings and OpenTUI maps them to different event names:
 *
 * - `backspace`  — the usual `\x7f` (DEL) codepoint, OpenTUI's clean name;
 * - `delete`     — `ESC[3~`, which several terminals/herdr clients send for
 *                  the physical Backspace key;
 * - `{h, ctrl}`  — herdr/ghostty natively emits the KITTY CSI-u encoding
 *                  `ESC[104;5u` (codepoint 104 = `h`, modifier 5 = Ctrl)
 *                  even with `useKittyKeyboard: false`, and OpenTUI parses
 *                  it as Ctrl+H — which IS the 0x08 backspace control char;
 * - `\x08`       — the raw BS control byte some parsers fall through to;
 * - `\x7f`       — the raw DEL byte.
 *
 * Treating ALL of them as delete-backward is safe because the caret always
 * sits at the END of these single-line inputs (parity: the original
 * nanocoder text input). A bare `h` (no Ctrl) must NOT delete.
 */
export function isDeleteKey(event: {
	name: string;
	ctrl?: boolean;
}): boolean {
	return (
		event.name === 'backspace' ||
		event.name === 'delete' ||
		(event.name === 'h' && event.ctrl === true) ||
		event.name === '\x08' ||
		event.name === '\x7f'
	);
}
