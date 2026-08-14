import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {ConnectProviderModal} from './components/connect-provider-modal';
import type {ProviderConfig} from './config';

/**
 * RENDER-LEVEL guard for the edit-existing-connection flow: entering a
 * CONNECTED provider (manage step → pick a connection) must NOT ask for
 * details with blank/empty fields. The inputs stay BLANK on purpose and the
 * old values appear as the PLACEHOLDER with a "leave blank to keep" note —
 * the API key placeholder masked (first/last few chars only). This mounts
 * the REAL modal with an injected provider config and walks the exact
 * pick → manage → edit key path.
 */

const PROVIDER = {
	id: 'deepseek',
	name: 'deepseek',
	baseUrl: 'https://api.deepseek.com',
	apiKey: 'sk-abc123456789wxyz',
	models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
};

function frameHas(frame: CapturedFrame, needle: string): boolean {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes(needle)) return true;
		}
	}
	return false;
}

describe('connect-provider edit flow (blank = keep, placeholder shows old value)', () => {
	test('selecting an existing connection shows leave-blank-to-keep placeholders and a masked key, then submits the unchanged values', async () => {
		process.env.BOBONYO_PROVIDERS = JSON.stringify({
			providers: [PROVIDER],
		});
		let submitted: ProviderConfig | undefined;
		let closed = 0;
		const setup = await testRender(
			() => (
				<ConnectProviderModal
					onConnect={provider => {
						submitted = provider;
					}}
					onClose={() => {
						closed += 1;
					}}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;

			// Pick the already-connected DeepSeek preset.
			await mockInput.typeText('deepseek');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'connections')).toBe(true);

			// Select the existing connection → the edit form starts.
			mockInput.pressEnter();
			await setup.flush();

			// custom-base: input BLANK, placeholder carries the old value.
			let frame = setup.captureSpans();
			expect(
				frameHas(frame, 'leave blank to keep https://api.deepseek.com'),
			).toBe(true);

			// custom-key: blank input, MASKED key placeholder, raw key
			// must never appear anywhere in the frame.
			mockInput.pressEnter();
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, 'leave blank to keep sk-a…wxyz')).toBe(
				true,
			);
			expect(frameHas(frame, PROVIDER.apiKey)).toBe(false);

			// custom-models: blank input, old models as the placeholder.
			mockInput.pressEnter();
			await setup.flush();
			expect(
				frameHas(
					setup.captureSpans(),
					'leave blank to keep deepseek-v4-flash, deepseek-v4-pro',
				),
			).toBe(true);

			// custom-name: blank input, old name as the placeholder.
			mockInput.pressEnter();
			await setup.flush();
			expect(
				frameHas(setup.captureSpans(), 'leave blank to keep deepseek'),
			).toBe(true);

			// Submit with every field still blank: the connection is saved
			// UNCHANGED (blank = keep), not wiped.
			mockInput.pressEnter();
			await setup.flush();
			expect(submitted).toEqual({
				...PROVIDER,
				models: PROVIDER.models,
			});
			expect(closed).toBe(0);
		} finally {
			delete process.env.BOBONYO_PROVIDERS;
			setup.renderer.destroy();
		}
	});
});

describe('connect-provider manage list navigation', () => {
	test('arrow keys move the selection to "Connect a new" and Enter starts the NEW-connection flow', async () => {
		process.env.BOBONYO_PROVIDERS = JSON.stringify({
			providers: [PROVIDER],
		});
		let closed = 0;
		const setup = await testRender(
			() => (
				<ConnectProviderModal
					onConnect={() => {}}
					onClose={() => {
						closed += 1;
					}}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await mockInput.typeText('deepseek');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();

			// Initially the existing connection is selected.
			let frame = setup.captureSpans();
			expect(frameHas(frame, '❯ deepseek')).toBe(true);
			expect(frameHas(frame, '❯ Connect a new DeepSeek')).toBe(false);

			// Down moves onto "Connect a new DeepSeek" (this froze before:
			// the active-row check was a non-reactive value captured at
			// render, so arrow keys never moved the list).
			mockInput.pressArrow('down');
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, '❯ Connect a new DeepSeek')).toBe(true);
			expect(frameHas(frame, '❯ deepseek')).toBe(false);

			// Up moves back to the existing connection.
			mockInput.pressArrow('up');
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, '❯ deepseek')).toBe(true);

			// Down again and Enter = a NEW connection: the preset API-key
			// step shows the fresh hint (NOT the edit placeholder).
			mockInput.pressArrow('down');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, 'sk-... or env:VAR')).toBe(true);
			expect(frameHas(frame, 'leave blank to keep')).toBe(false);
			expect(closed).toBe(0);
		} finally {
			delete process.env.BOBONYO_PROVIDERS;
			setup.renderer.destroy();
		}
	});
});
