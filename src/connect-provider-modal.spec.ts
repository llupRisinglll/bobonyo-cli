import {describe, expect, test} from 'bun:test';
import {
	buildPresetProvider,
	codexAccountProvider,
	codexApiKeyProvider,
	customProvider,
	defaultProviderName,
	deepseekProvider,
	filterConnectPicker,
	openAICompatibleProvider,
	PROVIDER_PRESETS,
	xiaomiProvider,
} from './components/connect-provider-modal';

const rows = PROVIDER_PRESETS.map(preset => ({
	kind: (preset.id === 'custom' ? 'custom' : 'provider') as 'provider' | 'custom',
	preset,
	connected: false,
}));

describe('filterConnectPicker (opencode-style provider list)', () => {
	test('an empty query keeps every preset', () => {
		expect(filterConnectPicker(rows, '')).toHaveLength(
			PROVIDER_PRESETS.length,
		);
	});

	test('matches preset titles case-insensitively', () => {
		const codex = filterConnectPicker(rows, 'codex');
		expect(codex).toHaveLength(1);
		expect(codex[0]!.preset?.id).toBe('codex');

		const deep = filterConnectPicker(rows, 'deepseek');
		expect(deep).toHaveLength(1);
		expect(deep[0]!.preset?.id).toBe('deepseek');
	});

	test('no match returns the empty row (never a blank card)', () => {
		expect(filterConnectPicker(rows, 'azure')).toEqual([
			{kind: 'empty'},
		]);
	});
});

describe('provider presets (known endpoints, never asked)', () => {
	test('every preset carries its endpoint so the modal never asks for it', () => {
		const presetIds = new Set(PROVIDER_PRESETS.map(preset => preset.id));
		expect(presetIds).toEqual(
			new Set([
				'codex',
				'openai',
				'anthropic',
				'openrouter',
				'deepseek',
				'xiaomi',
				'mistral',
				'xai',
				'groq',
				'cerebras',
				'together',
				'fireworks',
				'nvidia',
				'custom',
			]),
		);
		expect(
			PROVIDER_PRESETS.find(preset => preset.id === 'deepseek')?.baseUrl,
		).toBe('https://api.deepseek.com');
		expect(
			PROVIDER_PRESETS.find(preset => preset.id === 'xiaomi')?.baseUrl,
		).toBe('https://token-plan-sgp.xiaomimimo.com');
		expect(
			PROVIDER_PRESETS.find(preset => preset.id === 'anthropic')
				?.sdkProvider,
		).toBe('anthropic');
		expect(
			PROVIDER_PRESETS.find(preset => preset.id === 'openrouter')
				?.modelDiscoveryUrl,
		).toBe('https://openrouter.ai/api/v1/models');
	});

	test('every preset except custom is in a known group', () => {
		for (const preset of PROVIDER_PRESETS) {
			if (preset.id === 'custom') continue;
			expect(
				preset.category === 'Popular' || preset.category === 'Providers',
			).toBe(true);
			expect(preset.baseUrl).not.toBe('');
		}
	});

	test('codexAccountProvider targets the ChatGPT Codex backend', () => {
		expect(codexAccountProvider()).toMatchObject({
			id: 'codex',
			baseUrl: 'https://chatgpt.com/backend-api/codex',
			sdkProvider: 'responses',
			codexAccount: true,
			contextWindow: 400_000,
		});
		expect(codexAccountProvider('codex-pro').id).toBe('codex-pro');
	});

	test('codexApiKeyProvider targets the standard OpenAI responses API', () => {
		expect(codexApiKeyProvider('sk-abc')).toMatchObject({
			id: 'codex',
			baseUrl: 'https://api.openai.com/v1',
			sdkProvider: 'responses',
			apiKey: 'sk-abc',
			modelDiscoveryUrl: 'https://api.openai.com/v1/models',
		});
		expect(codexApiKeyProvider('sk-abc', 'codex-eu')!.id).toBe('codex-eu');
		expect(codexApiKeyProvider('   ')).toBeNull();
	});

	test('deepseekProvider knows the endpoint and seeds the standard models', () => {
		expect(deepseekProvider('deepseek', 'sk-1')).toMatchObject({
			id: 'deepseek',
			baseUrl: 'https://api.deepseek.com',
			apiKey: 'sk-1',
			modelDiscoveryUrl: 'https://api.deepseek.com/models',
			models: ['deepseek-chat', 'deepseek-reasoner'],
		});
		// Multiple instances under different names are allowed (model org).
		expect(deepseekProvider('deepseek-pro', 'sk-1').id).toBe('deepseek-pro');
	});

	test('xiaomiProvider seeds the token-plan gateway + mimo catalog', () => {
		expect(xiaomiProvider('xiaomi', 'tp-1')).toMatchObject({
			id: 'xiaomi',
			baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
			apiKey: 'tp-1',
		});
		expect(xiaomiProvider('xiaomi', 'tp-1').models).toContain('mimo-v2.5');
	});

	test('buildPresetProvider routes codex through the responses builder', () => {
		const codexPreset = PROVIDER_PRESETS.find(
			preset => preset.id === 'codex',
		)!;
		expect(buildPresetProvider(codexPreset, 'codex', 'sk-9')).toMatchObject({
			sdkProvider: 'responses',
			apiKey: 'sk-9',
		});
		const deepseekPreset = PROVIDER_PRESETS.find(
			preset => preset.id === 'deepseek',
		)!;
		expect(buildPresetProvider(deepseekPreset, 'ds', 'sk-1')?.id).toBe('ds');
		expect(buildPresetProvider(deepseekPreset, 'ds', '  ')).toBeNull();
	});

	test('openAICompatibleProvider keeps preset endpoint + discovery', () => {
		const openrouter = PROVIDER_PRESETS.find(
			preset => preset.id === 'openrouter',
		)!;
		expect(
			openAICompatibleProvider(openrouter, 'my-router', 'sk-1'),
		).toMatchObject({
			id: 'my-router',
			baseUrl: 'https://openrouter.ai/api',
			apiKey: 'sk-1',
			modelDiscoveryUrl: 'https://openrouter.ai/api/v1/models',
		});
	});

	test('customProvider requires id + base URL and keeps models', () => {
		expect(customProvider({id: '', baseUrl: 'x', models: []})).toBeNull();
		expect(customProvider({id: 'x', baseUrl: '', models: []})).toBeNull();
		const provider = customProvider({
			id: 'my-gateway',
			baseUrl: 'https://gateway.example.com/v1',
			apiKey: 'sk-1',
			models: ['a', 'b'],
		});
		expect(provider).toMatchObject({
			id: 'my-gateway',
			baseUrl: 'https://gateway.example.com/v1',
			apiKey: 'sk-1',
			models: ['a', 'b'],
		});
	});
});

describe('defaultProviderName ((n) duplicate suffix)', () => {
	test('free default id stays as-is', () => {
		expect(defaultProviderName('deepseek', [])).toBe('deepseek');
	});

	test('taken id gets a (2) suffix, then (3), never clobbering', () => {
		const existing = [{id: 'deepseek'}, {id: 'deepseek (2)'}];
		expect(defaultProviderName('deepseek', existing)).toBe('deepseek (3)');
	});

	test('case-insensitive duplicate detection', () => {
		expect(defaultProviderName('DeepSeek', [{id: 'deepseek'}])).toBe(
			'DeepSeek (2)',
		);
	});
});
