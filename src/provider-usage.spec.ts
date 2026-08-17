import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	currentMonthUsage,
	extractCacheTokens,
	formatCacheRate,
	formatMonthlyUsage,
	formatUsageCalendar,
	formatTokens,
	loadProviderUsage,
	monthKey,
	recordProviderUsage,
	sessionCacheUsage,
} from './provider-usage';

const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;
let configDir: string;

const MIMO_BASE = 'https://token-plan-sgp.xiaomimimo.com';

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'bobonyo-usage-spec-'));
	process.env.NANOCODER_CONFIG_DIR = configDir;
});

afterEach(() => {
	if (ORIGINAL_CONFIG_DIR === undefined)
		delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	rmSync(configDir, {recursive: true, force: true});
});

describe('monthKey', () => {
	test('buckets by UTC calendar month YYYY-MM', () => {
		expect(monthKey(Date.UTC(2026, 7, 12))).toBe('2026-08');
		expect(monthKey(Date.UTC(2026, 0, 1))).toBe('2026-01');
		expect(monthKey(Date.UTC(2026, 11, 31))).toBe('2026-12');
	});
});

describe('formatTokens', () => {
	test('compacts large totals with K/M suffixes', () => {
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(9)).toBe('9');
		expect(formatTokens(7995)).toBe('7.9K');
		expect(formatTokens(482_000)).toBe('482K');
		expect(formatTokens(1_240_000)).toBe('1.24M');
		expect(formatTokens(12_400_000)).toBe('12.4M');
	});
});

describe('recordProviderUsage / currentMonthUsage', () => {
	test('accumulates multiple turns into the current month bucket', () => {
		const at = Date.UTC(2026, 7, 12);
		const first = recordProviderUsage(
			MIMO_BASE,
			{
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				promptCacheHitTokens: 40,
				promptCacheMissTokens: 60,
			},
			at,
		);
		expect(first?.totalTokens).toBe(150);
		expect(first?.cachedTokens).toBe(100);
		expect(first?.cacheHitTokens).toBe(40);
		expect(first?.cacheMissTokens).toBe(60);
		expect(first?.month).toBe('2026-08');

		const second = recordProviderUsage(
			MIMO_BASE,
			{prompt_tokens: 200, completion_tokens: 30, total_tokens: 230},
			at + 60_000,
		);
		expect(second?.totalTokens).toBe(380);
		expect(second?.promptTokens).toBe(300);
		expect(second?.completionTokens).toBe(80);
		expect(second?.cachedTokens).toBe(100);
		// Cache fields accumulate across turns; a turn without cache fields
		// adds zero.
		expect(second?.cacheHitTokens).toBe(40);
		expect(second?.cacheMissTokens).toBe(60);
	});

	test('different providers keep separate ledgers', () => {
		const at = Date.UTC(2026, 7, 12);
		recordProviderUsage(MIMO_BASE, {prompt_tokens: 100, total_tokens: 100}, at);
		recordProviderUsage(
			'https://api.deepseek.com',
			{prompt_tokens: 999, total_tokens: 999},
			at,
		);
		expect(currentMonthUsage(MIMO_BASE, at)?.totalTokens).toBe(100);
		expect(currentMonthUsage('https://api.deepseek.com', at)?.totalTokens).toBe(
			999,
		);
	});

	test('an empty usage snapshot is ignored (no zero rows)', () => {
		const updated = recordProviderUsage(MIMO_BASE, {}, Date.UTC(2026, 7, 12));
		expect(updated).toBeUndefined();
		expect(currentMonthUsage(MIMO_BASE, Date.UTC(2026, 7, 12))).toBeUndefined();
	});

	test('a new month starts a fresh bucket', () => {
		const august = Date.UTC(2026, 7, 31);
		const september = Date.UTC(2026, 8, 1);
		recordProviderUsage(MIMO_BASE, {total_tokens: 100}, august);
		const next = recordProviderUsage(MIMO_BASE, {total_tokens: 50}, september);
		expect(next?.month).toBe('2026-09');
		expect(next?.totalTokens).toBe(50);
		// August is still on disk, keyed separately.
		expect(
			loadProviderUsage().entries['token-plan-sgp.xiaomimimo.com']?.['2026-08'],
		).toMatchObject({totalTokens: 100});
	});

	test('the ledger survives restarts (disk-backed)', () => {
		const at = Date.UTC(2026, 7, 12);
		recordProviderUsage(MIMO_BASE, {total_tokens: 250}, at);
		// New "instance": fresh module reads are from disk.
		expect(currentMonthUsage(MIMO_BASE, at)?.totalTokens).toBe(250);
	});
});

describe('formatMonthlyUsage', () => {
	test('renders used N.NM and hides empty months', () => {
		expect(
			formatMonthlyUsage({
				month: '2026-08',
				promptTokens: 0,
				completionTokens: 0,
				cachedTokens: 0,
				totalTokens: 1_240_000,
				at: 0,
			}),
		).toBe('used 1.24M');
		expect(formatMonthlyUsage(undefined)).toBeUndefined();
		expect(
			formatMonthlyUsage({
				month: '2026-08',
				promptTokens: 0,
				completionTokens: 0,
				cachedTokens: 0,
				totalTokens: 0,
				at: 0,
			}),
		).toBeUndefined();
	});
});

describe('formatCacheRate (DeepSeek status-line cost driver)', () => {
	const usage = (
		overrides: Partial<{
			cacheHitTokens?: number;
			cacheMissTokens?: number;
		}> = {},
	) => ({
		month: '2026-08',
		promptTokens: 0,
		completionTokens: 0,
		cachedTokens: 0,
		totalTokens: 0,
		at: 0,
		...overrides,
	});

	test('renders hit/total with the miss share', () => {
		expect(
			formatCacheRate(
				usage({cacheHitTokens: 1_350_000, cacheMissTokens: 150_000}),
			),
		).toBe('1.35M/1.5M (10% miss)');
	});

	test('rounds the miss percentage', () => {
		expect(
			formatCacheRate(usage({cacheHitTokens: 2, cacheMissTokens: 1})),
		).toBe('2/3 (33% miss)');
	});

	test('undefined until cache fields are reported', () => {
		expect(formatCacheRate(undefined)).toBeUndefined();
		expect(formatCacheRate(usage())).toBeUndefined();
		expect(
			formatCacheRate(usage({cacheHitTokens: 0, cacheMissTokens: 0})),
		).toBeUndefined();
	});
});

describe('sessionCacheUsage (status-line cache resets with /clear)', () => {
	test('sums the session snapshots into a formatCacheRate-compatible shape', () => {
		const stats = sessionCacheUsage([
			{promptCacheHitTokens: 700, promptCacheMissTokens: 300},
			{promptCacheHitTokens: 650_000, promptCacheMissTokens: 150_000},
		]);
		expect(stats).toEqual({
			cacheHitTokens: 650_700,
			cacheMissTokens: 150_300,
		});
		expect(formatCacheRate(stats)).toBe('650.7K/801K (19% miss)');
	});

	test('an empty session (after /clear) shows nothing', () => {
		expect(sessionCacheUsage([])).toBeUndefined();
	});

	test('snapshots without cache fields contribute nothing', () => {
		expect(
			sessionCacheUsage([
				{},
				{promptCacheHitTokens: 0, promptCacheMissTokens: 0},
			]),
		).toBeUndefined();
	});
});

describe('extractCacheTokens (provider-agnostic cache rate)', () => {
	test('DeepSeek: explicit hit/miss split wins', () => {
		expect(
			extractCacheTokens({
				prompt_tokens: 1000,
				prompt_cache_hit_tokens: 700,
				prompt_cache_miss_tokens: 300,
			}),
		).toEqual({hit: 700, miss: 300});
	});

	test('OpenAI-compatible: cached_tokens + prompt total derive the miss', () => {
		expect(
			extractCacheTokens({
				prompt_tokens: 1000,
				prompt_tokens_details: {cached_tokens: 700},
			}),
		).toEqual({hit: 700, miss: 300});
		// Responses-style nested field works too.
		expect(
			extractCacheTokens({
				prompt_tokens: 1000,
				input_tokens_details: {cached_tokens: 250},
			}),
		).toEqual({hit: 250, miss: 750});
	});

	test('Anthropic: cache_read_input_tokens derives the miss', () => {
		expect(
			extractCacheTokens({
				prompt_tokens: 800,
				cache_read_input_tokens: 500,
			}),
		).toEqual({hit: 500, miss: 300});
	});

	test('no cache fields reports zeros (never a fabricated rate)', () => {
		expect(extractCacheTokens(undefined)).toEqual({hit: 0, miss: 0});
		expect(extractCacheTokens({prompt_tokens: 100})).toEqual({hit: 0, miss: 0});
		expect(
			extractCacheTokens({prompt_tokens: 100, prompt_tokens_details: {}}),
		).toEqual({hit: 0, miss: 0});
	});
});

describe('formatUsageCalendar', () => {
	test('renders token activity summary and weekday rows', () => {
		const now = Date.UTC(2026, 7, 17);
		recordProviderUsage(MIMO_BASE, {total_tokens: 100}, now);
		const calendar = formatUsageCalendar(MIMO_BASE, now, 12);
		expect(calendar).toContain('Token activity   last 12 months');
		expect(calendar).toMatch(/Lifetime [0-9.]+[KM]?/);
		expect(calendar).toContain('Su ');
		expect(calendar).toContain('daily · weekly · cumulative');
	});
});
