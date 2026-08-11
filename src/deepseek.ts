/**
 * DeepSeek integration (the harness's flagship provider):
 *
 * - Live model discovery: `GET /models` returns the current catalog, so a
 *   DeepSeek provider never needs hand-maintained model names.
 * - Live balance: `GET /user/balance` returns the remaining credit, shown
 *   on the status line as `Cred: $n`.
 * - Prompt-cache awareness: DeepSeek reports `prompt_cache_hit_tokens` /
 *   `prompt_cache_miss_tokens` in every `usage` block; we surface the hit
 *   ratio and alert when a turn misses the cache heavily (that is what
 *   drives cost up).
 *
 * Both network lookups are CACHED on disk (models 1h, balance 5m) so a
 * fleet of concurrently running instances never floods the API: the cache
 * file is written atomically (temp file + rename, last writer wins) and
 * every instance reads the freshest surviving copy. A stale-but-usable
 * balance survives a transient fetch failure, and an in-process in-flight
 * map means parallel `/model`/`/status` opens share ONE request.
 */

import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {configDir} from './config';

/** Refresh cadence for the on-disk catalog (models change rarely). */
export const DEEPSEEK_MODELS_TTL_MS = 60 * 60 * 1000;
/** Balance can drift every request, refresh it more often. */
export const DEEPSEEK_BALANCE_TTL_MS = 5 * 60 * 1000;
/** A turn must have this many cached input tokens before we warn. */
export const CACHE_ALERT_MIN_TOKENS = 2_000;
/** Warn when more than this share of the input misses the cache. */
export const CACHE_ALERT_MAX_MISS_RATIO = 0.7;

export interface DeepSeekBalance {
	currency: string;
	total: number;
	granted?: number;
	toppedUp?: number;
	isAvailable?: boolean;
	/** Wall-clock ms of the snapshot. */
	at: number;
}

interface DeepSeekCacheEntry {
	models?: {ids: string[]; at: number};
	balance?: DeepSeekBalance;
}

interface DeepSeekCacheFile {
	entries: Record<string, DeepSeekCacheEntry>;
}

export interface DeepSeekEndpoint {
	id?: string;
	name?: string;
	baseUrl: string;
	apiKey?: string;
	models?: string[];
}

const inFlight = new Map<string, Promise<unknown>>();

/** Test-only: clear the in-flight map (specs). */
export function resetDeepSeekInFlight(): void {
	inFlight.clear();
}

/**
 * Is this provider DeepSeek? Detected by the base URL (`api.deepseek.com`)
 * or the provider id/name, so any config spelling works without a flag.
 */
export function isDeepSeek(endpoint: DeepSeekEndpoint): boolean {
	const base = endpoint.baseUrl.toLowerCase();
	const id = (endpoint.id ?? endpoint.name ?? '').toLowerCase();
	return (
		base.includes('api.deepseek.com') ||
		base.includes('deepseek.com') ||
		id.includes('deepseek')
	);
}

function deepSeekCachePath(): string {
	return join(configDir(), 'deepseek-cache.json');
}

function cacheKey(baseUrl: string): string {
	return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
}

export function loadDeepSeekCache(): Record<string, DeepSeekCacheEntry> {
	try {
		const file = deepSeekCachePath();
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeepSeekCacheFile;
		return parsed.entries ?? {};
	} catch {
		// corrupt or missing, start fresh
		return {};
	}
}

export function saveDeepSeekCache(
	entries: Record<string, DeepSeekCacheEntry>,
): void {
	mkdirSync(configDir(), {recursive: true});
	const file = deepSeekCachePath();
	// Atomic replace: write a temp file in the SAME directory then rename.
	// Concurrent instances each do this; rename is atomic so the surviving
	// file is always one complete snapshot (never interleaved JSON).
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({entries}, null, 2)}\n`, 'utf8');
	renameSync(tmp, file);
}

/** Models from the disk cache when the entry is still fresh. */
export function freshCachedModels(
	entries: Record<string, DeepSeekCacheEntry>,
	key: string,
	now: number,
): string[] | undefined {
	const models = entries[key]?.models;
	if (models && now - models.at < DEEPSEEK_MODELS_TTL_MS) return models.ids;
	return undefined;
}

/** Balance from the disk cache when the entry is still fresh. */
export function freshCachedBalance(
	entries: Record<string, DeepSeekCacheEntry>,
	key: string,
	now: number,
): DeepSeekBalance | undefined {
	const balance = entries[key]?.balance;
	if (balance && now - balance.at < DEEPSEEK_BALANCE_TTL_MS) return balance;
	return undefined;
}

/** Stale balance fallback (fetch failed, better than showing nothing). */
export function staleCachedBalance(
	entries: Record<string, DeepSeekCacheEntry>,
	key: string,
): DeepSeekBalance | undefined {
	return entries[key]?.balance;
}

/**
 * Fresh model catalog from the DISK cache for a provider. Lets the app pick
 * the initial model from the REAL DeepSeek catalog without waiting for a
 * network round trip, so a config that omits the static `models` list (the
 * models are fetched automatically) never falls back to mock-model-1 on a
 * warm cache. Undefined when absent or stale (callers then fetch).
 */
export function cachedDeepSeekModels(
	provider: DeepSeekEndpoint,
	now = Date.now(),
): string[] | undefined {
	return freshCachedModels(
		loadDeepSeekCache(),
		cacheKey(provider.baseUrl),
		now,
	);
}

async function deepSeekGet(
	baseUrl: string,
	path: string,
	apiKey: string,
): Promise<unknown> {
	const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
		headers: {
			accept: 'application/json',
			...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
		},
	});
	if (!response.ok) {
		throw new Error(`DeepSeek ${path} responded ${response.status}`);
	}
	return response.json() as Promise<unknown>;
}

/** `GET /models` → the model ids (parity: the models list API). */
export async function fetchDeepSeekModels(
	baseUrl: string,
	apiKey: string,
): Promise<string[]> {
	const body = (await deepSeekGet(baseUrl, '/models', apiKey)) as {
		data?: Array<{id?: string}>;
	};
	return (body.data ?? [])
		.map(model => model.id)
		.filter((id): id is string => Boolean(id));
}

/** `GET /user/balance` → the parsed balance, USD preferred. */
export async function fetchDeepSeekBalance(
	baseUrl: string,
	apiKey: string,
	now = Date.now(),
): Promise<DeepSeekBalance> {
	const body = (await deepSeekGet(baseUrl, '/user/balance', apiKey)) as {
		is_available?: boolean;
		balance_infos?: Array<{
			currency?: string;
			total_balance?: string | number;
			granted_balance?: string | number;
			topped_up_balance?: string | number;
		}>;
	};
	const infos = body.balance_infos ?? [];
	const usd = infos.find(info => info.currency === 'USD');
	const info = usd ?? infos[0];
	if (!info) throw new Error('DeepSeek balance API returned no balance_infos');
	const total = Number(info.total_balance ?? 0);
	if (!Number.isFinite(total)) {
		throw new Error('DeepSeek balance API returned an invalid total');
	}
	const num = (value: string | number | undefined): number | undefined => {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	};
	return {
		currency: info.currency ?? 'USD',
		total,
		granted: num(info.granted_balance),
		toppedUp: num(info.topped_up_balance),
		isAvailable: body.is_available,
		at: now,
	};
}

/**
 * Refresh the model catalog: fresh cache wins, otherwise one shared fetch
 * per key, persisted on success. NEVER throws — the static list remains
 * the offline fallback (parity: model-discovery).
 */
export async function refreshDeepSeekModels(
	provider: DeepSeekEndpoint,
	now = Date.now(),
): Promise<string[]> {
	const key = cacheKey(provider.baseUrl);
	const cached = freshCachedModels(loadDeepSeekCache(), key, now);
	if (cached) return cached;
	const inflightKey = `models:${key}`;
	const existing = inFlight.get(inflightKey);
	if (existing) return existing as Promise<string[]>;
	const promise = (async () => {
		try {
			const ids = await fetchDeepSeekModels(
				provider.baseUrl,
				provider.apiKey ?? '',
			);
			if (ids.length === 0) return provider.models ?? [];
			const entries = loadDeepSeekCache();
			entries[key] = {...(entries[key] ?? {}), models: {ids, at: now}};
			saveDeepSeekCache(entries);
			return ids;
		} catch {
			return provider.models ?? [];
		}
	})();
	inFlight.set(inflightKey, promise);
	try {
		return (await promise) as string[];
	} finally {
		inFlight.delete(inflightKey);
	}
}

/**
 * Refresh the balance: fresh cache wins, otherwise one shared fetch per
 * key. A failed fetch falls back to a STALE cached balance so the status
 * line keeps showing a number during an outage.
 */
export async function refreshDeepSeekBalance(
	provider: DeepSeekEndpoint,
	now = Date.now(),
): Promise<DeepSeekBalance | undefined> {
	const key = cacheKey(provider.baseUrl);
	const entries = loadDeepSeekCache();
	const cached = freshCachedBalance(entries, key, now);
	if (cached) return cached;
	const inflightKey = `balance:${key}`;
	const existing = inFlight.get(inflightKey);
	if (existing) return existing as Promise<DeepSeekBalance | undefined>;
	const promise = (async () => {
		try {
			const balance = await fetchDeepSeekBalance(
				provider.baseUrl,
				provider.apiKey ?? '',
				now,
			);
			const latest = loadDeepSeekCache();
			latest[key] = {...(latest[key] ?? {}), balance};
			saveDeepSeekCache(latest);
			return balance;
		} catch {
			return staleCachedBalance(loadDeepSeekCache(), key);
		}
	})();
	inFlight.set(inflightKey, promise);
	try {
		return (await promise) as DeepSeekBalance | undefined;
	} finally {
		inFlight.delete(inflightKey);
	}
}

/** `Cred: $12.34` / `Cred: ¥110.00` (status-line label). */
export function formatCred(balance: DeepSeekBalance | undefined): string | undefined {
	if (!balance) return undefined;
	const symbol =
		balance.currency === 'USD'
			? '$'
			: balance.currency === 'CNY'
				? '¥'
				: `${balance.currency} `;
	return `Cred: ${symbol}${balance.total.toFixed(2)}`;
}

export interface CacheUsageStats {
	hit: number;
	miss: number;
	total: number;
	/** Fraction of cached input tokens that HIT the cache (0..1). */
	ratio: number;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract DeepSeek's prompt-cache fields from a usage block. Undefined when
 * the provider did not report them (every other provider returns this).
 */
export function cacheStats(
	usage: Record<string, unknown> | undefined,
): CacheUsageStats | undefined {
	if (!usage) return undefined;
	// Accept BOTH the raw provider field names and the normalized snapshot
	// keys the app stores in `lastUsage`/`usageHistory`.
	const hit =
		finiteNumber(usage.prompt_cache_hit_tokens) ??
		finiteNumber(usage.promptCacheHitTokens);
	const miss =
		finiteNumber(usage.prompt_cache_miss_tokens) ??
		finiteNumber(usage.promptCacheMissTokens);
	if (hit === undefined && miss === undefined) return undefined;
	const h = hit ?? 0;
	const m = miss ?? 0;
	const total = h + m;
	return {hit: h, miss: m, total, ratio: total > 0 ? h / total : 1};
}

/**
 * Alert when an unusually large share of a SIZEABLE turn missed the cache
 * (that is what drives the cost up). Small turns are exempt — a cold start
 * after a pause is expected and not worth a warning.
 */
export function shouldAlertCacheMiss(
	stats: CacheUsageStats | undefined,
	options: {minTokens?: number; maxMissRatio?: number} = {},
): boolean {
	if (!stats || stats.total === 0) return false;
	const minTokens = options.minTokens ?? CACHE_ALERT_MIN_TOKENS;
	const maxMissRatio = options.maxMissRatio ?? CACHE_ALERT_MAX_MISS_RATIO;
	if (stats.total < minTokens) return false;
	return stats.ratio < 1 - maxMissRatio;
}

/** `cache hit 87%` (completion line + status modal label). */
export function formatCacheHitLabel(
	stats: CacheUsageStats | undefined,
): string | undefined {
	if (!stats || stats.total === 0) return undefined;
	return `cache hit ${Math.round(stats.ratio * 100)}%`;
}
