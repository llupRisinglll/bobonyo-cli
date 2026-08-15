import '@opentui/solid/preload';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/solid';
import type {CapturedFrame} from '@opentui/core';
import {ModelModal} from './components/model-modal';

/**
 * RENDER-LEVEL guard for the model modal's recent changes:
 * 1. The provider name lives on the CATEGORY header in parentheses
 *    (`(deepseek)` / `(codex) (current)`) — never repeated on every model
 *    cell (the earlier per-cell duplication was removed on request).
 * 2. Bracketed paste lands in the modal's search, not the chat box behind.
 */

const provider = (id: string, models: string[], baseUrl: string) => ({
	id,
	name: id,
	baseUrl,
	models,
	modelEfforts: {},
});

function frameHas(frame: CapturedFrame, needle: string): boolean {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes(needle)) return true;
		}
	}
	return false;
}

describe('model modal provider header + paste', () => {
	test('provider headers show the provider name in parentheses; cells stay clean', async () => {
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[
						provider(
							'codex',
							['gpt-5.4-mini'],
							'https://api.openai.com/v1',
						),
						provider(
							'deepseek',
							['deepseek-v4-flash'],
							'https://api.deepseek.com',
						),
					]}
					currentProvider="codex"
					currentModel="gpt-5.4-mini"
					onSelect={() => {}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			await setup.flush();
			const frame = setup.captureSpans();
			expect(frameHas(frame, '(Codex) (current)')).toBe(true);
			expect(frameHas(frame, '(DeepSeek)')).toBe(true);
			// The model cells do NOT repeat the provider per model.
			expect(frameHas(frame, 'gpt-5.4-mini(codex)')).toBe(false);
			expect(frameHas(frame, 'deepseek-v4-flash(deepseek)')).toBe(false);
		} finally {
			setup.renderer.destroy();
		}
	});

	test('bracketed paste lands in the model search', async () => {
		const setup = await testRender(
			() => (
				<ModelModal
					providers={[
						provider(
							'deepseek',
							['deepseek-v4-flash'],
							'https://api.deepseek.com',
						),
					]}
					currentProvider="deepseek"
					currentModel="deepseek-v4-flash"
					onSelect={() => {}}
					onConnectProvider={() => {}}
					onClose={() => {}}
					hasMessages={false}
				/>
			),
			{width: 80, height: 24, kittyKeyboard: true},
		);
		try {
			await setup.flush();
			await setup.mockInput.pasteBracketedText('deepseek');
			await setup.flush();
			// The search box shows the pasted query (the `⌕ ` and the query
			// render as separate spans, so check the query's own text); the
			// group header separately shows `(deepseek)`.
			const frame = setup.captureSpans();
			expect(frameHas(frame, 'deepseek▌')).toBe(true);
			expect(frameHas(frame, '(DeepSeek)')).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});
});
