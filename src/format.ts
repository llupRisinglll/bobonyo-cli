/**
 * Shared number/duration formatting for the UI.
 *
 * Counts use the "shortcut" style: 7995 → `7.9K` (truncated, so 7995 never
 * rounds up to `8K`), 1_240_000 → `1.24M`. Durations prefer milliseconds
 * under a second and two-decimal seconds above: 0.2 → `200ms`, 1.98 → `1.98s`.
 */

function trimTrailingZeros(value: string): string {
	return value.replace(/\.?0+$/, '');
}

/** `7995` → `7.9K`, `1_240_000` → `1.24M`, `9` → `9`. */
export function formatCount(value: number): string {
	if (value >= 1_000_000) {
		const millions = Math.floor((value / 1_000_000) * 100) / 100;
		return `${trimTrailingZeros(millions.toFixed(2))}M`;
	}
	if (value >= 1_000) {
		const thousands = Math.floor((value / 1_000) * 10) / 10;
		return `${trimTrailingZeros(thousands.toFixed(1))}K`;
	}
	return String(value);
}

/** `0.2` → `200ms`, `1.98` → `1.98s`, `12` → `12s`. */
export function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, totalSeconds);
	if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
	return `${trimTrailingZeros(seconds.toFixed(2))}s`;
}
