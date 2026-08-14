import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {isDeleteKey} from './input-keys';

describe('isDeleteKey (shared backspace decoder)', () => {
	test('accepts every physical-Backspace encoding', () => {
		// Plain DEL (the usual OpenTUI name).
		expect(isDeleteKey({name: 'backspace'})).toBe(true);
		// `ESC[3~`, what some terminals/herdr clients send for Backspace.
		expect(isDeleteKey({name: 'delete'})).toBe(true);
		// herdr/ghostty NATIVE kitty encoding `ESC[104;5u` — OpenTUI parses
		// it as Ctrl+H, which IS the 0x08 backspace control char. This is
		// the exact bytes the user's physical Backspace key produces.
		expect(isDeleteKey({name: 'h', ctrl: true})).toBe(true);
		// Raw BS / DEL bytes that some parsers fall through to.
		expect(isDeleteKey({name: '\x08'})).toBe(true);
		expect(isDeleteKey({name: '\x7f'})).toBe(true);
	});

	test('never deletes on ordinary keys or a bare h', () => {
		for (const name of ['a', 'z', '0', ' ', 'return', 'escape', 'up']) {
			expect(isDeleteKey({name})).toBe(false);
		}
		// A bare `h` (no Ctrl) is a letter and MUST type, not delete.
		expect(isDeleteKey({name: 'h', ctrl: false})).toBe(false);
		expect(isDeleteKey({name: 'h'})).toBe(false);
		// Ctrl variants of OTHER letters are shortcuts, never deletes.
		expect(isDeleteKey({name: 'j', ctrl: true})).toBe(false);
		expect(isDeleteKey({name: 'c', ctrl: true})).toBe(false);
	});
});

/**
 * HARD REGRESSION GUARD for the recurring "backspace only works in the chat
 * box" bug: EVERY text input in the app must go through the shared
 * `isDeleteKey` decoder. A component that hand-rolls
 * `event.name === 'backspace'` silently loses the herdr kitty Ctrl+H
 * encoding (`ESC[104;5u`) and physical Backspace dies again in that input.
 */
describe('every input handler uses the shared isDeleteKey', () => {
	const sourceRoot = join(import.meta.dir); // src/
	const files: string[] = [
		...readdirSync(join(sourceRoot, 'components'))
			.filter(f => f.endsWith('.tsx') && !f.endsWith('.spec.tsx'))
			.map(f => join(sourceRoot, 'components', f)),
		...readdirSync(sourceRoot)
			.filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
			.filter(
				f =>
					!f.endsWith('.spec.ts') &&
					!f.endsWith('.spec.tsx') &&
					// input-keys.ts IS the shared definition — it is the one
					// place allowed to compare event.name to 'backspace'.
					f !== 'input-keys.ts',
			)
			.map(f => join(sourceRoot, f)),
	];
	const offenders: string[] = [];
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		// Matches `event.name === 'backspace'`, `== 'backspace'`,
		// `!== "backspace"`, etc. — any direct name comparison that bypasses
		// the shared decoder (which also handles herdr's kitty Ctrl+H).
		if (/event\.name\s*[!=]==?\s*['"]backspace['"]/.test(source)) {
			offenders.push(file);
		}
	}
	test('no component compares event.name to backspace directly', () => {
		expect(offenders).toEqual([]);
	});
});
