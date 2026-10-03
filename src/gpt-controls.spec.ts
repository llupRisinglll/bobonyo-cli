import {expect, test} from 'bun:test';
import {effortLevelsForModel} from './components/model-modal-helpers';
import {fastServiceTier, gptEfforts, supportsGptFast} from './gpt-controls';
import {buildOpenAIRequestBody, streamChat} from './client';
import {activeEndpoint, setActiveEndpoint} from './state';
import {commandNames, runCommand, type CommandContext} from './commands';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('GPT effort picker uses documented subsets, not guessed future ladders', () => {
	expect(effortLevelsForModel('gpt-5.5')).toEqual([
		'none',
		'low',
		'medium',
		'high',
		'xhigh',
	]);
	expect(effortLevelsForModel('gpt-6-astra')).toEqual([
		'low',
		'medium',
		'high',
		'xhigh',
		'max',
	]);
	expect(effortLevelsForModel('gpt-4.1')).toEqual([]);
	expect(effortLevelsForModel('gpt-6.9-future')).toEqual([]);
	expect(gptEfforts('gpt-5.6-sol', true)).not.toContain('none');
});

test('/fast visibility and dispatch follow active provider, not model name alone', () => {
	const original = activeEndpoint();
	try {
		setActiveEndpoint({
			...original,
			model: 'gpt-5.5',
			baseUrl: 'https://api.openai.com',
			sdkProvider: 'responses',
			codexAccount: false,
		});
		expect(commandNames()).toContain('fast');
		let argument: string | undefined;
		const ctx = {
			setFast: (args: string) => {
				argument = args;
			},
		};
		expect(runCommand('/fast on', ctx as CommandContext)).toBe(true);
		expect(argument).toBe('on');
		setActiveEndpoint(prev => ({...prev, baseUrl: 'https://opencode.ai/zen'}));
		expect(commandNames()).not.toContain('fast');
		argument = undefined;
		expect(runCommand('/fast on', ctx as CommandContext)).toBe(true);
		expect(argument).toBeUndefined();
	} finally {
		setActiveEndpoint(original);
	}
});

test('Chat Completions sends paid tier without altering selected effort', () => {
	const endpoint = {
		id: 'openai',
		model: 'gpt-5.5',
		baseUrl: 'https://api.openai.com',
		effort: 'high',
		fastMode: true,
	};
	const body = buildOpenAIRequestBody([], [], endpoint);
	expect(body.service_tier).toBe('priority');
	expect(body.reasoning_effort).toBe('high');
	expect(
		buildOpenAIRequestBody([], [], {...endpoint, fastMode: false}).service_tier,
	).toBe('default');
	expect(() =>
		buildOpenAIRequestBody([], [], {...endpoint, effort: 'minimal'}),
	).toThrow('Unsupported reasoning effort');
	expect(() =>
		buildOpenAIRequestBody([], [{name: 'read_file'}], {
			...endpoint,
			model: 'gpt-6-astra',
		}),
	).toThrow('requires the Responses transport');
});

test('Responses and Codex account send priority with reasoning intact', async () => {
	const originalEndpoint = activeEndpoint();
	const originalFetch = globalThis.fetch;
	const originalCodexHome = process.env.CODEX_HOME;
	const codexHome = mkdtempSync(join(tmpdir(), 'gpt-wire-auth-'));
	process.env.CODEX_HOME = codexHome;
	writeFileSync(
		join(codexHome, 'auth.json'),
		JSON.stringify({
			tokens: {access_token: 'test-token', account_id: 'test-account'},
		}),
	);
	const bodies: Record<string, unknown>[] = [];
	globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
		bodies.push(JSON.parse(init.body as string));
		return new Response(
			'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
			{headers: {'content-type': 'text/event-stream'}},
		);
	}) as typeof fetch;
	try {
		for (const codexAccount of [false, true]) {
			setActiveEndpoint({
				...originalEndpoint,
				id: 'gpt-wire-test',
				model: 'gpt-5.5',
				baseUrl: codexAccount
					? 'https://chatgpt.com/backend-api/codex'
					: 'https://api.openai.com',
				sdkProvider: 'responses',
				codexAccount,
				effort: 'high',
				fastMode: true,
			});
			await streamChat([], {onText: () => {}, onReasoning: () => {}});
		}
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body.service_tier).toBe('priority');
			expect(body.reasoning).toEqual({effort: 'high', summary: 'auto'});
			expect(body).not.toHaveProperty('reasoning_effort');
		}
		setActiveEndpoint(previous => ({
			...previous,
			model: 'gpt-5.6-sol',
			effort: 'ultra',
		}));
		await streamChat([], {onText: () => {}, onReasoning: () => {}});
		expect(bodies[2]?.reasoning).toEqual({effort: 'max', summary: 'auto'});
		expect(bodies[2]?.service_tier).toBe('priority');
	} finally {
		globalThis.fetch = originalFetch;
		setActiveEndpoint(originalEndpoint);
		if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = originalCodexHome;
		rmSync(codexHome, {recursive: true, force: true});
	}
});
test('fast tier supports actual OpenAI transports only', () => {
	const api = {model: 'gpt-5.5', baseUrl: 'https://api.openai.com'};
	expect(fastServiceTier({...api, fastMode: true})).toBe('priority');
	expect(fastServiceTier({...api, fastMode: false})).toBe('default');
	expect(fastServiceTier(api)).toBeUndefined();
	for (const endpoint of [
		{...api, model: 'claude-opus-5'},
		{...api, model: 'gpt-5.4-nano'},
		{...api, model: 'gpt-5.5-pro'},
		{...api, baseUrl: 'https://opencode.ai/zen'},
		{...api, sdkProvider: 'anthropic'},
		{...api, baseUrl: 'https://api.openai.com.evil.test'},
	]) {
		expect(supportsGptFast(endpoint)).toBe(false);
		expect(() => fastServiceTier({...endpoint, fastMode: true})).toThrow(
			'unsupported',
		);
	}
	expect(
		supportsGptFast({
			...api,
			baseUrl: 'https://chatgpt.com/backend-api/codex',
			codexAccount: true,
			sdkProvider: 'responses',
		}),
	).toBe(true);
});
