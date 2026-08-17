import {readCodexAuth} from './codex-auth';
import type {StatusRow} from './components/status-modal';

/**
 * Codex ChatGPT-account usage limits for the `/status` modal (parity: the
 * codex CLI's `/status` renders `5h limit: [███████░░░░░░░░░░░░] 55% left
 * (resets 09:25)` from `GET /wham/usage`).
 *
 * The endpoint is undocumented and needs the `codex login` OAuth token
 * (plus the account id header) — the same credentials and fetch pattern the
 * codex model discovery already uses. Any failure returns `[]` so `/status`
 * never blocks on the live limits.
 */

/** Bar segments — codex uses a fixed 20-segment bar. */
const BAR_SEGMENTS = 20;

/** In-memory TTL so repeated `/status` opens don't hammer the backend. */
const LIMITS_TTL_MS = 60_000;

const limitsCache = new Map<string, {at: number; rows: StatusRow[]}>();

/** 20-segment progress bar filled by REMAINING percent (codex parity). */
export function codexProgressBar(percentRemaining: number): string {
	const ratio = Math.min(100, Math.max(0, percentRemaining)) / 100;
	const filled = Math.round(ratio * BAR_SEGMENTS);
	return `[${'█'.repeat(filled)}${'░'.repeat(BAR_SEGMENTS - filled)}]`;
}

/**
 * Window label from `limit_window_seconds` (codex parity: approximate
 * ±5% matching against hourly / 5h / daily / weekly / monthly / annual).
 */
export function codexLimitLabel(windowSeconds: number): string {
	const minutes = windowSeconds / 60;
	const approx = (expectedMinutes: number): boolean =>
		minutes >= expectedMinutes * 0.95 && minutes <= expectedMinutes * 1.05;
	if (approx(60)) return 'hourly';
	if (approx(300)) return '5h';
	if (approx(24 * 60)) return 'daily';
	if (approx(7 * 24 * 60)) return 'weekly';
	if (approx(30 * 24 * 60)) return 'monthly';
	if (approx(365 * 24 * 60)) return 'annual';
	return 'usage';
}

/** Local reset label: `HH:MM` today, `HH:MM on D Mon` on another day. */
export function codexResetLabel(
	resetAtSeconds: number,
	nowMs: number = Date.now(),
): string {
	const reset = new Date(resetAtSeconds * 1000);
	const now = new Date(nowMs);
	const time = `${String(reset.getHours()).padStart(2, '0')}:${String(
		reset.getMinutes(),
	).padStart(2, '0')}`;
	const sameDay =
		reset.getFullYear() === now.getFullYear() &&
		reset.getMonth() === now.getMonth() &&
		reset.getDate() === now.getDate();
	if (sameDay) return time;
	const month = new Intl.DateTimeFormat('en', {month: 'short'}).format(reset);
	return `${time} on ${reset.getDate()} ${month}`;
}

/** `[███████░░░░░░░░░░░░] 55% left (resets 09:25)` value text. */
export function codexWindowValue(
	usedPercent: number,
	resetAtSeconds?: number,
): string {
	const remaining = Math.round(100 - usedPercent);
	const reset =
		resetAtSeconds != null
			? ` (resets ${codexResetLabel(resetAtSeconds)})`
			: '';
	return `${codexProgressBar(remaining)} ${remaining}% left${reset}`;
}

interface CodexWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

/** The per-limit details object (`rate_limit` / `additional_rate_limits[].rate_limit`). */
interface CodexRateLimitDetails {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: CodexWindow | null;
	secondary_window?: CodexWindow | null;
}

interface CodexUsagePayload {
	plan_type?: string | null;
	rate_limit?: CodexRateLimitDetails | null;
	additional_rate_limits?: Array<{
		metered_feature?: string | null;
		limit_name?: string | null;
		rate_limit?: CodexRateLimitDetails | null;
	}> | null;
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		balance?: string | null;
	} | null;
	spend_control?: {
		reached?: boolean;
		individual_limit?: {
			remaining_percent?: number;
			used?: string | number;
			limit?: string | number;
			resets_at?: number;
		} | null;
	} | null;
}

/**
 * Map a `/wham/usage` payload to `/status` rows (pure, unit-tested). Mirrors
 * codex-rs's `rate_limit_snapshots_from_payload`: the top-level `rate_limit`
 * carries the `codex` windows plus the account credits and spend-control
 * monthly limit; `additional_rate_limits` add per-feature windows.
 */
export function codexLimitRows(payload: CodexUsagePayload): StatusRow[] {
	const rows: StatusRow[] = [];
	const pushWindows = (
		details: CodexRateLimitDetails | null | undefined,
		bucket?: string,
	): void => {
		const windows: Array<{window: CodexWindow; secondary: boolean}> = [];
		if (details?.primary_window?.used_percent != null) {
			windows.push({window: details.primary_window, secondary: false});
		}
		if (details?.secondary_window?.used_percent != null) {
			windows.push({window: details.secondary_window, secondary: true});
		}
		for (const {window, secondary} of windows) {
			const label = capitalize(
				codexLimitLabel(window.limit_window_seconds ?? 0),
			);
			rows.push({
				// Additional (non-codex) buckets prefix the window label so
				// the feature the window meters is identifiable (codex
				// parity: `codex_other weekly limit`).
				label: bucket ? `${bucket} ${label} limit` : `${label} limit`,
				value: codexWindowValue(window.used_percent!, window.reset_at),
			});
		}
	};
	pushWindows(payload.rate_limit);
	for (const additional of payload.additional_rate_limits ?? []) {
		pushWindows(
			additional.rate_limit,
			additional.limit_name ?? additional.metered_feature ?? undefined,
		);
	}
	const credits = payload.credits;
	if (credits?.unlimited) {
		rows.push({label: 'Credits', value: 'Unlimited'});
	} else if (credits?.has_credits && credits.balance) {
		rows.push({label: 'Credits', value: `${credits.balance} credits`});
	} else if (credits?.has_credits) {
		rows.push({label: 'Credits', value: 'Available'});
	}
	const monthly = payload.spend_control?.individual_limit;
	if (monthly?.remaining_percent != null) {
		const used = Number(monthly.used);
		const cap = Number(monthly.limit);
		const detail =
			Number.isFinite(used) && Number.isFinite(cap)
				? ` · ${used} of ${cap} credits used`
				: '';
		rows.push({
			label: 'Monthly limit',
			value:
				codexWindowValue(100 - monthly.remaining_percent, monthly.resets_at) +
				detail,
		});
	}
	return rows;
}

/** `monthly` → `Monthly` (codex parity: `capitalize_first`). */
function capitalize(text: string): string {
	return text.length === 0
		? text
		: text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Live codex limits for `/status` (codex account connections only). Fails
 * silently to `[]` (no login, 401, offline) so the modal never blocks.
 */
export async function fetchCodexLimits(baseUrl: string): Promise<StatusRow[]> {
	const cacheKey = baseUrl.replace(/\/+$/, '');
	const cached = limitsCache.get(cacheKey);
	if (cached && Date.now() - cached.at < LIMITS_TTL_MS) return cached.rows;
	try {
		const auth = readCodexAuth();
		if (!auth.accessToken) return [];
		// The codex account provider's baseUrl carries the `/codex` suffix;
		// `/wham/usage` lives on the backend root (codex-rs parity).
		const backend = cacheKey.replace(/\/codex$/, '');
		const response = await fetch(`${backend}/wham/usage`, {
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${auth.accessToken}`,
				...(auth.accountId ? {'chatgpt-account-id': auth.accountId} : {}),
				originator: 'bobonyo',
			},
		});
		if (!response.ok) return [];
		const body = (await response.json()) as CodexUsagePayload;
		const rows = codexLimitRows(body);
		if (rows.length === 0) return [];
		limitsCache.set(cacheKey, {at: Date.now(), rows});
		return rows;
	} catch {
		return [];
	}
}
