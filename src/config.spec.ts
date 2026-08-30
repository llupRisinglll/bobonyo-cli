import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	applyProviderDeletion,
	codexClientVersion,
	discoverCodexAccountModels,
	discoverModels,
	effectiveContextWindow,
	listProviders,
	MODEL_CATALOG_TTL_MS,
	modelCatalogCachePath,
	modelsDevContextWindow,
	normalizeModels,
	type AppConfig,
	type ModelsDevCatalog,
} from './config';
import {bobonyoConfigDir, bobonyoDataDir} from './bobonyo-paths';

const ORIGINAL_PROVIDERS = process.env.NANOCODER_PROVIDERS;
const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;

afterEach(() => {
	if (ORIGINAL_PROVIDERS === undefined) delete process.env.NANOCODER_PROVIDERS;
	else process.env.NANOCODER_PROVIDERS = ORIGINAL_PROVIDERS;
	if (ORIGINAL_CONFIG_DIR === undefined)
		delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

describe('normalizeModels', () => {
	test('plain strings become names with no effort', () => {
		const {names, efforts} = normalizeModels(['a', 'b']);
		expect(names).toEqual(['a', 'b']);
		expect(efforts).toEqual({});
	});

	test('{name, effort} entries carry a per-model effort map', () => {
		const {names, efforts} = normalizeModels([
			{name: 'deepseek-v4-flash', effort: 'medium'},
			'plain-model',
			{name: 'gpt-5', effort: 'high'},
		]);
		expect(names).toEqual(['deepseek-v4-flash', 'plain-model', 'gpt-5']);
		expect(efforts).toEqual({
			'deepseek-v4-flash': 'medium',
			'gpt-5': 'high',
		});
	});

	test('empty catalog falls back to the mock model', () => {
		const {names} = normalizeModels([]);
		expect(names).toEqual(['mock-model-1']);
	});
});

describe('applyProviderDeletion (manage-step / /provider delete)', () => {
	const config = (): AppConfig => ({
		providers: [
			{id: 'codex', name: 'codex', baseUrl: 'https://api.openai.com/v1'},
			{id: 'DeepSeek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com'},
			{
				id: 'xiaomi',
				name: 'Xiaomi',
				baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
			},
		],
	});

	test('removes the provider case-insensitively and keeps the rest', () => {
		const {config: next} = applyProviderDeletion(config(), {}, 'deepseek');
		expect(next.providers.map(provider => provider.id)).toEqual([
			'codex',
			'xiaomi',
		]);
	});

	test('clears the saved last-provider preference when it points at the deleted id', () => {
		const {config: next, prefs} = applyProviderDeletion(
			config(),
			{lastProvider: 'DEEPSEEK', lastModel: 'deepseek-v4-flash'},
			'deepseek',
		);
		expect(next.providers.map(provider => provider.id)).not.toContain(
			'DeepSeek',
		);
		expect(prefs.lastProvider).toBeUndefined();
		expect(prefs.lastModel).toBeUndefined();
	});

	test('leaves the preference untouched when a different provider is deleted', () => {
		const {prefs} = applyProviderDeletion(
			config(),
			{lastProvider: 'codex', lastModel: 'gpt-5.4-mini'},
			'xiaomi',
		);
		expect(prefs).toEqual({
			lastProvider: 'codex',
			lastModel: 'gpt-5.4-mini',
		});
	});

	test('an unknown id is a no-op on the config', () => {
		const {config: next} = applyProviderDeletion(config(), {}, 'missing');
		expect(next.providers).toHaveLength(3);
	});
});

describe('modelsDevContextWindow (models.dev size lookup)', () => {
	test('reads the CURRENT schema: provider → model → limit.context', () => {
		const catalog: ModelsDevCatalog = {
			deepseek: {
				models: {
					'deepseek-chat': {limit: {context: 1_000_000}},
					'deepseek-reasoner': {limit: {context: 1_000_000}},
				},
			},
		};
		expect(modelsDevContextWindow(catalog, 'deepseek', 'deepseek-chat')).toBe(
			1_000_000,
		);
	});

	test('falls back to the legacy context_window field', () => {
		const catalog: ModelsDevCatalog = {
			'deepseek-chat': {context_window: 65_536},
		};
		expect(modelsDevContextWindow(catalog, 'deepseek', 'deepseek-chat')).toBe(
			65_536,
		);
	});

	test('finds a model across the WHOLE catalog when the provider id differs', () => {
		// Auto-discovery ids (deepseek-chat, mimo-v2.5-pro) can live under a
		// different provider key than the configured proxy id.
		const catalog: ModelsDevCatalog = {
			'my-deepseek-proxy': {models: {}},
			deepseek: {
				models: {'deepseek-chat': {limit: {context: 1_000_000}}},
			},
		};
		expect(
			modelsDevContextWindow(catalog, 'my-deepseek-proxy', 'deepseek-chat'),
		).toBe(1_000_000);
	});

	test('unknown models and zero limits resolve to undefined', () => {
		const catalog: ModelsDevCatalog = {
			deepseek: {
				models: {
					'deepseek-chat': {limit: {context: 0}},
				},
			},
		};
		expect(modelsDevContextWindow(catalog, 'deepseek', 'deepseek-chat')).toBe(
			undefined,
		);
		expect(modelsDevContextWindow(catalog, 'deepseek', 'gpt-5')).toBe(
			undefined,
		);
	});
});

describe('effectiveContextWindow', () => {
	test('declared provider limit wins over discovered model metadata', () => {
		expect(effectiveContextWindow(400_000, 1_048_576)).toBe(400_000);
	});

	test('uses discovery only when provider limit is missing', () => {
		expect(effectiveContextWindow(undefined, 1_048_576)).toBe(1_048_576);
		expect(effectiveContextWindow(undefined, undefined)).toBe(128_000);
	});
});

describe('listProviders (per-model effort)', () => {
	test('effort is derived from the model catalog, not an env var', () => {
		process.env.NANOCODER_CONFIG_DIR = '/tmp/bobonyo-config-spec';
		process.env.NANOCODER_PROVIDERS = JSON.stringify({
			providers: [
				{
					id: 'spec',
					baseUrl: 'http://127.0.0.1:9999',
					models: [{name: 'm1', effort: 'high'}, 'm2'],
				},
			],
		});
		const providers = listProviders();
		expect(providers.length).toBe(1);
		const provider = providers[0]!;
		expect(provider.models).toEqual(['m1', 'm2']);
		expect(provider.modelEfforts).toEqual({m1: 'high'});
	});
});

describe('MiMo token-plan model discovery', () => {
	test('auto-sets modelDiscoveryUrl to /v1/models for token-plan hosts', () => {
		process.env.NANOCODER_CONFIG_DIR = '/tmp/bobonyo-config-spec-mimo';
		process.env.NANOCODER_PROVIDERS = JSON.stringify({
			providers: [
				{
					id: 'Xiaomi',
					baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
					apiKey: 'tp-x',
					models: ['mimo-v2.5'],
				},
			],
		});
		const provider = listProviders()[0]!;
		expect(provider.baseUrl).toBe('https://token-plan-sgp.xiaomimimo.com');
		expect(provider.modelDiscoveryUrl).toBe(
			'https://token-plan-sgp.xiaomimimo.com/v1/models',
		);
	});

	test('other providers do not get an implicit discovery URL', () => {
		process.env.NANOCODER_CONFIG_DIR = '/tmp/bobonyo-config-spec-other';
		process.env.NANOCODER_PROVIDERS = JSON.stringify({
			providers: [
				{
					id: 'custom',
					baseUrl: 'https://relay.example.com/v1',
					models: ['m1'],
				},
			],
		});
		const provider = listProviders()[0]!;
		expect(provider.modelDiscoveryUrl).toBeUndefined();
	});
});

describe('discoverModels (full-URL contract)', () => {
	const ORIGINAL_DIR = process.env.NANOCODER_CONFIG_DIR;
	const configDir = `${tmpdir()}/bobonyo-config-spec-${Date.now()}`;
	beforeEach(() => {
		process.env.NANOCODER_CONFIG_DIR = configDir;
		mkdirSync(configDir, {recursive: true});
	});
	afterEach(() => {
		if (ORIGINAL_DIR === undefined) delete process.env.NANOCODER_CONFIG_DIR;
		else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_DIR;
		rmSync(configDir, {recursive: true, force: true});
	});

	test('fetches modelDiscoveryUrl AS-IS and never appends /v1/models', async () => {
		let requested = '';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested = String(input);
			return new Response(
				JSON.stringify({data: [{id: 'mimo-v2.5'}, {id: 'mimo-v2.5-pro'}]}),
				{status: 200},
			);
		}) as unknown as typeof fetch;
		try {
			const models = await discoverModels({
				id: 'Xiaomi',
				baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
				apiKeyResolved: 'tp-x',
				models: ['mimo-v2.5'],
				modelEfforts: {},
				alwaysAllow: [],
				modelDiscoveryUrl: 'https://token-plan-sgp.xiaomimimo.com/v1/models',
			});
			expect(requested).toBe('https://token-plan-sgp.xiaomimimo.com/v1/models');
			expect(models).toEqual(['mimo-v2.5', 'mimo-v2.5-pro']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('a fresh DISK cache skips the network entirely', async () => {
		writeFileSync(
			modelCatalogCachePath(),
			JSON.stringify({
				entries: {
					'https://api.openai.com/v1/models': {
						models: ['gpt-5.5', 'gpt-5.5-mini'],
						at: Date.now(),
					},
				},
			}),
			'utf8',
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error('fetch must not be called on a warm disk cache');
		}) as unknown as typeof fetch;
		try {
			const models = await discoverModels({
				id: 'openai',
				baseUrl: 'https://api.openai.com',
				apiKeyResolved: 'sk-x',
				models: ['seed'],
				modelEfforts: {},
				alwaysAllow: [],
				modelDiscoveryUrl: 'https://api.openai.com/v1/models',
			});
			expect(models).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('a FAILED token keeps the last known catalog (stale beats seeds)', async () => {
		writeFileSync(
			modelCatalogCachePath(),
			JSON.stringify({
				entries: {
					'https://openrouter.ai/api/v1/models': {
						models: ['openrouter/auto', 'deepseek/deepseek-v4'],
						at: Date.now() - MODEL_CATALOG_TTL_MS - 60_000,
					},
				},
			}),
			'utf8',
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({
			ok: false,
			status: 401,
		})) as unknown as typeof fetch;
		try {
			const models = await discoverModels({
				id: 'openrouter',
				baseUrl: 'https://openrouter.ai/api',
				apiKeyResolved: 'sk-bad',
				models: ['seed-model'],
				modelEfforts: {},
				alwaysAllow: [],
				modelDiscoveryUrl: 'https://openrouter.ai/api/v1/models',
			});
			expect(models).toEqual(['openrouter/auto', 'deepseek/deepseek-v4']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('no cache and a failed token falls back to the static seeds', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({
			ok: false,
			status: 401,
		})) as unknown as typeof fetch;
		try {
			const models = await discoverModels({
				id: 'openai',
				baseUrl: 'https://api.openai.com',
				apiKeyResolved: 'sk-bad',
				models: ['gpt-5.5'],
				modelEfforts: {},
				alwaysAllow: [],
				modelDiscoveryUrl: 'https://api.anthropic.com/v1/models',
			});
			expect(models).toEqual(['gpt-5.5']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('a successful fetch persists the catalog to the disk cache', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({data: [{id: 'mimo-v2.5'}]}), {
				status: 200,
			})) as unknown as typeof fetch;
		try {
			await discoverModels({
				id: 'xiaomi',
				baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
				apiKeyResolved: 'tp-x',
				models: ['mimo-v2.5'],
				modelEfforts: {},
				alwaysAllow: [],
				modelDiscoveryUrl: 'https://api.together.xyz/v1/models',
			});
			const saved = JSON.parse(
				readFileSync(modelCatalogCachePath(), 'utf8'),
			) as {entries: Record<string, {models: string[]; at: number}>};
			const savedModels =
				saved.entries['https://api.together.xyz/v1/models']?.models;
			expect(savedModels).toEqual(['mimo-v2.5']);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('codex ACCOUNT discovery uses the login token + account id', async () => {
		const codexHome = join(configDir, 'codex-home');
		mkdirSync(codexHome, {recursive: true});
		writeFileSync(
			join(codexHome, 'auth.json'),
			JSON.stringify({
				tokens: {access_token: 'tok-account', account_id: 'acc-1'},
			}),
			'utf8',
		);
		const prevHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = codexHome;
		let requested = '';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			requested = String(input);
			const headers = (init?.headers ?? {}) as Record<string, string>;
			expect(headers.authorization).toBe('Bearer tok-account');
			expect(headers['chatgpt-account-id']).toBe('acc-1');
			return new Response(
				JSON.stringify({
					models: [{slug: 'gpt-5.5'}, {slug: 'gpt-5.6-terra'}],
				}),
				{status: 200},
			);
		}) as unknown as typeof fetch;
		try {
			const models = await discoverCodexAccountModels(
				'https://chatgpt.com/backend-api/codex',
			);
			expect(models).toEqual(['gpt-5.5', 'gpt-5.6-terra']);
			expect(requested).toContain('/models?client_version=');
			const saved = JSON.parse(
				readFileSync(modelCatalogCachePath(), 'utf8'),
			) as {entries: Record<string, {models: string[]; at: number}>};
			expect(saved.entries[requested]?.models).toEqual([
				'gpt-5.5',
				'gpt-5.6-terra',
			]);
		} finally {
			globalThis.fetch = originalFetch;
			if (prevHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = prevHome;
		}
	});

	test('codexClientVersion resolves a semver (installed CLI or fallback)', () => {
		expect(codexClientVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe('bobonyo storage paths', () => {
	afterEach(() => {
		delete process.env.NANOCODER_CONFIG_DIR;
		delete process.env.NANOCODER_DATA_DIR;
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.XDG_DATA_HOME;
	});

	test('defaults to the bobonyo config/data dirs', () => {
		expect(bobonyoConfigDir()).toMatch(/\/bobonyo$/);
		expect(bobonyoDataDir()).toMatch(/\/bobonyo$/);
	});

	test('respects XDG overrides like the original', () => {
		process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
		process.env.XDG_DATA_HOME = '/tmp/xdg-data';
		expect(bobonyoConfigDir()).toBe('/tmp/xdg-config/bobonyo');
		expect(bobonyoDataDir()).toBe('/tmp/xdg-data/bobonyo');
	});

	test('first run MIGRATES the legacy nanocoder dir into bobonyo', () => {
		const xdgConfig = `${tmpdir()}/bobonyo-xdg-${Date.now()}`;
		mkdirSync(join(xdgConfig, 'nanocoder'), {recursive: true});
		writeFileSync(join(xdgConfig, 'nanocoder', 'legacy.txt'), 'x');
		const prevXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = xdgConfig;
		delete process.env.BOBONYO_CONFIG_DIR;
		delete process.env.NANOCODER_CONFIG_DIR;
		try {
			const dir = bobonyoConfigDir();
			expect(dir).toBe(join(xdgConfig, 'bobonyo'));
			expect(readFileSync(join(dir, 'legacy.txt'), 'utf8')).toBe('x');
		} finally {
			if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = prevXdg;
			rmSync(xdgConfig, {recursive: true, force: true});
		}
	});
});

describe('nanocoder agents.config.json format', () => {
	test('{nanocoder:{providers}} with name-only providers loads as ids', () => {
		process.env.NANOCODER_CONFIG_DIR = '/tmp/bobonyo-cfg-nc';
		process.env.NANOCODER_PROVIDERS = '';
		mkdirSync('/tmp/bobonyo-cfg-nc', {recursive: true});
		writeFileSync(
			'/tmp/bobonyo-cfg-nc/agents.config.json',
			JSON.stringify({
				nanocoder: {
					providers: [
						{
							name: 'Xiaomi',
							models: ['mimo-v2.5', 'mimo-v2.5-pro'],
							baseUrl: 'http://127.0.0.1:9998/v1',
							apiKey: 'k',
						},
					],
				},
			}),
			'utf8',
		);
		const providers = listProviders();
		expect(providers.length).toBe(1);
		expect(providers[0]?.id).toBe('Xiaomi');
		expect(providers[0]?.models).toEqual(['mimo-v2.5', 'mimo-v2.5-pro']);
	});
});
