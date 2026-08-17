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

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {configDir} from './config';
import {bobonyoDataDir} from './bobonyo-paths';
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
	/** Daily totals (`YYYY-MM-DD` UTC) for `/usage` activity calendar. */
	dailyTokens?: Record<string, number>;
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
	const prompt = Number.isFinite(usage.prompt_tokens)
		? usage.prompt_tokens!
		: 0;
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
		dailyTokens: {},
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
		dailyTokens: {
			...(previous.dailyTokens ?? {}),
			[new Date(now).toISOString().slice(0, 10)]:
				((previous.dailyTokens ?? {})[
					new Date(now).toISOString().slice(0, 10)
				] ?? 0) + total,
		},
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

/** Build compact Codex-style daily activity calendar for one provider. */
export function formatUsageCalendar(
	baseUrl: string,
	now = Date.now(),
	months = 12,
): string {
	const entries = loadProviderUsage().entries[cacheKey(baseUrl)] ?? {};
	const daily: Record<string, number> = {};
	// Older sessions predate the usage ledger. Seed the calendar from their
	// persisted transcript/context so `/usage` is useful immediately after
	// upgrade; new turns continue using exact provider usage blocks.
	try {
		const dir = join(bobonyoDataDir(), 'sessions');
		for (const file of readdirSync(dir).filter(name =>
			name.endsWith('.json'),
		)) {
			const session = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
				provider?: string;
				updatedAt?: number;
				messages?: Array<{content?: string}>;
				context?: Array<{content?: string}>;
			};
			if (
				session.provider &&
				session.provider !== cacheKey(baseUrl) &&
				!session.provider.includes(baseUrl)
			)
				continue;
			const contents = session.messages ?? session.context ?? [];
			const tokens = Math.floor(
				contents.reduce(
					(sum, message) => sum + (message.content?.length ?? 0),
					0,
				) / 4,
			);
			if (tokens > 0 && session.updatedAt) {
				const day = new Date(session.updatedAt).toISOString().slice(0, 10);
				daily[day] = Math.max(daily[day] ?? 0, tokens);
			}
		}
	} catch {
		/* missing session directory is normal */
	}
	for (const bucket of Object.values(entries)) {
		for (const [day, total] of Object.entries(bucket.dailyTokens ?? {})) {
			daily[day] = Math.max(daily[day] ?? 0, total);
		}
	}
	const end = new Date(now);
	end.setUTCHours(0, 0, 0, 0);
	const start = new Date(
		Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months + 1, 1),
	);
	// Codex layout: seven weekday rows, one narrow cell per week.
	const firstSunday = new Date(start);
	firstSunday.setUTCDate(start.getUTCDate() - start.getUTCDay());
	const weeks: Date[][] = [];
	for (
		let cursor = new Date(firstSunday);
		cursor <= end;
		cursor.setUTCDate(cursor.getUTCDate() + 7)
	) {
		weeks.push(
			Array.from({length: 7}, (_, weekday) => {
				const day = new Date(cursor);
				day.setUTCDate(cursor.getUTCDate() + weekday);
				return day;
			}),
		);
	}
	const values = weeks
		.flatMap(week => week)
		.map(day => daily[day.toISOString().slice(0, 10)] ?? 0);
	const total = Object.values(daily).reduce((sum, value) => sum + value, 0);
	const peak = Math.max(0, ...Object.values(daily));
	let best = 0;
	let run = 0;
	for (const value of values) {
		run = value > 0 ? run + 1 : 0;
		best = Math.max(best, run);
	}
	let streak = 0;
	for (let i = values.length - 1; i >= 0 && values[i]! > 0; i--) streak++;
	const max = Math.max(1, peak);
	const cell = (value: number): string =>
		value <= 0 ? '·' : value < max * 0.25 ? '▪' : value < max * 0.6 ? '■' : '█';
	const rows = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(
		(label, weekday) =>
			`${label} ${weeks.map(week => `${cell(daily[week[weekday]!.toISOString().slice(0, 10)] ?? 0)} `).join('')}`,
	);
	const monthLabels = weeks
		.map((week, index) =>
			week[0]!.getUTCDate() <= 7
				? new Intl.DateTimeFormat('en', {
						month: 'short',
						timeZone: 'UTC',
					}).format(week[0]!)
				: '   ',
		)
		.join('');
	return `Token activity   last ${months} months\n\nLifetime ${formatCount(total)} · Peak ${formatCount(peak)} · Streak ${streak}d (best ${best}d)\n\n   ${monthLabels}\n${rows.join('\n')}\n\n   Less · ▪ ▪ ■ ■ █ More\n   daily · weekly · cumulative`;
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
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
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
