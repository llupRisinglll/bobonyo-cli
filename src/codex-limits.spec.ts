import {afterAll, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
	codexLimitLabel,
	codexLimitRows,
	codexProgressBar,
	codexResetLabel,
	codexWindowValue,
	fetchCodexLimits,
} from './codex-limits';

const realFetch = globalThis.fetch;
const originalCodexHome = process.env.CODEX_HOME;
const authDir = `${import.meta.dir}/.test-temp-codex-limits`;

const withCodexAuth = (): void => {
	process.env.CODEX_HOME = authDir;
	mkdirSync(authDir, {recursive: true});
	writeFileSync(
		join(authDir, 'auth.json'),
		JSON.stringify({
			tokens: {access_token: 'tok_x', account_id: 'acc_x'},
		}),
	);
};

describe('codex limit bar (20-segment, filled by REMAINING percent)', () => {
	test('clamps and rounds like codex', () => {
		expect(codexProgressBar(100)).toBe(`[${'█'.repeat(20)}]`);
		expect(codexProgressBar(0)).toBe(`[${'░'.repeat(20)}]`);
		expect(codexProgressBar(55)).toBe(`[${'█'.repeat(11)}${'░'.repeat(9)}]`);
		expect(codexProgressBar(12.5)).toBe(`[${'█'.repeat(3)}${'░'.repeat(17)}]`);
		expect(codexProgressBar(-5)).toBe(`[${'░'.repeat(20)}]`);
		expect(codexProgressBar(150)).toBe(`[${'█'.repeat(20)}]`);
	});
});

describe('codex window labels', () => {
	test('maps window seconds to 5h / daily / weekly / monthly / annual', () => {
		expect(codexLimitLabel(3600)).toBe('hourly'); // 1h
		expect(codexLimitLabel(18000)).toBe('5h'); // 5h
		expect(codexLimitLabel(86400)).toBe('daily'); // 24h
		expect(codexLimitLabel(604800)).toBe('weekly'); // 7d
		expect(codexLimitLabel(2592000)).toBe('monthly'); // 30d
		expect(codexLimitLabel(31536000)).toBe('annual'); // 365d
		expect(codexLimitLabel(12345)).toBe('usage'); // unknown fallback
	});
});

describe('codex reset labels', () => {
	test('same day is HH:MM, another day is HH:MM on D Mon', () => {
		const now = new Date(2026, 7, 14, 12, 0, 0, 0); // local 12:00
		const today = new Date(now);
		today.setHours(9, 25, 0, 0);
		expect(
			codexResetLabel(Math.floor(today.getTime() / 1000), now.getTime()),
		).toBe('09:25');
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		tomorrow.setHours(22, 59, 0, 0);
		const month = new Intl.DateTimeFormat('en', {month: 'short'}).format(
			tomorrow,
		);
		expect(
			codexResetLabel(
				Math.floor(tomorrow.getTime() / 1000),
				now.getTime(),
			),
		).toBe(`22:59 on ${tomorrow.getDate()} ${month}`);
	});
});

describe('codex limit rows (payload → /status rows)', () => {
	test('maps windows, credits and the monthly spend limit', () => {
		const now = Date.now();
		const todayReset = Math.floor(new Date(now).setHours(9, 25, 0, 0) / 1000);
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		tomorrow.setHours(22, 59, 0, 0);
		const tomorrowReset = Math.floor(tomorrow.getTime() / 1000);
		const month = new Intl.DateTimeFormat('en', {month: 'short'}).format(
			tomorrow,
		);

		const rows = codexLimitRows({
			plan_type: 'free',
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 45,
					limit_window_seconds: 18000,
					reset_after_seconds: 0,
					reset_at: todayReset,
				},
				secondary_window: {
					used_percent: 30,
					limit_window_seconds: 604800,
					reset_after_seconds: 0,
					reset_at: todayReset,
				},
			},
			credits: {has_credits: true, unlimited: false, balance: '25'},
			spend_control: {
				reached: false,
				individual_limit: {
					remaining_percent: 100,
					used: '1250',
					limit: '20000',
					resets_at: tomorrowReset,
				},
			},
		});

		expect(rows).toEqual([
			{
				label: '5h limit',
				value: `[${'█'.repeat(11)}${'░'.repeat(9)}] 55% left (resets 09:25)`,
			},
			{
				label: 'Weekly limit',
				value: `[${'█'.repeat(14)}${'░'.repeat(6)}] 70% left (resets 09:25)`,
			},
			{label: 'Credits', value: '25 credits'},
			{
				label: 'Monthly limit',
				value:
					`[${'█'.repeat(20)}] 100% left (resets 22:59 on ` +
					`${tomorrow.getDate()} ${month}) · 1250 of 20000 credits used`,
			},
		]);
	});

	test('unlimited credits and empty payloads', () => {
		expect(
			codexLimitRows({
				credits: {has_credits: true, unlimited: true},
			}),
		).toEqual([{label: 'Credits', value: 'Unlimited'}]);
		expect(codexLimitRows({})).toEqual([]);
	});
});

describe('fetchCodexLimits (live /wham/usage)', () => {
	test('hits the backend root /wham/usage with codex auth headers', async () => {
		withCodexAuth();
		let calledUrl = '';
		let authHeader = '';
		let accountHeader = '';
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			calledUrl = String(url);
			authHeader = String(
				(init?.headers as Record<string, string> | undefined)
					?.authorization ?? '',
			);
			accountHeader = String(
				(init?.headers as Record<string, string> | undefined)?.[
					'chatgpt-account-id'
				] ?? '',
			);
			return new Response(
				JSON.stringify({
					rate_limit: {
						primary_window: {
							used_percent: 45,
							limit_window_seconds: 18000,
							reset_at: Math.floor(Date.now() / 1000),
						},
					},
				}),
				{status: 200, headers: {'content-type': 'application/json'}},
			);
		}) as unknown as typeof fetch;
		try {
			const rows = await fetchCodexLimits(
				'https://chatgpt.com/backend-api/codex',
			);
			expect(calledUrl).toBe('https://chatgpt.com/backend-api/wham/usage');
			expect(authHeader).toBe('Bearer tok_x');
			expect(accountHeader).toBe('acc_x');
			expect(rows).toHaveLength(1);
			expect(rows[0]!.label).toBe('5h limit');
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test('fails silently on 401 and with no login', async () => {
		withCodexAuth();
		globalThis.fetch = (async () =>
			new Response('nope', {status: 401})) as unknown as typeof fetch;
		try {
			expect(
				await fetchCodexLimits('https://example.test/backend-api/codex'),
			).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
		}
		// No login: no fetch, empty rows.
		const emptyAuthDir = `${import.meta.dir}/.test-temp-codex-limits-empty`;
		process.env.CODEX_HOME = emptyAuthDir;
		mkdirSync(emptyAuthDir, {recursive: true});
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response('{}', {status: 200});
		}) as unknown as typeof fetch;
		try {
			expect(
				await fetchCodexLimits('https://example.test/backend-api/codex'),
			).toEqual([]);
			expect(fetched).toBe(false);
		} finally {
			globalThis.fetch = realFetch;
			rmSync(emptyAuthDir, {recursive: true, force: true});
		}
	});
});

// Cleanup the shared auth temp dir after the last test.
afterAll(() => {
	rmSync(authDir, {recursive: true, force: true});
	if (originalCodexHome === undefined) {
		delete process.env.CODEX_HOME;
	} else {
		process.env.CODEX_HOME = originalCodexHome;
	}
});
