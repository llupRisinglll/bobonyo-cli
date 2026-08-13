/** @jsxImportSource @opentui/solid */
import {createMemo, Show} from 'solid-js';
import {useTerminalDimensions} from '@opentui/solid';
import {
	activeEndpoint,
	activeAgents,
	deepSeekBalance,
	mode,
	providerUsage,
	toolProfile,
} from '../state';
import {bgTasks} from '../bash';
import {createTextAttributes} from '@opentui/core';
import {resolveProfile} from '../tools';
import {colors} from '../theme';
import {statusPathLabel} from '../status-path';
import {formatCacheRate, formatMonthlyUsage, formatTokens} from '../provider-usage';
import {isDeepSeek, isXiaomiMiMo} from '../deepseek';

/**
 * Mode line, parity flavor of nanocoder's footer: mode · model · ctx.
 */
export function Status() {
	const terminalDimensions = useTerminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const bg = createMemo(() => {
		const count = bgTasks().filter(task => task.running).length;
		return count > 0 ? ` · bg: ${count}` : '';
	});
	const agents = createMemo(() => {
		const count = activeAgents();
		return count > 0 ? ` · agents: ${count}` : '';
	});
	const modeLabel = createMemo(() => {
		const current = mode();
		return current === 'yolo' ? 'yolo' : `${current} mode`;
	});
	// Parity: the tune label shows the RESOLVED profile, and flags its auto
	// origin with `(auto)` on wide terminals (narrow ones drop the suffix).
	const tuneLabel = createMemo(() => {
		const chosen = toolProfile();
		const resolved = resolveProfile(chosen, activeEndpoint().model);
		const wide = (terminalDimensions().width ?? 80) >= 100;
		return chosen === 'auto' && wide ? `tune: ${resolved} (auto)` : `tune: ${resolved}`;
	});
	// `Cred: $n` (DeepSeek) between tune and the counts; label secondary,
	// amount primary — mirrors the `tune:` two-tone pair.
	const credSegment = () => {
		const balance = deepSeekBalance();
		if (!isDeepSeek(activeEndpoint()) || !balance) return '';
		const symbol =
			balance.currency === 'USD'
				? '$'
				: balance.currency === 'CNY'
					? '¥'
					: `${balance.currency} `;
		return ` · Cred: ${symbol}${balance.total.toFixed(2)}`;
	};
	// `· cache 100K/1.5M (10% miss)` (DeepSeek): the balance only refreshes
	// every 5 minutes, but the per-turn usage block reports
	// `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` — the monthly
	// ledger accumulates them so the status line shows the REAL cost driver
	// live, updating after every turn. Two-tone like `Cred:`.
	const cacheRateSegment = () => {
		if (!isDeepSeek(activeEndpoint())) return '';
		const label = formatCacheRate(providerUsage());
		return label ? ` · cache ${label}` : '';
	};
	// `used N.NM` (Xiaomi MiMo token plan): the quota endpoint is browser-
	// cookie only, so the harness accumulates each turn's `usage` block into
	// a monthly ledger (see src/provider-usage.ts). Same two-tone treatment
	// as `Cred:` / `tune:`. Gated to the MiMo gateway: DeepSeek shows `Cred:`
	// instead, other providers show neither.
	const usageSegment = () => {
		if (!isXiaomiMiMo(activeEndpoint())) return '';
		const label = formatMonthlyUsage(providerUsage());
		return label ? ` · ${label}` : '';
	};
	const cwdLabel = createMemo(() => {
		const cwd = process.cwd();
		const user = process.env.USER ?? 'user';
		// Keep the footer on ONE row (a wrapped status line would paint over
		// the input box's bottom border on narrow panes): size the path to the
		// remaining width after the FULL left segment (mode/tune/model/ctx/
		// agents/bg, forgetting any part makes the line overflow and OpenTUI
		// clips `~N%`/`bg: N` digits out of the middle nodes).
		const width = Math.max(24, (terminalDimensions().width ?? 80) - 2);
		const left =
			`⏵⏵⏵ ${modeLabel()} · tune: ` +
			`${tuneLabel().replace(/^tune:\s*/, '')}` +
			credSegment() +
			cacheRateSegment() +
			usageSegment() +
			// agents/bg counts appear mid-line, budget them too or a narrow
			// pane clips the `bg: 1` digit at the status-line edge.
			agents() +
			bg();
		return statusPathLabel({left, user, cwd, width});
	});
	return (
		<box flexDirection="row" height={1}>
			<text fg={colors().error} attributes={bold()}>⏵⏵⏵ {modeLabel()}</text>
			{/* Leading spaces live in the FOLLOWING node, OpenTUI trims
			    trailing whitespace from a text node, which ate the space
			    between `tune:` and the value. */}
			<text fg={colors().secondary}> · tune:</text>
			<text fg={colors().primary}> {tuneLabel().replace(/^tune:\s*/, '')}</text>
			<Show when={isDeepSeek(activeEndpoint()) && deepSeekBalance()}>
				<text fg={colors().secondary}> · Cred:</text>
				<text fg={colors().primary}>
					{' '}
					{deepSeekBalance()!.currency === 'USD'
						? '$'
						: deepSeekBalance()!.currency === 'CNY'
							? '¥'
							: `${deepSeekBalance()!.currency} `}
					{deepSeekBalance()!.total.toFixed(2)}
				</text>
			</Show>
			<Show when={isDeepSeek(activeEndpoint()) && formatCacheRate(providerUsage())}>
				<text fg={colors().secondary}> · cache</text>
				<text fg={colors().primary}>
					{' '}
					{formatCacheRate(providerUsage())}
				</text>
			</Show>
			<Show when={isXiaomiMiMo(activeEndpoint()) && formatMonthlyUsage(providerUsage())}>
				<text fg={colors().secondary}> · used</text>
				<text fg={colors().primary}>
					{' '}
					{formatTokens(providerUsage()!.totalTokens)}
				</text>
			</Show>
			<text fg={colors().secondary}>{agents()}</text>
			<text fg={colors().secondary}>{bg()}</text>
			<box flexGrow={1} />
			<text fg={colors().secondary}>{cwdLabel()}</text>
		</box>
	);
}
