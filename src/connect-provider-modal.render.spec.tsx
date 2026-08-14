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
	// Known presets carry discovery: the edit flow must NOT ask for models.
	modelDiscoveryUrl: 'https://api.deepseek.com/models',
};

function frameHas(frame: CapturedFrame, needle: string): boolean {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes(needle)) return true;
		}
	}
	return false;
}

describe('connect-provider edit flow (blank = keep, adaptive steps)', () => {
	test('a KNOWN preset with discovery skips BOTH the base-URL and models steps', async () => {
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

			// Select the existing connection → the edit form starts at the
			// API KEY step (the endpoint is a known preset, so the base-URL
			// step is skipped entirely).
			mockInput.pressEnter();
			await setup.flush();
			let frame = setup.captureSpans();
			expect(frameHas(frame, 'Base URL')).toBe(false);
			// custom-key: blank input, MASKED key placeholder, raw key must
			// never appear anywhere in the frame.
			expect(frameHas(frame, 'leave blank to keep sk-a…wxyz')).toBe(
				true,
			);
			expect(frameHas(frame, PROVIDER.apiKey)).toBe(false);

			// Discovery fetches the catalog, so the models step is skipped:
			// Enter goes STRAIGHT to the provider name.
			mockInput.pressEnter();
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, 'Models (comma-separated, optional)')).toBe(
				false,
			);
			expect(
				frameHas(frame, 'leave blank to keep deepseek'),
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

	test('a CUSTOM provider still goes through base-URL → key → models → name', async () => {
		process.env.BOBONYO_PROVIDERS = JSON.stringify({
			providers: [
				{
					...PROVIDER,
					id: 'my-gateway',
					name: 'my-gateway',
					baseUrl: 'https://my-gateway.example/v1',
					modelDiscoveryUrl: undefined,
				},
			],
		});
		const setup = await testRender(
			() => (
				<ConnectProviderModal
					editId="my-gateway"
					onConnect={() => {}}
					onClose={() => {}}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			await setup.flush();

			// Unmatched endpoint → the base-URL step is asked first.
			let frame = setup.captureSpans();
			expect(
				frameHas(
					frame,
					'leave blank to keep https://my-gateway.example',
				),
			).toBe(true);

			mockInput.pressEnter();
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, 'leave blank to keep sk-a…wxyz')).toBe(
				true,
			);

			// No discovery → the models step IS asked.
			mockInput.pressEnter();
			await setup.flush();
			frame = setup.captureSpans();
			expect(
				frameHas(
					frame,
					'leave blank to keep deepseek-v4-flash, deepseek-v4-pro',
				),
			).toBe(true);

			mockInput.pressEnter();
			await setup.flush();
			frame = setup.captureSpans();
			expect(frameHas(frame, 'leave blank to keep my-gateway')).toBe(
				true,
			);
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

describe('connect-provider paste handling', () => {
	test('paste lands in the modal field (API key), never the chat box behind it', async () => {
		process.env.BOBONYO_PROVIDERS = JSON.stringify({
			providers: [PROVIDER],
		});
		const setup = await testRender(
			() => (
				<ConnectProviderModal
					onConnect={() => {}}
					onClose={() => {}}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			const {mockInput} = setup;
			// Pick the connected preset, select the existing connection, and
			// land on the API key step (known preset → base step skipped).
			await mockInput.typeText('deepseek');
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			mockInput.pressEnter();
			await setup.flush();
			expect(frameHas(setup.captureSpans(), 'API key')).toBe(true);

			// Typing into the wizard field is VISIBLE (PromptField reads the
			// input accessor reactively — a plain value prop froze the
			// display: typed keys stored but never painted).
			await mockInput.typeText('ab');
			await setup.flush();
			expect(frameHas(setup.captureSpans(), '•')).toBe(true);
			expect(frameHas(setup.captureSpans(), 'leave blank to keep')).toBe(
				false,
			);

			// Bracketed paste inserts into the SECRET field (masked bullets),
			// and the raw pasted key must never appear in the frame.
			await mockInput.pasteBracketedText('sk-pasted123456');
			await setup.flush();
			const frame = setup.captureSpans();
			expect(frameHas(frame, '•'.repeat(10))).toBe(true);
			expect(frameHas(frame, 'sk-pasted123456')).toBe(false);
			expect(frameHas(frame, 'leave blank to keep')).toBe(false);
		} finally {
			delete process.env.BOBONYO_PROVIDERS;
			setup.renderer.destroy();
		}
	});
});
