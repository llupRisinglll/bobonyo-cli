/**
 * Local provider usage tracking (the token-plan answer for providers whose
 * quota endpoint is NOT reachable with an API key).
 *
 * Xiaomi MiMo token plans bill a fixed monthly allowance, but the balance /
 * quota endpoints live on `platform.xiaomimimo.com` behind the BROWSER
 * session cookie (`api-platform_serviceToken` + `userId`) — the `tp-…` key
 * cannot reach them (verified against every public implementation; see the
 * research in docs/report-tracker.md). What the key DOES return is the
 * OpenAI `usage` block on every chat completion (`prompt_tokens`,
 * `completion_tokens`, `prompt_tokens_details.cached_tokens`), so the
 * harness accumulates those into a per-provider, per-calendar-month total
 * and shows it as `used N.NM` on the status line — the same trade-off
 * OmniRoute made when it hit this wall.
 *
 * Persistence mirrors the DeepSeek cache: one JSON file, atomic temp-file +
 * rename writes (last writer wins, never interleaved JSON), keyed by the
 * normalized provider base URL so a fleet of concurrent instances shares a
 * single accounting ledger.
 */

import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {configDir} from './config';
import {cacheKey} from './deepseek';

/** One provider's accumulated usage for one calendar month (UTC). */
export interface MonthlyUsage {
	month: string;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	totalTokens: number;
	/** Wall-clock ms of the last recorded usage in this bucket. */
	at: number;
}

/** Shape persisted in `~/.config/nanocoder/provider-usage.json`. */
export interface ProviderUsageFile {
	entries: Record<string, Record<string, MonthlyUsage>>;
}

/** The current calendar month bucket (`YYYY-MM`, UTC — platform month). */
export function monthKey(now = Date.now()): string {
	const d = new Date(now);
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	return `${d.getUTCFullYear()}-${mm}`;
}

export function providerUsagePath(): string {
	return join(configDir(), 'provider-usage.json');
}

export function loadProviderUsage(): ProviderUsageFile {
	try {
		const file = providerUsagePath();
		if (!existsSync(file)) return {entries: {}};
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProviderUsageFile;
		return {entries: parsed.entries ?? {}};
	} catch {
		// corrupt or missing, start fresh
		return {entries: {}};
	}
}

export function saveProviderUsage(file: ProviderUsageFile): void {
	mkdirSync(configDir(), {recursive: true});
	const path = providerUsagePath();
	// Atomic replace: write a temp file in the SAME directory then rename.
	// Concurrent instances each do this; rename is atomic so the surviving
	// file is always one complete snapshot (never interleaved JSON).
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
	renameSync(tmp, path);
}

/** Current month's usage for a provider, or undefined when nothing recorded. */
export function currentMonthUsage(
	baseUrl: string,
	now = Date.now(),
): MonthlyUsage | undefined {
	return loadProviderUsage().entries[cacheKey(baseUrl)]?.[monthKey(now)];
}

/**
 * Add one usage snapshot to the provider's month bucket. Returns the updated
 * bucket so callers can push it straight into the status signal. Token
 * counts fall back to 0 when absent; a snapshot with no countable fields is
 * ignored so non-chat calls (discovery, balance) never create empty rows.
 */
export function recordProviderUsage(
	baseUrl: string,
	usage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		promptCacheHitTokens?: number;
		promptCacheMissTokens?: number;
	},
	now = Date.now(),
): MonthlyUsage | undefined {
	const prompt = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens! : 0;
	const completion = Number.isFinite(usage.completion_tokens)
		? usage.completion_tokens!
		: 0;
	const cached =
		(Number.isFinite(usage.promptCacheHitTokens)
			? usage.promptCacheHitTokens!
			: 0) +
		(Number.isFinite(usage.promptCacheMissTokens)
			? usage.promptCacheMissTokens!
			: 0);
	const total = Number.isFinite(usage.total_tokens)
		? usage.total_tokens!
		: prompt + completion;
	if (prompt <= 0 && completion <= 0 && total <= 0) return undefined;

	const month = monthKey(now);
	const key = cacheKey(baseUrl);
	const file = loadProviderUsage();
	const byMonth = file.entries[key] ?? {};
	const previous = byMonth[month] ?? {
		month,
		promptTokens: 0,
		completionTokens: 0,
		cachedTokens: 0,
		totalTokens: 0,
		at: now,
	};
	const updated: MonthlyUsage = {
		month,
		promptTokens: previous.promptTokens + prompt,
		completionTokens: previous.completionTokens + completion,
		cachedTokens: previous.cachedTokens + cached,
		totalTokens: previous.totalTokens + total,
		at: now,
	};
	byMonth[month] = updated;
	file.entries[key] = byMonth;
	saveProviderUsage(file);
	return updated;
}

import {formatCount} from './format';

/** `1.24M` / `482K` / `7.9K` / `9` — compact human-readable token totals. */
export function formatTokens(total: number): string {
	return formatCount(total);
}

/**
 * Status-line label, e.g. `used 1.24M`. Undefined when nothing has been
 * recorded this month (never show `used 0`).
 */
export function formatMonthlyUsage(
	usage: MonthlyUsage | undefined,
): string | undefined {
	if (!usage || usage.totalTokens <= 0) return undefined;
	return `used ${formatTokens(usage.totalTokens)}`;
}
