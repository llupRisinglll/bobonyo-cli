import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {listProviders, normalizeModels} from './config';
import {nanocoderConfigDir, nanocoderDataDir} from './nanocoder-paths';

const ORIGINAL_PROVIDERS = process.env.NANOCODER_PROVIDERS;
const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;

afterEach(() => {
	if (ORIGINAL_PROVIDERS === undefined) delete process.env.NANOCODER_PROVIDERS;
	else process.env.NANOCODER_PROVIDERS = ORIGINAL_PROVIDERS;
	if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.NANOCODER_CONFIG_DIR;
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

describe('nanocoder storage paths', () => {
	afterEach(() => {
		delete process.env.NANOCODER_CONFIG_DIR;
		delete process.env.NANOCODER_DATA_DIR;
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.XDG_DATA_HOME;
	});

	test('defaults to the nanocoder config/data dirs (rename comes later)', () => {
		expect(nanocoderConfigDir()).toMatch(/\/nanocoder$/);
		expect(nanocoderDataDir()).toMatch(/\/nanocoder$/);
	});

	test('respects XDG overrides like the original', () => {
		process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
		process.env.XDG_DATA_HOME = '/tmp/xdg-data';
		expect(nanocoderConfigDir()).toBe('/tmp/xdg-config/nanocoder');
		expect(nanocoderDataDir()).toBe('/tmp/xdg-data/nanocoder');
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
