import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	codexAuthPath,
	codexAuthSummary,
	hasCodexApiKey,
	hasCodexChatgptAuth,
	readCodexAuth,
} from './codex-auth';

const HOME = join(tmpdir(), `bobonyo-codex-auth-${Date.now()}`);

afterEach(() => {
	rmSync(HOME, {recursive: true, force: true});
	delete process.env.CODEX_HOME;
	delete process.env.OPENAI_API_KEY;
	delete process.env.CODEX_API_KEY;
});

function writeAuth(json: unknown): void {
	mkdirSync(HOME, {recursive: true});
	writeFileSync(join(HOME, 'auth.json'), JSON.stringify(json));
}

describe('codex-auth (codex login interop)', () => {
	test('reads the ChatGPT-account OAuth shape (tokens.access_token)', () => {
		process.env.CODEX_HOME = HOME;
		writeAuth({
			tokens: {
				access_token: 'tok_123',
				refresh_token: 'ref_123',
				account_id: 'acc_456',
			},
		});
		expect(readCodexAuth()).toEqual({
			apiKey: undefined,
			accessToken: 'tok_123',
			refreshToken: 'ref_123',
			accountId: 'acc_456',
		});
		expect(hasCodexChatgptAuth()).toBe(true);
		expect(codexAuthSummary()).toContain('ChatGPT account');
	});

	test('reads the API-key shape (OPENAI_API_KEY)', () => {
		process.env.CODEX_HOME = HOME;
		writeAuth({OPENAI_API_KEY: 'sk-secret-1'});
		expect(readCodexAuth().apiKey).toBe('sk-secret-1');
		expect(hasCodexApiKey()).toBe(true);
		expect(hasCodexChatgptAuth()).toBe(false);
		expect(codexAuthSummary()).toContain('API key');
	});

	test('an environment key wins over auth.json', () => {
		process.env.CODEX_HOME = HOME;
		writeAuth({OPENAI_API_KEY: 'sk-file'});
		process.env.OPENAI_API_KEY = 'sk-env';
		expect(readCodexAuth().apiKey).toBe('sk-env');
	});

	test('no auth.json (or a corrupt one) resolves empty, never throws', () => {
		process.env.CODEX_HOME = HOME;
		expect(readCodexAuth()).toEqual({
			apiKey: undefined,
			accessToken: undefined,
			refreshToken: undefined,
			accountId: undefined,
		});
		writeAuth('{not json');
		expect(readCodexAuth().apiKey).toBeUndefined();
	});

	test('codexAuthPath honors CODEX_HOME', () => {
		process.env.CODEX_HOME = HOME;
		expect(codexAuthPath()).toBe(join(HOME, 'auth.json'));
	});
});
