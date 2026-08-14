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
	/**
	 * DeepSeek prompt-cache split (`prompt_cache_hit_tokens` /
	 * `prompt_cache_miss_tokens`), accumulated across the month so the
	 * status line can show the real cost driver live (`100k/1.5m (10% miss)`)
	 * instead of waiting on the 5-minute balance refresh. Absent on legacy
	 * files / non-DeepSeek providers — treated as 0.
	 */
	cacheHitTokens?: number;
	cacheMissTokens?: number;
	/** Wall-clock ms of the last recorded usage in this bucket. */
	at: number;
}

/** Shape persisted in `~/.config/bobonyo/provider-usage.json`. */
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
	const cacheHit = Number.isFinite(usage.promptCacheHitTokens)
		? usage.promptCacheHitTokens!
		: 0;
	const cacheMiss = Number.isFinite(usage.promptCacheMissTokens)
		? usage.promptCacheMissTokens!
		: 0;
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
		cacheHitTokens: (previous.cacheHitTokens ?? 0) + cacheHit,
		cacheMissTokens: (previous.cacheMissTokens ?? 0) + cacheMiss,
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

/**
 * DeepSeek prompt-cache rate label for the status line, e.g.
 * `100K/1.5M (10% miss)` — cumulative cache-HIT input tokens over the total
 * cache-accounted input, with the miss share. Updates every turn (the usage
 * ledger accumulates per-turn `prompt_cache_hit/miss_tokens`). Undefined
 * until the provider reports cache fields.
 */
export function formatCacheRate(
	usage: {cacheHitTokens?: number; cacheMissTokens?: number} | undefined,
): string | undefined {
	if (!usage) return undefined;
	const hit = usage.cacheHitTokens ?? 0;
	const miss = usage.cacheMissTokens ?? 0;
	const total = hit + miss;
	if (total <= 0) return undefined;
	const missPct = Math.round((miss / total) * 100);
	return `${formatTokens(hit)}/${formatTokens(total)} (${missPct}% miss)`;
}

/**
 * Cumulative cache stats across a SESSION's usage snapshots (`usageHistory`).
 *
 * The status line's `cache` segment is session-scoped on purpose: `/clear`
 * empties the history, so a fresh conversation starts WITHOUT the previous
 * conversation's cache numbers (the MONTHLY ledger keeps accumulating for
 * `/usage` and cost tracking, but it must not masquerade as the current
 * conversation's rate). Pure, unit-tested.
 */
export function sessionCacheUsage(
	history: Array<{
		promptCacheHitTokens?: number;
		promptCacheMissTokens?: number;
	}>,
): {cacheHitTokens: number; cacheMissTokens: number} | undefined {
	let hit = 0;
	let miss = 0;
	for (const snapshot of history) {
		hit += snapshot.promptCacheHitTokens ?? 0;
		miss += snapshot.promptCacheMissTokens ?? 0;
	}
	if (hit + miss <= 0) return undefined;
	return {cacheHitTokens: hit, cacheMissTokens: miss};
}

function toFinite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Cache hit/miss input tokens from ANY provider usage block, so the status
 * line rate works beyond DeepSeek:
 * - DeepSeek reports the explicit split (`prompt_cache_hit_tokens` /
 *   `prompt_cache_miss_tokens`);
 * - OpenAI-compatible providers report `prompt_tokens_details.cached_tokens`
 *   (or Responses-style `input_tokens_details.cached_tokens`) — the miss
 *   side is derived from `prompt_tokens - cached`;
 * - Anthropic-compatible report `cache_read_input_tokens` (same derivation).
 * Returns zeros when the provider reports no cache fields.
 */
export function extractCacheTokens(
	usage: Record<string, unknown> | undefined,
): {hit: number; miss: number} {
	if (!usage) return {hit: 0, miss: 0};
	const details =
		(usage.prompt_tokens_details as Record<string, unknown> | undefined) ??
		(usage.input_tokens_details as Record<string, unknown> | undefined);
	const hit =
		toFinite(usage.prompt_cache_hit_tokens) ??
		toFinite(details?.cached_tokens) ??
		toFinite(usage.cache_read_input_tokens) ??
		0;
	const explicitMiss = toFinite(usage.prompt_cache_miss_tokens);
	const prompt = toFinite(usage.prompt_tokens);
	const miss =
		explicitMiss ??
		(hit > 0 && prompt !== undefined ? Math.max(0, prompt - hit) : 0);
	return {hit, miss};
}
