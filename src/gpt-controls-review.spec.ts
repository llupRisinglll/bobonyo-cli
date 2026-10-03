import {expect, test} from 'bun:test';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listProviders, savePreferences} from './config';
import {gptEfforts, validateGptEffort, restoredGptFast} from './gpt-controls';
import {activeEndpoint, setActiveEndpoint} from './state';
import {buildOpenAIRequestBody, streamChat} from './client';

test('request builder leaves unknown gateway Codex aliases provider-owned', () => {
	const body = buildOpenAIRequestBody([], [{name: 'read_file'}], {
		id: 'gateway',
		model: 'gpt-5.5-codex-high',
		baseUrl: 'https://gateway.test',
		effort: 'high',
	});
	expect(body.model).toBe('gpt-5.5-codex-high');
	expect(body.reasoning_effort).toBe('high');
});

test('modal Default clears cached effort for same-model switch and child override', async () => {
	const original = activeEndpoint();
	const originalFetch = globalThis.fetch;
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	const selection = app.slice(app.indexOf('const selectModel ='));
	const block = selection.slice(
		selection.indexOf('const previous ='),
		selection.indexOf('// Persist the chosen effort'),
	);
	const provider = {
		id: 'test',
		name: 'OpenAI',
		baseUrl: 'https://api.openai.com',
		apiKeyResolved: '',
		models: ['gpt-5.5', 'gpt-6-astra'],
		modelEfforts: {'gpt-5.5': 'minimal'},
		sdkProvider: 'responses',
	};
	const select = new Function(
		'provider',
		'model',
		'effort',
		'activeEndpoint',
		'setActiveEndpoint',
		'discoveredModels',
		'effectiveContextWindow',
		'modelWindows',
		'providerId',
		'restoredGptFast',
		'loadPreferences',
		block,
	);
	let body: Record<string, unknown> | undefined;
	globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
		body = JSON.parse(init.body as string);
		return new Response(
			'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
		);
	}) as typeof fetch;
	try {
		select(
			provider,
			'gpt-5.5',
			undefined,
			activeEndpoint,
			setActiveEndpoint,
			() => ({}),
			() => 128_000,
			() => ({}),
			'test',
			restoredGptFast,
			() => ({}),
		);
		expect(activeEndpoint().effort).toBeUndefined();
		expect(activeEndpoint().modelEfforts?.['gpt-5.5']).toBeUndefined();
		// /model same reads this exact cached map.
		setActiveEndpoint(previous => ({
			...previous,
			effort: previous.modelEfforts?.['gpt-5.5'],
		}));
		expect(activeEndpoint().effort).toBeUndefined();
		setActiveEndpoint(previous => ({
			...previous,
			model: 'gpt-6-astra',
			effort: 'max',
		}));
		await streamChat(
			[],
			{onText: () => {}, onReasoning: () => {}},
			undefined,
			[],
			undefined,
			undefined,
			undefined,
			'gpt-5.5',
		);
		expect(body?.reasoning).toEqual({summary: 'auto'});
	} finally {
		globalThis.fetch = originalFetch;
		setActiveEndpoint(original);
	}
});

test('Codex reasoning eligibility is independent of fast availability', () => {
	for (const model of ['gpt-5.2-codex', 'gpt-5.3-codex']) {
		expect(gptEfforts(model, true)).toEqual(['low', 'medium', 'high', 'xhigh']);
		expect(() =>
			validateGptEffort({model, codexAccount: true, effort: 'high'}),
		).not.toThrow();
	}
});

test('unknown gateway aliases remain provider-owned; known invalid efforts reject', () => {
	expect(() =>
		validateGptEffort({
			model: 'gpt-5.5-codex-high',
			baseUrl: 'https://gateway.test',
			effort: 'high',
		}),
	).not.toThrow();
	expect(() =>
		validateGptEffort({model: 'gpt-5.5', effort: 'minimal'}),
	).toThrow();
});

test('resume, provider edits and deletion never inherit paid fast mode', () => {
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	for (const marker of [
		'model: sessionModel,',
		'apiKey: resolveApiKey(provider.apiKey),',
		"model: next.models[0] ?? 'mock-model-1',",
	]) {
		const position = app.indexOf(marker);
		const start = app.lastIndexOf('setActiveEndpoint(', position);
		const end = app.indexOf('}));', position);
		const block = app.slice(start, end === -1 ? position + 1100 : end);
		expect(block).toContain('fastMode: undefined');
	}
});

test('/effort default clears invalid catalog effort rather than restoring it', () => {
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	const block = app.slice(
		app.indexOf('const applyEffort ='),
		app.indexOf('const switchEffort ='),
	);
	expect(block).toMatch(/level === 'default'\s*\? undefined/);
});

test('default effort recovery survives provider reload and restart', () => {
	const previousDirectory = process.env.BOBONYO_CONFIG_DIR;
	const previousProviders = process.env.BOBONYO_PROVIDERS;
	const directory = mkdtempSync(join(tmpdir(), 'gpt-default-'));
	try {
		process.env.BOBONYO_CONFIG_DIR = directory;
		process.env.BOBONYO_PROVIDERS = JSON.stringify({
			providers: [
				{
					id: 'openai-review',
					baseUrl: 'https://api.openai.com',
					models: [{name: 'gpt-5.5', effort: 'minimal'}],
				},
			],
		});
		expect(listProviders()[0]?.modelEfforts['gpt-5.5']).toBe('minimal');
		savePreferences({modelEfforts: {'openai-review\u0000gpt-5.5': 'default'}});
		expect(listProviders()[0]?.modelEfforts['gpt-5.5']).toBeUndefined();
	} finally {
		if (previousDirectory === undefined) delete process.env.BOBONYO_CONFIG_DIR;
		else process.env.BOBONYO_CONFIG_DIR = previousDirectory;
		if (previousProviders === undefined) delete process.env.BOBONYO_PROVIDERS;
		else process.env.BOBONYO_PROVIDERS = previousProviders;
		rmSync(directory, {recursive: true, force: true});
	}
});

test('isolated child model never inherits parent reasoning max or paid tier', async () => {
	const original = activeEndpoint();
	const originalFetch = globalThis.fetch;
	let body: Record<string, unknown> | undefined;
	globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
		body = JSON.parse(init.body as string);
		return new Response(
			'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
		);
	}) as typeof fetch;
	try {
		setActiveEndpoint({
			...original,
			model: 'gpt-6-astra',
			effort: 'max',
			fastMode: true,
			baseUrl: 'https://api.openai.com',
			sdkProvider: 'responses',
			modelEfforts: {'gpt-5.5': 'high'},
			codexAccount: false,
		});
		await streamChat(
			[],
			{onText: () => {}, onReasoning: () => {}},
			undefined,
			[],
			undefined,
			undefined,
			undefined,
			'gpt-5.5',
		);
		expect(body?.reasoning).toEqual({effort: 'high', summary: 'auto'});
		expect(body).not.toHaveProperty('service_tier');
	} finally {
		globalThis.fetch = originalFetch;
		setActiveEndpoint(original);
	}
});
