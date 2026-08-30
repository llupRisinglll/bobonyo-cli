import {describe, expect, test} from 'bun:test';

import {supportsNativeImageInput} from './vision';

describe('supportsNativeImageInput', () => {
	test('Codex account and API-key Responses models use native images', () => {
		expect(
			supportsNativeImageInput({
				id: 'codex',
				model: 'gpt-5.6-terra',
				sdkProvider: 'responses',
				codexAccount: true,
			}),
		).toBe(true);
		expect(
			supportsNativeImageInput({
				id: 'codex-key',
				model: 'gpt-5.5-codex',
				sdkProvider: 'responses',
			}),
		).toBe(true);
	});
	test('ordinary text-only providers keep the configured vision fallback', () => {
		expect(
			supportsNativeImageInput({
				id: 'deepseek',
				model: 'deepseek-v4-flash',
				sdkProvider: 'openai-compatible',
			}),
		).toBe(false);
	});
});
