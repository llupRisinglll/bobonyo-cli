import {
	listProviders,
	type ProviderConfig,
	type ResolvedProvider,
} from '../config';
import {PROVIDER_PRESETS, type ProviderPreset} from './provider-presets';
export {
	codexAccountProvider,
	codexApiKeyProvider,
	deepseekProvider,
	xiaomiProvider,
	openAICompatibleProvider,
	buildPresetProvider,
	customProvider,
} from './provider-builders';

export interface PickerRow {
	kind: 'provider' | 'custom' | 'header' | 'empty';
	preset?: ProviderPreset;
	/** How many configured providers are instances of this preset. */
	count?: number;
	label?: string;
}

/** Search filter for the picker (pure, unit-tested). */
export function filterConnectPicker(
	rows: PickerRow[],
	query: string,
): PickerRow[] {
	const q = query.trim().toLowerCase();
	const out: PickerRow[] = [];
	// The nearest unmatched group header is kept when one of its items
	// matches (opencode groups the picker; a search keeps the group label).
	let pendingHeader: PickerRow | null = null;
	for (const row of rows) {
		if (row.kind === 'header') {
			pendingHeader = row;
			continue;
		}
		if (row.kind === 'empty') continue;
		const label = row.preset?.title ?? 'Custom provider';
		if (!q || label.toLowerCase().includes(q)) {
			if (pendingHeader) {
				out.push(pendingHeader);
				pendingHeader = null;
			}
			out.push(row);
		}
	}
	if (out.length === 0) out.push({kind: 'empty'});
	return out;
}

/**
 * Responsive provider-OPTION columns: the card auto-widens on big screens
 * and the options tile into 3 columns when there is room, 2 on medium
 * cards, and stay a single column on narrow ones (small screens never get
 * the cramped grid). Pure, unit-tested.
 */
export function providerColumns(cardWidth: number): number {
	if (cardWidth >= 108) return 3;
	if (cardWidth >= 84) return 2;
	return 1;
}

/**
 * Blank-name default: the preset id, suffixed with `(n)` when already
 * connected, so repeated connects never clobber each other (pure).
 */
export function defaultProviderName(
	base: string,
	existing?: Array<{id: string}>,
): string {
	const ids = new Set(
		(existing ?? listProviders()).map(provider => provider.id.toLowerCase()),
	);
	if (!ids.has(base.toLowerCase())) return base;
	let n = 2;
	while (ids.has(`${base} (${n})`.toLowerCase())) n += 1;
	return `${base} (${n})`;
}

/**
 * The configured providers that ARE instances of a preset (same matching as
 * presetConnectionCount): by default id + `(n)` suffixes, by the normalized
 * endpoint, or — for Codex — the ChatGPT-account backend. Pure, unit-tested.
 */
function isOpenCodePreset(preset: ProviderPreset): boolean {
	return preset.id === 'opencode-zen' || preset.id === 'opencode-go';
}

export function presetConnections(
	preset: ProviderPreset,
	providers?: Array<{id: string; baseUrl: string}>,
): Array<{id: string; baseUrl: string}> {
	const list = providers ?? listProviders();
	const normalize = (url: string): string =>
		url.replace(/\/+$/, '').replace(/\/v1$/, '');
	const presetBase = normalize(preset.baseUrl);
	const codexAccountBase = normalize('https://chatgpt.com/backend-api/codex');
	return list.filter(provider => {
		if (isOpenCodePreset(preset)) {
			const providerBase = normalize(provider.baseUrl);
			return (
				provider.id.toLowerCase() === 'opencode-zen' ||
				provider.id.toLowerCase().startsWith('opencode-zen (') ||
				provider.id.toLowerCase() === 'opencode-go' ||
				provider.id.toLowerCase().startsWith('opencode-go (') ||
				providerBase === normalize('https://opencode.ai/zen/v1') ||
				providerBase === normalize('https://opencode.ai/zen/go/v1')
			);
		}
		const id = provider.id.toLowerCase();
		if (id === preset.id.toLowerCase()) return true;
		if (id.startsWith(`${preset.id.toLowerCase()} (`)) return true;
		if (preset.id === 'custom') return false;
		const base = normalize(provider.baseUrl);
		if (base === presetBase) return true;
		return preset.id === 'codex' && base === codexAccountBase;
	});
}

/**
 * How many configured providers are instances of a preset: matching by the
 * default id, by the (normalized) endpoint, or — for Codex — by the
 * ChatGPT-account backend. Same endpoint under different names counts once
 * per connection (pure, unit-tested).
 */
export function presetConnectionCount(
	preset: ProviderPreset,
	providers?: Array<{id: string; baseUrl: string}>,
): number {
	const list = providers ?? listProviders();
	const normalize = (url: string): string =>
		url.replace(/\/+$/, '').replace(/\/v1$/, '');
	const presetBase = normalize(preset.baseUrl);
	const codexAccountBase = normalize('https://chatgpt.com/backend-api/codex');
	return list.filter(provider => {
		const id = provider.id.toLowerCase();
		// Default-id connections and their `(n)` suffixes count as instances
		// (a custom flow that kept the default name is still a custom).
		if (id === preset.id.toLowerCase()) return true;
		if (id.startsWith(`${preset.id.toLowerCase()} (`)) return true;
		if (preset.id === 'custom') return false;
		const base = normalize(provider.baseUrl);
		if (base === presetBase) return true;
		return preset.id === 'codex' && base === codexAccountBase;
	}).length;
}

/**
 * Mask a stored API key for the edit placeholder: the first and last few
 * characters stay readable (so the user can recognize WHICH key it is),
 * the middle is hidden. `ENV:VAR` references keep their shape (`ENV:…VAR`).
 * Pure, unit-tested.
 */
export function maskSecret(secret: string): string {
	const value = secret.trim();
	if (!value) return '';
	if (value.length <= 8) {
		return value.length <= 4
			? '•'.repeat(value.length)
			: `${value.slice(0, 2)}…${value.slice(-2)}`;
	}
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Edit-mode placeholder for a custom-form step: the input stays BLANK (a
 * blank field means KEEP the current value), and the placeholder shows the
 * existing value with a "leave blank to keep" note. The API key is masked
 * (maskSecret). Returns undefined for non-edit steps (the caller keeps the
 * fresh-connect hint). Pure, unit-tested.
 */
export function editPlaceholder(
	step: 'custom-base' | 'custom-key' | 'custom-models' | 'custom-name',
	provider?: ResolvedProvider,
): string | undefined {
	if (!provider) return undefined;
	switch (step) {
		case 'custom-base':
			return `leave blank to keep ${provider.baseUrl}`;
		case 'custom-key':
			return provider.apiKey
				? `leave blank to keep ${maskSecret(provider.apiKey)}`
				: 'optional — no key set';
		case 'custom-models':
			return provider.models.length > 0
				? `leave blank to keep ${provider.models.join(', ')}`
				: 'optional';
		case 'custom-name':
			return `leave blank to keep ${provider.id}`;
	}
}

/**
 * The known preset an existing provider is an instance of — matched by the
 * default id (+ its `(n)` suffixes) or by the normalized endpoint (same
 * rules as presetConnections). A known preset's endpoint is ALREADY known,
 * so the edit flow never asks for the base URL again; only providers with
 * their own endpoint (Custom / a modified base) go through the base step.
 * Pure, unit-tested.
 */
export function knownPresetFor(provider: {
	id: string;
	baseUrl: string;
}): ProviderPreset | undefined {
	const normalize = (url: string): string =>
		url.replace(/\/+$/, '').replace(/\/v1$/, '');
	const id = provider.id.toLowerCase();
	const base = normalize(provider.baseUrl);
	return PROVIDER_PRESETS.find(preset => {
		if (preset.id === 'custom') return false;
		if (id === preset.id || id.startsWith(`${preset.id} (`)) return true;
		return normalize(preset.baseUrl) === base;
	});
}

/**
 * Whether a provider's model catalog is auto-fetched: an explicit
 * `modelDiscoveryUrl`, or a Xiaomi token-plan host (config normalize
 * auto-adds `/models` discovery for those). Fetch-capable providers skip
 * the models step in the edit flow — the catalog refreshes itself, asking
 * for a static list would be pointless. Pure, unit-tested.
 */
export function providerFetchesModels(provider: {
	baseUrl: string;
	modelDiscoveryUrl?: string;
}): boolean {
	if (provider.modelDiscoveryUrl) return true;
	const base = provider.baseUrl.toLowerCase();
	return base.includes('xiaomimimo.com') && base.includes('token-plan');
}
