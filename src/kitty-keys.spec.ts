import {describe, expect, test} from 'bun:test';
import {parseKeypress} from '@opentui/core';
import {
	KITTY_KEYBOARD_DISABLE,
	KITTY_KEYBOARD_ENABLE,
	MODIFY_OTHER_KEYS_DISABLE,
	MODIFY_OTHER_KEYS_ENABLE,
	kittyToXterm,
	supportsExtendedKeys,
} from './kitty-keys';

describe('kittyToXterm (kitty CSI-u → native modifyOtherKeys)', () => {
	test('Shift+Enter (kitty 13;2u) converts to the native shift-return form', () => {
		const converted = kittyToXterm('\x1b[13;2u');
		expect(converted).toBe('\x1b[27;2;13~');
		const key = parseKeypress(converted!);
		expect(key?.name).toBe('return');
		expect(key?.shift).toBe(true);
	});

	test('Ctrl+Enter (kitty 13;5u) converts to ctrl-return', () => {
		const converted = kittyToXterm('\x1b[13;5u');
		expect(converted).toBe('\x1b[27;5;13~');
		const key = parseKeypress(converted!);
		expect(key?.name).toBe('return');
		expect(key?.ctrl).toBe(true);
	});

	test('herdr Backspace (kitty 8u) converts to native backspace, never \\b', () => {
		// OpenTUI's own kitty parser names `\x1b[8u` as `\b` (control char)
		// — the bug that previously forced kitty mode off. The converted
		// xterm form parses to the real `backspace` name.
		const converted = kittyToXterm('\x1b[8u');
		expect(converted).toBe('\x1b[27;1;8~');
		const key = parseKeypress(converted!);
		expect(key?.name).toBe('backspace');
		expect(key?.shift).toBe(false);
	});

	test('DEL (kitty 127u) converts to backspace too', () => {
		const key = parseKeypress(kittyToXterm('\x1b[127u')!);
		expect(key?.name).toBe('backspace');
	});

	test('plain letters convert with the right modifier bit', () => {
		expect(kittyToXterm('\x1b[97u')).toBe('\x1b[27;1;97~');
		expect(kittyToXterm('\x1b[97;2u')).toBe('\x1b[27;2;97~');
		const shifted = parseKeypress('\x1b[27;2;97~');
		expect(shifted?.name).toBe('a');
		expect(shifted?.shift).toBe(true);
	});

	test('Tab / Space / Escape special keys keep their names', () => {
		expect(parseKeypress(kittyToXterm('\x1b[9u')!)?.name).toBe('tab');
		expect(parseKeypress(kittyToXterm('\x1b[32u')!)?.name).toBe('space');
		expect(parseKeypress(kittyToXterm('\x1b[27u')!)?.name).toBe('escape');
	});

	test('combined shift+ctrl modifier (kitty 5 → xterm 6)', () => {
		expect(kittyToXterm('\x1b[13;5u')).toBe('\x1b[27;5;13~');
		expect(kittyToXterm('\x1b[13;6u')).toBe('\x1b[27;6;13~');
	});

	test('colon-shifted variant (kitty `code:shifted;mods`) uses the base code', () => {
		// kitty sends `\x1b[97:65;2u` for Shift+a — base code 97, shift mod.
		expect(kittyToXterm('\x1b[97:65;2u')).toBe('\x1b[27;2;97~');
	});

	test('legacy sequences pass through untouched (null)', () => {
		for (const legacy of [
			'\r',
			'\n',
			'\x7f',
			'\x1b[27;2;13~', // already xterm modifyOtherKeys
			'\x1b[A', // arrow
			'a',
			'\x1b[3~', // delete
			'\x1bOM', // SS3 enter
		]) {
			expect(kittyToXterm(legacy)).toBeNull();
		}
	});
});

describe('supportsExtendedKeys (allowlist gate)', () => {
	const savedProgram = process.env.TERM_PROGRAM;
	const savedTerm = process.env.TERM;
	const savedDisable = process.env.BOBONYO_DISABLE_EXTENDED_KEYS;
	const restore = () => {
		process.env.TERM_PROGRAM = savedProgram;
		process.env.TERM = savedTerm;
		process.env.BOBONYO_DISABLE_EXTENDED_KEYS = savedDisable;
	};
	test('known terminals (herdr/kitty/wezterm/ghostty/foot) are enabled', () => {
		for (const term of ['herdr', 'kitty', 'WezTerm', 'ghostty', 'foot']) {
			process.env.TERM_PROGRAM = term;
			expect(supportsExtendedKeys()).toBe(true);
		}
		restore();
	});
	test('herdr panes are enabled via HERDR_ENV=1 (no TERM_PROGRAM set)', () => {
		// herdr sets ONLY TERM=xterm-256color + HERDR_ENV=1; without the
		// marker the pane looks like plain xterm and extended keys stay off
		// (the "new line is not working here" bug).
		delete process.env.TERM_PROGRAM;
		process.env.TERM = 'xterm-256color';
		process.env.HERDR_ENV = '1';
		expect(supportsExtendedKeys()).toBe(true);
		delete process.env.HERDR_ENV;
		expect(supportsExtendedKeys()).toBe(false);
		restore();
	});
	test('herdr via TERM (no TERM_PROGRAM) is enabled too', () => {
		delete process.env.TERM_PROGRAM;
		process.env.TERM = 'xterm-herdr';
		expect(supportsExtendedKeys()).toBe(true);
		restore();
	});
	test('unknown terminals default OFF (xterm.js/SSH safety)', () => {
		process.env.TERM_PROGRAM = 'vscode';
		expect(supportsExtendedKeys()).toBe(false);
		process.env.TERM_PROGRAM = 'xterm';
		expect(supportsExtendedKeys()).toBe(false);
		restore();
	});
	test('explicit BOBONYO_DISABLE_EXTENDED_KEYS=1 wins over allowlist', () => {
		process.env.TERM_PROGRAM = 'herdr';
		process.env.BOBONYO_DISABLE_EXTENDED_KEYS = '1';
		expect(supportsExtendedKeys()).toBe(false);
		restore();
	});
});

describe('enable/disable sequences (dual-protocol)', () => {
	test('kitty AND modifyOtherKeys are both exported for the enable write', () => {
		expect(KITTY_KEYBOARD_ENABLE).toBe('\x1b[>1u');
		expect(MODIFY_OTHER_KEYS_ENABLE).toBe('\x1b[>4;2m');
		expect(KITTY_KEYBOARD_DISABLE).toBe('\x1b[<u');
		expect(MODIFY_OTHER_KEYS_DISABLE).toBe('\x1b[<4;2m');
	});
});
