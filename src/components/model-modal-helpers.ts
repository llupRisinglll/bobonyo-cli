import {knownPresetFor, maskSecret} from './connect-provider-modal';

export const EFFORT_LEVELS = [
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const;

export function effortLevelsForModel(model: string): string[] {
	const levels = ['minimal', 'low', 'medium', 'high'];
	if (/gpt-(?:5(?:\.[2-9])?|6(?:\.\d+)?)(?:-|$)|codex-max/i.test(model))
		levels.push('xhigh');
	if (/gpt-(?:5\.6|6(?:\.\d+)?)(?:-|$)/i.test(model)) levels.push('max');
	return levels;
}

export interface ModelProvider {
	id: string;
	name: string;
	baseUrl?: string;
	apiKey?: string;
	models: string[];
	modelEfforts: Record<string, string>;
	contextWindow?: number;
	modelContextWindows?: Record<string, number>;
}

export function modelWithProvider(
	model: string,
	provider?: ModelProvider,
): string {
	const parts = provider ? providerHeaderParts(provider) : undefined;
	const label = parts
		? parts.real
			? `${parts.user} · ${parts.real}`
			: parts.user
		: undefined;
	return label && model ? `${model} (${label})` : model;
}

export function providerDisplayName(provider: ModelProvider): string {
	const preset = provider.baseUrl
		? knownPresetFor({id: provider.id, baseUrl: provider.baseUrl})
		: undefined;
	return preset?.title ?? (provider.name || provider.id);
}

export function providerHeaderParts(provider: ModelProvider): {
	user: string;
	real?: string;
} {
	const user = provider.name || provider.id;
	const real = providerDisplayName(provider);
	return {user, real: real && real !== user ? real : undefined};
}

export function openCodeTierLabel(provider: ModelProvider): string {
	const preset = provider.baseUrl
		? knownPresetFor({id: provider.id, baseUrl: provider.baseUrl})
		: undefined;
	if (preset?.id === 'opencode-zen') return 'Zen (API usage)';
	if (preset?.id === 'opencode-go') return 'Go (Subscription)';
	return provider.name || provider.id;
}

export function connectionPickerRow(provider: ModelProvider): {
	label: string;
	detail: string;
} {
	const preset = provider.baseUrl
		? knownPresetFor({id: provider.id, baseUrl: provider.baseUrl})
		: undefined;
	// The account picker identifies the CREATED connection: the MASKED API
	// key (first + last chars — maskSecret) when one exists, the endpoint
	// otherwise (keyless anonymous tiers, custom providers).
	const keyDetail = provider.apiKey ? maskSecret(provider.apiKey) : '';
	if (preset?.id === 'opencode-zen' || preset?.id === 'opencode-go') {
		return {
			label: provider.name || provider.id,
			detail:
				keyDetail ||
				`${openCodeTierLabel(provider)} · ${provider.baseUrl ?? ''}`,
		};
	}
	return {
		label: provider.name || provider.id,
		detail: keyDetail || provider.baseUrl || '',
	};
}

export function openCodeTierOf(
	provider: ModelProvider,
): 'zen' | 'go' | undefined {
	const preset = provider.baseUrl
		? knownPresetFor({id: provider.id, baseUrl: provider.baseUrl})
		: undefined;
	if (preset?.id === 'opencode-zen') return 'zen';
	if (preset?.id === 'opencode-go') return 'go';
	return undefined;
}

export function distinctOpenCodeTiers(
	providers: ModelProvider[],
): Array<'zen' | 'go'> {
	const tiers: Array<'zen' | 'go'> = [];
	if (providers.some(provider => openCodeTierOf(provider) === 'zen')) {
		tiers.push('zen');
	}
	if (providers.some(provider => openCodeTierOf(provider) === 'go')) {
		tiers.push('go');
	}
	return tiers;
}

export function providerGroupKey(provider: ModelProvider): string {
	const preset = provider.baseUrl
		? knownPresetFor({id: provider.id, baseUrl: provider.baseUrl})
		: undefined;
	// OpenCode Zen and OpenCode Go share the SAME opencode.ai account/API
	// key — a subscription unlocks both catalogs (the zen endpoint even
	// lists the go models). They must merge into ONE group, otherwise a user
	// who connected both sees the same service twice in the model modal.
	if (preset?.id === 'opencode-zen' || preset?.id === 'opencode-go') {
		return 'opencode';
	}
	return preset?.id ?? provider.id;
}

export function groupProviders(providers: ModelProvider[]): ProviderGroup[] {
	const byKey = new Map<string, ProviderGroup>();
	for (const provider of providers) {
		const key = providerGroupKey(provider);
		let group = byKey.get(key);
		if (!group) {
			group = {
				providerId: key,
				// The merged OpenCode group reads just "OpenCode": Zen and Go
				// share one account, the TIER is chosen per connection in the
				// account picker (openCodeTierLabel / connectionPickerRow).
				title: key === 'opencode' ? 'OpenCode' : providerDisplayName(provider),
				connections: [],
				models: [],
			};
			byKey.set(key, group);
		}
		group.connections.push(provider);
		for (const model of provider.models) {
			if (!group.models.includes(model)) group.models.push(model);
		}
	}
	return [...byKey.values()];
}

export interface ProviderGroup {
	providerId: string;
	title: string;
	connections: ModelProvider[];
	models: string[];
}

export function sameProviderGroup(
	a: ModelProvider | undefined,
	b: ModelProvider | undefined,
): boolean {
	if (!a || !b) return false;
	return providerGroupKey(a) === providerGroupKey(b);
}

export function initialModelRowIndex(
	rows: ReadonlyArray<{kind: string; isCurrent?: boolean}>,
): number {
	const current = rows.findIndex(row => row.kind === 'model' && row.isCurrent);
	if (current !== -1) return current;
	return rows.findIndex(row => row.kind === 'model' || row.kind === 'inherit');
}

export function connectProviderShortcut(
	focus: 'search' | 'list',
	key: string,
): boolean {
	return key === 'c' && focus === 'list';
}

export function nextModelCursor(
	current: number,
	direction: 'up' | 'down' | 'left' | 'right',
	groupSizes: number[],
	columns: number,
	hasInherit: boolean,
): number {
	const total = groupSizes.reduce((sum, size) => sum + size, 0);
	if (total === 0) return current;
	if (current === -1) {
		return direction === 'down' ? 0 : current;
	}
	// Locate the provider group + local index for this global cursor.
	let remaining = current;
	let groupIndex = 0;
	while (
		groupIndex < groupSizes.length &&
		remaining >= (groupSizes[groupIndex] ?? 0)
	) {
		remaining -= groupSizes[groupIndex] ?? 0;
		groupIndex += 1;
	}
	if (groupIndex >= groupSizes.length) return current;
	const local = remaining;
	const count = groupSizes[groupIndex] ?? 0;
	const col = local % columns;
	const offset = (group: number): number =>
		groupSizes.slice(0, group).reduce((sum, size) => sum + size, 0);
	const hasNextGroup = (): boolean =>
		groupIndex + 1 < groupSizes.length && (groupSizes[groupIndex + 1] ?? 0) > 0;
	switch (direction) {
		case 'left': {
			if (local > 0) return offset(groupIndex) + local - 1;
			if (groupIndex > 0) {
				return offset(groupIndex - 1) + (groupSizes[groupIndex - 1] ?? 0) - 1;
			}
			return current;
		}
		case 'right': {
			if (local + 1 < count) return offset(groupIndex) + local + 1;
			if (hasNextGroup()) return offset(groupIndex + 1);
			return current;
		}
		case 'up': {
			if (local < columns) {
				// FIRST ROW of the group: exit UPWARD — the previous group's
				// last cell, or the Inherit row above the very first group.
				// NEVER wrap to the bottom of this group: that would trap the
				// cursor inside one provider and make anything above the list
				// unreachable with ↑. Only at the very top of the whole grid
				// (no previous group, no Inherit) does the column wrap to its
				// bottom row — single-group cycle parity with ↓.
				if (groupIndex > 0) {
					return offset(groupIndex - 1) + (groupSizes[groupIndex - 1] ?? 0) - 1;
				}
				if (hasInherit) return -1;
				const bottomRow = Math.max(0, Math.floor((count - 1) / columns));
				const bottom = bottomRow * columns + col;
				return bottom < count ? bottom : Math.max(0, bottom - columns);
			}
			return offset(groupIndex) + (local - columns);
		}
		case 'down': {
			const next = local + columns;
			if (next < count) return offset(groupIndex) + next;
			if (hasNextGroup()) return offset(groupIndex + 1);
			return offset(groupIndex) + (col < count ? col : 0);
		}
	}
	return current;
}
