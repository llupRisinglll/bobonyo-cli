import {expect, test} from 'bun:test';
import {CONSOLE_TITLE, handleConsoleInput} from './console-controls';

test('visible console claims Escape; hidden console leaves cancellation alone', () => {
	let hidden = 0;
	const console = {visible: true, hide: () => hidden++, toggle: () => {}};
	expect(handleConsoleInput('\x1b', console)).toBe(true);
	expect(hidden).toBe(1);
	console.visible = false;
	expect(handleConsoleInput('\x1b', console)).toBe(false);
	expect(handleConsoleInput('hello', console)).toBe(false);
	expect(CONSOLE_TITLE).toContain('Esc hide');
});

test('F12 toggles console without forwarding key to input', () => {
	let toggles = 0;
	const console = {visible: false, hide: () => {}, toggle: () => toggles++};
	expect(handleConsoleInput('\x1b[24~', console)).toBe(true);
	expect(toggles).toBe(1);
});
