import {describe, expect, test} from 'bun:test';
import {resolveContextWindow} from './context-window';

describe('context window discovery request sharing', () => {
	test('a cold model catalog fetches and parses metadata once for all models', async () => {
		const originalFetch = globalThis.fetch;
		const originalUrl = process.env.NANOCODER_MODELS_DEV_URL;
		process.env.NANOCODER_MODELS_DEV_URL = 'https://models.test/shared';
		let requests = 0;
		let parses = 0;
		globalThis.fetch = (async () => {
			requests++;
			await Promise.resolve();
			return {
				ok: true,
				json: async () => {
					parses++;
					return {provider: {models: {model: {limit: {context: 400_000}}}}};
				},
			} as Response;
		}) as unknown as typeof fetch;
		try {
			const windows = await Promise.all(
				Array.from({length: 100}, () =>
					resolveContextWindow('model', undefined, 'provider'),
				),
			);
			expect(windows.every(window => window === 400_000)).toBe(true);
			expect(requests).toBe(1);
			expect(parses).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl === undefined)
				delete process.env.NANOCODER_MODELS_DEV_URL;
			else process.env.NANOCODER_MODELS_DEV_URL = originalUrl;
		}
	});

	test('failed shared requests are released so the next refresh can retry', async () => {
		const originalFetch = globalThis.fetch;
		const originalUrl = process.env.NANOCODER_MODELS_DEV_URL;
		process.env.NANOCODER_MODELS_DEV_URL = 'https://models.test/retry';
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			if (requests === 1) throw new Error('offline');
			return new Response(
				JSON.stringify({
					provider: {models: {model: {limit: {context: 128_000}}}},
				}),
			);
		}) as unknown as typeof fetch;
		try {
			expect(
				await Promise.all(
					Array.from({length: 10}, () =>
						resolveContextWindow('model', undefined, 'provider'),
					),
				),
			).toEqual(Array(10).fill(undefined));
			expect(requests).toBe(1);
			expect(await resolveContextWindow('model', undefined, 'provider')).toBe(
				128_000,
			);
			expect(requests).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalUrl === undefined)
				delete process.env.NANOCODER_MODELS_DEV_URL;
			else process.env.NANOCODER_MODELS_DEV_URL = originalUrl;
		}
	});
});
