import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {KeyCodes} from '@opentui/core/testing';
import {SettingsListModal} from './components/settings-list-modal';

/**
 * RENDER-LEVEL guard for the modal-search Backspace bug: the chat box was
 * fixed to decode herdr's physical Backspace (kitty `ESC[104;5u`, parsed by
 * OpenTUI as Ctrl+H), but every modal search input still compared
 * `event.name === 'backspace'` directly — so Backspace silently stopped
 * working there. This mounts a REAL modal through the REAL test renderer
 * and feeds the EXACT herdr key bytes.
 */

function searchText(frame: CapturedFrame): string | null {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes('⌕')) return span.text;
		}
	}
	return null;
}

async function mountModal(onClose: () => void) {
	return testRender(
		() => (
			<SettingsListModal
				title="Test modal"
				rows={[
					{label: 'alpha'},
					{label: 'beta'},
					{label: 'gamma'},
				]}
				onClose={onClose}
			/>
		),
		{
			width: 80,
			height: 24,
			// herdr/ghostty speaks kitty CSI-u natively; the mock emits the
			// same physical encodings (Shift+Enter = ESC[13;2u, Backspace =
			// ESC[104;5u = Ctrl+H).
			kittyKeyboard: true,
		},
	);
}

describe('modal search input Backspace (herdr kitty encodings)', () => {
	test('herdr Ctrl+H, kitty BS and DELETE all erase the query; bare h still types', async () => {
		let closed = 0;
		const setup = await mountModal(() => {
			closed += 1;
		});
		try {
			const {mockInput} = setup;
			await mockInput.typeText('al');
			await setup.flush();
			expect(searchText(setup.captureSpans())).toBe('⌕ al');

			// herdr PHYSICAL Backspace = kitty Ctrl+H = ESC[104;5u.
			mockInput.pressKey('h', {ctrl: true});
			await setup.flush();
			expect(searchText(setup.captureSpans())).toBe('⌕ a');

			// kitty plain Backspace = ESC[8u (the \x08 path).
			mockInput.pressBackspace();
			await setup.flush();
			expect(searchText(setup.captureSpans())).toBe('⌕ search…');

			// DELETE sequence (`ESC[3~`) also erases backward.
			await mockInput.typeText('b');
			await setup.flush();
			expect(searchText(setup.captureSpans())).toBe('⌕ b');
			mockInput.pressKeys([KeyCodes.DELETE]);
			await setup.flush();
			expect(searchText(setup.captureSpans())).toBe('⌕ search…');

			// A bare `h` (no Ctrl) is a LETTER — it types, it never deletes.
			await mockInput.typeText('a');
			await setup.flush();
			mockInput.pressKey('h');
			await setup.flush();
			expect(searchText(setup.captureSpans())).toBe('⌕ ah');

			expect(closed).toBe(0);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('bracketed paste lands in the modal search, never the chat box behind it', async () => {
		let closed = 0;
		const setup = await mountModal(() => {
			closed += 1;
		});
		try {
			await setup.mockInput.pasteBracketedText('alpha');
			await setup.flush();
			expect(searchText(setup.captureSpans())).toBe('⌕ alpha');
			expect(closed).toBe(0);
		} finally {
			setup.renderer.destroy();
		}
	});
});
