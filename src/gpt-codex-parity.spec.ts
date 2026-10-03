import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	gptEfforts,
	supportsGptFast,
	gptEffortForRequest,
	restoredGptFast,
} from './gpt-controls';
import {listProviders, savePreferences} from './config';

test('Codex Sol and Terra expose catalog ultra; Luna stops at max', () => {
	for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra']) {
		expect(gptEfforts(model, true)).toEqual([
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
			'ultra',
		]);
	}
	expect(gptEfforts('gpt-5.6-luna', true)).toEqual([
		'low',
		'medium',
		'high',
		'xhigh',
		'max',
	]);
});

test('Codex fast eligibility follows local catalog service tiers', () => {
	const account = {
		baseUrl: 'https://chatgpt.com/backend-api/codex',
		sdkProvider: 'responses',
		codexAccount: true,
	};
	for (const model of [
		'gpt-5.6-sol',
		'gpt-5.6-terra',
		'gpt-5.6-luna',
		'gpt-5.5',
		'gpt-5.4',
	]) {
		expect(supportsGptFast({...account, model})).toBe(true);
	}
	for (const model of [
		'gpt-5.4-mini',
		'gpt-5.2',
		'gpt-6-astra',
		'claude-opus-4',
	]) {
		expect(supportsGptFast({...account, model})).toBe(false);
	}
});

test('saved explicit effort wins over configured catalog on reload', () => {
	const oldDirectory = process.env.BOBONYO_CONFIG_DIR;
	const oldProviders = process.env.BOBONYO_PROVIDERS;
	const directory = mkdtempSync(join(tmpdir(), 'gpt-codex-parity-'));
	try {
		process.env.BOBONYO_CONFIG_DIR = directory;
		process.env.BOBONYO_PROVIDERS = JSON.stringify({
			providers: [
				{
					id: 'codex-parity',
					baseUrl: 'https://api.openai.com',
					models: [{name: 'gpt-5.5', effort: 'low'}],
				},
			],
		});
		savePreferences({modelEfforts: {'codex-parity\u0000gpt-5.5': 'xhigh'}});
		expect(listProviders()[0]?.modelEfforts['gpt-5.5']).toBe('xhigh');
	} finally {
		if (oldDirectory === undefined) delete process.env.BOBONYO_CONFIG_DIR;
		else process.env.BOBONYO_CONFIG_DIR = oldDirectory;
		if (oldProviders === undefined) delete process.env.BOBONYO_PROVIDERS;
		else process.env.BOBONYO_PROVIDERS = oldProviders;
		rmSync(directory, {recursive: true, force: true});
	}
});

test('Codex ultra requests max and saved fast choice never leaks to other providers', () => {
	expect(gptEffortForRequest('ultra', true)).toBe('max');
	expect(gptEffortForRequest('high', true)).toBe('high');
	const endpoint = {model: 'gpt-5.4', baseUrl: 'https://api.openai.com'};
	expect(restoredGptFast(endpoint, 'priority')).toBe(true);
	expect(restoredGptFast(endpoint, 'default')).toBe(false);
	expect(
		restoredGptFast({...endpoint, baseUrl: 'https://gateway.test'}, 'priority'),
	).toBeUndefined();
	expect(
		restoredGptFast({...endpoint, model: 'claude-opus-4'}, 'priority'),
	).toBeUndefined();
});
