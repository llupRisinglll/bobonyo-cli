import {describe, expect, test} from 'bun:test';
import {parseKeypress} from '@opentui/core';
import {kittyToXterm} from './kitty-keys';

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
