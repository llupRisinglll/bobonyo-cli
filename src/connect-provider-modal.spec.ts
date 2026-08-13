import {describe, expect, test} from 'bun:test';
import {
	codexAccountProvider,
	codexApiKeyProvider,
	customProvider,
	filterConnectPicker,
} from './components/connect-provider-modal';

describe('filterConnectPicker (opencode-style provider list)', () => {
	const rows = [
		{kind: 'header' as const, label: 'Popular'},
		{kind: 'provider' as const, id: 'codex', connected: false},
		{kind: 'header' as const, label: 'Providers'},
		{kind: 'custom' as const},
	];

	test('an empty query keeps every row (headers + providers)', () => {
		expect(filterConnectPicker(rows, '')).toHaveLength(4);
	});

	test('matches provider labels, keeping their group headers', () => {
		expect(filterConnectPicker(rows, 'codex')).toEqual([
			{kind: 'header', label: 'Popular'},
			{kind: 'provider', id: 'codex', connected: false},
		]);
		expect(filterConnectPicker(rows, 'custom')).toEqual([
			{kind: 'header', label: 'Providers'},
			{kind: 'custom'},
		]);
	});

	test('no match returns the empty row (never a blank card)', () => {
		expect(filterConnectPicker(rows, 'anthropic')).toEqual([
			{kind: 'empty'},
		]);
	});
});

describe('connect provider payloads', () => {
	test('codexAccountProvider targets the ChatGPT Codex backend', () => {
		expect(codexAccountProvider()).toMatchObject({
			id: 'codex',
			name: 'Codex',
			baseUrl: 'https://chatgpt.com/backend-api/codex',
			sdkProvider: 'responses',
			codexAccount: true,
			contextWindow: 400_000,
		});
		expect(codexAccountProvider().models).toContain('gpt-5.5-codex');
	});

	test('codexApiKeyProvider targets the standard OpenAI responses API', () => {
		const provider = codexApiKeyProvider('sk-abc');
		expect(provider).toMatchObject({
			id: 'codex',
			baseUrl: 'https://api.openai.com/v1',
			sdkProvider: 'responses',
			apiKey: 'sk-abc',
			modelDiscoveryUrl: 'https://api.openai.com/v1/models',
		});
		expect(provider?.codexAccount).toBeUndefined();
	});

	test('codexApiKeyProvider rejects an empty key', () => {
		expect(codexApiKeyProvider('   ')).toBeNull();
	});

	test('customProvider requires id + base URL and keeps models', () => {
		expect(customProvider({id: '', baseUrl: 'x', models: []})).toBeNull();
		expect(customProvider({id: 'x', baseUrl: '', models: []})).toBeNull();
		const provider = customProvider({
			id: 'deepseek',
			baseUrl: 'https://api.deepseek.com/v1',
			apiKey: 'sk-1',
			models: ['deepseek-chat', 'deepseek-reasoner'],
		});
		expect(provider).toMatchObject({
			id: 'deepseek',
			name: 'deepseek',
			baseUrl: 'https://api.deepseek.com/v1',
			apiKey: 'sk-1',
			models: ['deepseek-chat', 'deepseek-reasoner'],
		});
	});
});
