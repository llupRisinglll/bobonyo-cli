import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	cachedDeepSeekModels,
	cacheStats,
	DEEPSEEK_BALANCE_TTL_MS,
	DEEPSEEK_MODELS_TTL_MS,
	fetchDeepSeekBalance,
	fetchDeepSeekModels,
	formatCacheHitLabel,
	formatCred,
	freshCachedBalance,
	freshCachedModels,
	isDeepSeek,
	isXiaomiMiMo,
	loadDeepSeekCache,
	refreshProviderModels,
	refreshDeepSeekBalance,
	refreshDeepSeekModels,
	resetDeepSeekInFlight,
	saveDeepSeekCache,
	shouldAlertCacheMiss,
	type DeepSeekBalance,
} from './deepseek';

const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;
let configDir: string;

/** Stub the global fetch without fighting bun's `typeof fetch` shape. */
function stubFetch(
	impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
	globalThis.fetch = impl as unknown as typeof fetch;
}

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'bobonyo-deepseek-spec-'));
	process.env.NANOCODER_CONFIG_DIR = configDir;
	resetDeepSeekInFlight();
});

afterEach(() => {
	if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	rmSync(configDir, {recursive: true, force: true});
});

describe('isDeepSeek', () => {
	test('detects the api.deepseek.com base URL', () => {
		expect(
			isDeepSeek({baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x'}),
		).toBe(true);
		expect(
			isDeepSeek({baseUrl: 'https://api.deepseek.com/', apiKey: 'sk-x'}),
		).toBe(true);
	});

	test('detects a deepseek provider id/name even with a custom base URL', () => {
		expect(isDeepSeek({id: 'DeepSeek', baseUrl: 'https://proxy.example.com'})).toBe(
			true,
		);
		expect(isDeepSeek({name: 'deepseek-via-ollama', baseUrl: 'http://localhost:11434'})).toBe(
			true,
		);
	});

	test('other providers are not deepseek', () => {
		expect(
			isDeepSeek({id: 'Xiaomi', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1'}),
		).toBe(false);
		expect(isDeepSeek({id: 'mock', baseUrl: 'http://127.0.0.1:4010'})).toBe(false);
	});
});

describe('isXiaomiMiMo', () => {
	test('detects the token-plan gateway host', () => {
		expect(
			isXiaomiMiMo({
				id: 'Xiaomi',
				baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
				apiKey: 'tp-x',
			}),
		).toBe(true);
		expect(
			isXiaomiMiMo({
				id: 'Xiaomi',
				baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
			}),
		).toBe(true);
	});

	test('detects a mimo/xiaomi provider id even with a custom base URL', () => {
		expect(isXiaomiMiMo({id: 'MiMo', baseUrl: 'https://proxy.example.com'})).toBe(
			true,
		);
		expect(isXiaomiMiMo({name: 'Xiaomi', baseUrl: 'https://relay.example.com'})).toBe(
			true,
		);
	});

	test('other providers are not mimo', () => {
		expect(
			isXiaomiMiMo({id: 'DeepSeek', baseUrl: 'https://api.deepseek.com'}),
		).toBe(false);
		expect(isXiaomiMiMo({id: 'mock', baseUrl: 'http://127.0.0.1:4010'})).toBe(false);
	});
});

describe('formatCred', () => {
	const balance = (overrides: Partial<DeepSeekBalance>): DeepSeekBalance => ({
		currency: 'USD',
		total: 12.3456,
		at: 0,
		...overrides,
	});

	test('USD renders Cred: $n with two decimals', () => {
		expect(formatCred(balance({total: 12.3456}))).toBe('Cred: $12.35');
		expect(formatCred(balance({total: 0.5}))).toBe('Cred: $0.50');
	});

	test('CNY uses the yen symbol', () => {
		expect(formatCred(balance({currency: 'CNY', total: 110}))).toBe('Cred: ¥110.00');
	});

	test('undefined balance renders nothing', () => {
		expect(formatCred(undefined)).toBeUndefined();
	});
});

describe('fetchDeepSeekModels', () => {
	test('parses the models list API', async () => {
		stubFetch(async () =>
			new Response(
				JSON.stringify({
					object: 'list',
					data: [
						{id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek'},
						{id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek'},
					],
				}),
				{status: 200},
			),
		);
		expect(await fetchDeepSeekModels('https://api.deepseek.com', 'sk-x')).toEqual([
			'deepseek-v4-flash',
			'deepseek-v4-pro',
		]);
	});

	test('throws on a non-2xx response', async () => {
		stubFetch(async () => new Response('nope', {status: 401}));
		await expect(
			fetchDeepSeekModels('https://api.deepseek.com', 'sk-bad'),
		).rejects.toThrow();
	});
});

describe('refreshProviderModels (MiMo catalog via the shared disk cache)', () => {
	const provider = {
		id: 'Xiaomi',
		baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
		apiKey: 'tp-x',
	};
	const modelsUrl = 'https://token-plan-sgp.xiaomimimo.com/v1/models';

	test('fetches /v1/models and persists to the DeepSeek cache file', async () => {
		stubFetch(async () =>
			new Response(
				JSON.stringify({
					object: 'list',
					data: [
						{id: 'mimo-v2.5', object: 'model', owned_by: 'xiaomi'},
						{id: 'mimo-v2.5-pro', object: 'model', owned_by: 'xiaomi'},
					],
				}),
				{status: 200},
			),
		);
		expect(await refreshProviderModels(provider, modelsUrl)).toEqual([
			'mimo-v2.5',
			'mimo-v2.5-pro',
		]);
		// The catalog lands in the same disk cache, keyed by base URL, so a
		// warm instance starts on real MiMo models without a fetch.
		expect(
			cachedDeepSeekModels(provider, Date.now()),
		).toEqual(['mimo-v2.5', 'mimo-v2.5-pro']);
	});

	test('fresh disk cache wins without a network call', async () => {
		const at = Date.now();
		saveDeepSeekCache({
			['token-plan-sgp.xiaomimimo.com']: {
				models: {ids: ['mimo-v2.5'], at},
			},
		});
		stubFetch(async () => {
			throw new Error('fetch must not be called for a fresh cache');
		});
		expect(await refreshProviderModels(provider, modelsUrl, at)).toEqual([
			'mimo-v2.5',
		]);
	});

	test('a failed fetch falls back to the static list', async () => {
		stubFetch(async () => new Response('nope', {status: 500}));
		expect(
			await refreshProviderModels(
				{...provider, models: ['mimo-v2.5-pro']},
				modelsUrl,
			),
		).toEqual(['mimo-v2.5-pro']);
	});
});

describe('fetchDeepSeekBalance', () => {
	test('prefers the USD balance info and converts string totals', async () => {
		stubFetch(async () =>
			new Response(
				JSON.stringify({
					is_available: true,
					balance_infos: [
						{currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00'},
						{currency: 'USD', total_balance: '15.25', granted_balance: '1.25', topped_up_balance: '14.00'},
					],
				}),
				{status: 200},
			),
		);
		const balance = await fetchDeepSeekBalance('https://api.deepseek.com', 'sk-x');
		expect(balance.currency).toBe('USD');
		expect(balance.total).toBe(15.25);
		expect(balance.granted).toBe(1.25);
		expect(balance.toppedUp).toBe(14);
		expect(balance.isAvailable).toBe(true);
	});

	test('throws when there are no balance_infos', async () => {
		stubFetch(async () =>
			new Response(JSON.stringify({is_available: false, balance_infos: []}), {
				status: 200,
			}),
		);
		await expect(
			fetchDeepSeekBalance('https://api.deepseek.com', 'sk-x'),
		).rejects.toThrow();
	});
});

describe('disk cache (TTL + atomic write + multi-instance freshness)', () => {
	const key = 'api.deepseek.com';

	test('fresh entries are served without a fetch', async () => {
		const at = Date.now();
		saveDeepSeekCache({
			[key]: {
				models: {ids: ['deepseek-v4-flash'], at},
				balance: {currency: 'USD', total: 9.99, at},
			},
		});
		stubFetch(async () => {
			throw new Error('fetch must not be called for a fresh cache');
		});
		expect(
			await refreshDeepSeekModels(
				{id: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x'},
				at,
			),
		).toEqual(['deepseek-v4-flash']);
		const balance = await refreshDeepSeekBalance(
			{id: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x'},
			at,
		);
		expect(balance?.total).toBe(9.99);
	});

	test('expired entries are refetched and persisted', async () => {
		const at = Date.now();
		const stale = at - DEEPSEEK_MODELS_TTL_MS - 1000;
		saveDeepSeekCache({
			[key]: {models: {ids: ['old-model'], at: stale}},
		});
		let calls = 0;
		stubFetch(async () => {
			calls += 1;
			return new Response(
				JSON.stringify({data: [{id: 'deepseek-v4-flash'}]}),
				{status: 200},
			);
		});
		const models = await refreshDeepSeekModels(
			{id: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x'},
			at,
		);
		expect(models).toEqual(['deepseek-v4-flash']);
		expect(calls).toBe(1);
		// The new catalog is now fresh on disk for the NEXT instance.
		expect(
			freshCachedModels(loadDeepSeekCache(), key, at + 1000),
		).toEqual(['deepseek-v4-flash']);
	});

	test('balance TTL is independent and shorter', async () => {
		const at = Date.now();
		saveDeepSeekCache({
			[key]: {
				models: {ids: ['deepseek-v4-flash'], at},
				balance: {currency: 'USD', total: 1.0, at: at - DEEPSEEK_BALANCE_TTL_MS - 1},
			},
		});
		// Models still fresh, balance expired.
		expect(freshCachedModels(loadDeepSeekCache(), key, at)).toEqual([
			'deepseek-v4-flash',
		]);
		expect(freshCachedBalance(loadDeepSeekCache(), key, at)).toBeUndefined();
	});

	test('cachedDeepSeekModels seeds the initial catalog from disk', () => {
		const at = Date.now();
		saveDeepSeekCache({
			[key]: {
				models: {ids: ['deepseek-v4-flash', 'deepseek-v4-pro'], at},
			},
		});
		expect(
			cachedDeepSeekModels(
				{id: 'DeepSeek', baseUrl: 'https://api.deepseek.com'},
				at,
			),
		).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
	});

	test('cachedDeepSeekModels is undefined when absent or stale', () => {
		const at = Date.now();
		expect(
			cachedDeepSeekModels({baseUrl: 'https://api.deepseek.com'}, at),
		).toBeUndefined();
		saveDeepSeekCache({
			[key]: {
				models: {ids: ['stale-model'], at: at - DEEPSEEK_MODELS_TTL_MS - 1},
			},
		});
		expect(
			cachedDeepSeekModels({baseUrl: 'https://api.deepseek.com'}, at),
		).toBeUndefined();
	});

	test('a failed balance fetch falls back to the stale cached value', async () => {
		const at = Date.now();
		saveDeepSeekCache({
			[key]: {
				balance: {
					currency: 'USD',
					total: 4.2,
					at: at - DEEPSEEK_BALANCE_TTL_MS - 5000,
				},
			},
		});
		stubFetch(async () => new Response('down', {status: 500}));
		const balance = await refreshDeepSeekBalance(
			{id: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x'},
			at,
		);
		expect(balance?.total).toBe(4.2);
	});

	test('parallel refreshes share one in-flight request', async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		stubFetch(async () => {
			calls += 1;
			await gate;
			return new Response(
				JSON.stringify({
					is_available: true,
					balance_infos: [{currency: 'USD', total_balance: '3.33'}],
				}),
				{status: 200},
			);
		});
		const provider = {
			id: 'DeepSeek',
			baseUrl: 'https://api.deepseek.com',
			apiKey: 'sk-x',
		};
		const first = refreshDeepSeekBalance(provider, Date.now());
		const second = refreshDeepSeekBalance(provider, Date.now());
		// Both calls are already awaiting the gated fetch; unblock it now.
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(a?.total).toBe(3.33);
		expect(b?.total).toBe(3.33);
		expect(calls).toBe(1);
	});

	test('the cache file is a complete JSON snapshot after save', () => {
		saveDeepSeekCache({
			[key]: {models: {ids: ['m1'], at: 1}},
		});
		const raw = readFileSync(join(configDir, 'deepseek-cache.json'), 'utf8');
		expect(JSON.parse(raw).entries[key].models.ids).toEqual(['m1']);
		// No stray temp files survive.
		expect(readdirSync(configDir).filter(file => file.endsWith('.tmp'))).toEqual([]);
	});
});

describe('prompt-cache stats', () => {
	test('extracts hit/miss from the usage block', () => {
		expect(
			cacheStats({prompt_cache_hit_tokens: 8000, prompt_cache_miss_tokens: 2000}),
		).toEqual({hit: 8000, miss: 2000, total: 10000, ratio: 0.8});
	});

	test('also reads the normalized snapshot keys (lastUsage/usageHistory)', () => {
		expect(
			cacheStats({promptCacheHitTokens: 8000, promptCacheMissTokens: 2000}),
		).toEqual({hit: 8000, miss: 2000, total: 10000, ratio: 0.8});
	});

	test('no cache fields means no stats (other providers)', () => {
		expect(cacheStats({prompt_tokens: 10, total_tokens: 20})).toBeUndefined();
		expect(cacheStats(undefined)).toBeUndefined();
	});

	test('alert only on a sizeable turn with a high miss share', () => {
		expect(shouldAlertCacheMiss(cacheStats({prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 9000}))).toBe(true);
		// Mostly hitting the cache is fine.
		expect(shouldAlertCacheMiss(cacheStats({prompt_cache_hit_tokens: 9000, prompt_cache_miss_tokens: 1000}))).toBe(false);
		// A tiny cold turn does not warn.
		expect(shouldAlertCacheMiss(cacheStats({prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 500}))).toBe(false);
		// A completely empty cache report never warns.
		expect(shouldAlertCacheMiss(cacheStats({prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0}))).toBe(false);
	});

	test('formatCacheHitLabel rounds to a percentage', () => {
		expect(
			formatCacheHitLabel(cacheStats({prompt_cache_hit_tokens: 875, prompt_cache_miss_tokens: 125})),
		).toBe('cache hit 88%');
		expect(formatCacheHitLabel(undefined)).toBeUndefined();
	});
});
