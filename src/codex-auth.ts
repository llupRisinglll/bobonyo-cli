import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * Codex CLI credential interop (parity: the `codex login` flow). The Codex
 * CLI stores its credentials in `~/.codex/auth.json` (or `$CODEX_HOME`):
 *
 * - API-key mode (`codex login --with-api-key`) writes
 *   `{"OPENAI_API_KEY": "sk-..."}`.
 * - ChatGPT-account mode (`codex login`) writes
 *   `{"tokens": {"access_token": "...", "refresh_token": "...",
 *   "account_id": "..."}}`.
 *
 * bobonyo reads BOTH shapes at request time, so a `codex login` done in any
 * terminal is picked up by the harness without re-entering secrets.
 */
export interface CodexAuth {
	/** API key (`OPENAI_API_KEY` in auth.json or the environment). */
	apiKey?: string;
	/** ChatGPT-account bearer token (`tokens.access_token`). */
	accessToken?: string;
	/** OAuth refresh token, kept for a future refresh path. */
	refreshToken?: string;
	/** ChatGPT organization/workspace id (`tokens.account_id`). */
	accountId?: string;
}

export function codexHome(): string {
	return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

export function codexAuthPath(): string {
	return join(codexHome(), 'auth.json');
}

/** Read the Codex CLI credentials, env vars win over auth.json. */
export function readCodexAuth(): CodexAuth {
	const envKey = process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY;
	let file: CodexAuth = {};
	try {
		if (existsSync(codexAuthPath())) {
			const parsed = JSON.parse(readFileSync(codexAuthPath(), 'utf8')) as {
				OPENAI_API_KEY?: string;
				tokens?: {
					access_token?: string;
					refresh_token?: string;
					account_id?: string;
				};
			};
			file = {
				apiKey: parsed.OPENAI_API_KEY,
				accessToken: parsed.tokens?.access_token,
				refreshToken: parsed.tokens?.refresh_token,
				accountId: parsed.tokens?.account_id,
			};
		}
	} catch {
		// corrupt/unreadable auth.json, fall through to env keys
	}
	return {...file, ...(envKey ? {apiKey: envKey} : {})};
}

/** True when a ChatGPT-account login exists (the `codex login` OAuth flow). */
export function hasCodexChatgptAuth(auth: CodexAuth = readCodexAuth()): boolean {
	return Boolean(auth.accessToken);
}

/** True when an API key is available (env or `codex login --with-api-key`). */
export function hasCodexApiKey(auth: CodexAuth = readCodexAuth()): boolean {
	return Boolean(auth.apiKey);
}

/** Short human label for the detected login (shown in the connect modal). */
export function codexAuthSummary(
	auth: CodexAuth = readCodexAuth(),
): string | null {
	if (auth.accessToken) {
		return `ChatGPT account${auth.accountId ? ` (${auth.accountId.slice(0, 8)})` : ''}`;
	}
	if (auth.apiKey) {
		return `API key (${auth.apiKey.slice(0, 7)}…)`;
	}
	return null;
}
