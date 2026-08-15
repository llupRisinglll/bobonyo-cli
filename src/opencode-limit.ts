/**
 * opencode-go subscription-limit parity (opencode's `session/retry.ts`):
 * the opencode.ai gateway enforces rolling (5h), weekly and monthly usage
 * limits and, when a request trips one, returns a `GoUsageLimitError` (or
 * `FreeUsageLimitError` on the free tier) whose metadata carries
 * `limitName` + `workspace` and whose response header carries
 * `retry-after`. The dashboard's usage PERCENTAGES live in opencode.ai's
 * console database (not available to clients), so this reactive surfacing
 * is the only limit data a CLI can show.
 */

export const GO_UPSELL_URL = 'https://opencode.ai/go';
export const GO_UPSELL_MESSAGE = 'Free usage exceeded, subscribe to Go';

export interface OpenCodeLimitInfo {
	kind: 'go' | 'free';
	/** `5 hour` | `weekly` | `monthly` (Rolling/Weekly/Monthly Usage). */
	limitName?: string;
	workspace?: string;
	/** Seconds until the limit resets (`retry-after` header). */
	retryAfter?: number;
	link: string;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Detect + parse an opencode-go limit error from the raw response body and
 * headers. Returns null for every other provider/error. Pure, unit-tested.
 */
export function parseOpenCodeLimitError(
	body: string | undefined,
	headers?: Headers,
): OpenCodeLimitInfo | null {
	if (!body) return null;
	if (body.includes('FreeUsageLimitError')) {
		return {kind: 'free', link: GO_UPSELL_URL};
	}
	if (!body.includes('GoUsageLimitError')) return null;
	let metadata: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(body) as {
			metadata?: Record<string, unknown>;
			error?: {metadata?: Record<string, unknown>};
		};
		metadata = parsed.metadata ?? parsed.error?.metadata;
	} catch {
		// body may be a plain-text error; metadata stays undefined
	}
	const retryAfter = headers
		? finiteNumber(Number(headers.get('retry-after')))
		: undefined;
	const workspace =
		typeof metadata?.workspace === 'string' ? metadata.workspace : undefined;
	const limitName =
		typeof metadata?.limitName === 'string' ? metadata.limitName : undefined;
	return {
		kind: 'go',
		limitName,
		workspace,
		retryAfter,
		link: workspace
			? `https://opencode.ai/workspace/${workspace}/go`
			: GO_UPSELL_URL,
	};
}

/**
 * Human reset time from seconds: `5 hours 0 minutes`, `1 day 18 hours`,
 * `less than a minute` (opencode's retry.ts formatting). Pure, unit-tested.
 */
export function formatLimitResetTime(retryAfter: number): string {
	const seconds = Math.max(0, Math.ceil(retryAfter));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.ceil((seconds % 3_600) / 60);
	const unit = (value: number, name: string) =>
		`${value} ${name}${value === 1 ? '' : 's'}`;
	if (days > 0)
		return hours > 0
			? `${unit(days, 'day')} ${unit(hours, 'hour')}`
			: unit(days, 'day');
	if (hours > 0)
		return minutes > 0
			? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`
			: unit(hours, 'hour');
	return minutes > 0 ? unit(minutes, 'minute') : 'less than a minute';
}

/**
 * The user-facing message for a limit error (opencode parity):
 * `Weekly usage limit reached. It will reset in 1 day 18 hours. …`
 * Pure, unit-tested.
 */
export function formatOpenCodeLimitMessage(
	info: OpenCodeLimitInfo,
): string {
	if (info.kind === 'free') {
		return `${GO_UPSELL_MESSAGE} — ${info.link}`;
	}
	const name = info.limitName
		? `${info.limitName} usage limit`
		: 'Usage limit';
	const reset = info.retryAfter
		? ` It will reset in ${formatLimitResetTime(info.retryAfter)}.`
		: '';
	return (
		`${name} reached.${reset} ` +
		`To continue using this model now, enable usage from your available balance — ${info.link}`
	);
}
