/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {
	listProviders,
	type ProviderConfig,
	type ResolvedProvider,
} from '../config';
import {spinnerFrame} from '../state';
import {wrapText} from '../text-wrap';
import {
	codexAuthSummary,
	hasCodexChatgptAuth,
	readCodexAuth,
} from '../codex-auth';

/**
 * OpenCode-style provider connect MODAL (parity: opencode's
 * dialog-provider). NEVER the chat input row: a provider picker → auth
 * method selection → in-modal prompt steps. Presets know their endpoints,
 * so only the API key is asked (plus an OPTIONAL name, LAST); custom
 * providers ask base URL → key → models → name. A blank name uses the
 * preset id with a `(n)` suffix when it is already connected, so the same
 * endpoint can exist under multiple names (model org/splitting). Rows use
 * the settings-list navigation/highlight language (always-bold labels,
 * active row background + fg).
 */

const CODEX_MODELS = [
	'gpt-5.5-codex',
	'gpt-5.5-codex-high',
	'gpt-5.4-codex',
	'gpt-5.4-codex-mini',
];
/**
 * The ChatGPT-ACCOUNT codex backend's model catalog (fetched live from
 * /backend-api/codex/models). The `gpt-5.5-codex` family is API-key-only —
 * the account endpoint rejects it with 400.
 */
const CODEX_ACCOUNT_MODELS = [
	'gpt-5.5',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'gpt-5.4-mini',
];

// The CURRENT DeepSeek catalog (the /models endpoint returns v4-flash/v4-pro;
// the live fetch refreshes it after connect, these seeds just keep the picker
// honest before/without a key).
const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

const XIAOMI_MODELS = [
	'mimo-v2.5',
	'mimo-v2.5-pro',
	'mimo-v2.5-asr',
	'mimo-v2.5-tts',
];

/**
 * OpenCode Zen catalog seeds (live `/zen/v1/models` refresh replaces these
 * after connect). The `*-free` models work WITHOUT a subscription — the
 * reason a blank key is allowed for this preset.
 */
const OPENCODE_ZEN_MODELS = [
	'deepseek-v4-flash-free',
	'mimo-v2.5-free',
	'hy3-free',
	'nemotron-3-ultra-free',
	'nemotron-3.5-lightning-free',
	'laguna-s-2.1-free',
	'big-pickle',
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'gpt-5.5',
	'claude-opus-5',
	'deepseek-v4-flash',
	'deepseek-v4-pro',
	'qwen3.6-plus',
	'kimi-k3',
];

/** OpenCode Go catalog seeds (subscription; live refresh replaces these). */
const OPENCODE_GO_MODELS = [
	'deepseek-v4-flash',
	'deepseek-v4-pro',
	'glm-5.2',
	'kimi-k2.7-code',
	'qwen3.8-max',
	'qwen3.7-plus',
	'minimax-m3',
	'gpt-5.6-luna',
	'grok-4.5',
	'mimo-v2.5-pro',
];

export interface ProviderPreset {
	/** Default provider id/name; a blank name falls back to this. */
	id: string;
	title: string;
	description: string;
	category: 'Popular' | 'Providers';
	/** Known endpoint — presets NEVER ask for it (custom does). */
	baseUrl: string;
	/** Seeded catalog so the picker never shows mock-model-1 before discovery. */
	models: string[];
	modelDiscoveryUrl?: string;
	sdkProvider?: string;
	/** ChatGPT-account mode (responses wire via ~/.codex/auth.json). */
	codexAccount?: boolean;
	contextWindow?: number;
	/** Codex offers a ChatGPT-account method; every other preset is key-only. */
	authMethods?: Array<{id: 'account' | 'api'; label: string; detail: string}>;
	/** Key OPTIONAL — a blank key connects anyway (anonymous free tier). */
	optionalKey?: boolean;
}

/**
 * Preset catalog. Scope = providers the harness can ACTUALLY talk to with
 * the existing wires (openai-compatible, anthropic, responses); the list is
 * inspired by opencode's provider catalog. Most carry a `/models` discovery
 * URL so the real catalog replaces the seeds after connect.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: 'codex',
		title: 'Codex',
		description: 'ChatGPT account or API key',
		category: 'Popular',
		baseUrl: 'https://api.openai.com/v1',
		models: CODEX_MODELS,
		modelDiscoveryUrl: 'https://api.openai.com/v1/models',
		sdkProvider: 'responses',
		contextWindow: 400_000,
		authMethods: [
			{
				id: 'account',
				label: 'ChatGPT account (codex login)',
				detail: 'Uses ~/.codex/auth.json',
			},
			{id: 'api', label: 'API key', detail: 'sk-... or env:VAR'},
		],
	},
	{
		id: 'openai',
		title: 'OpenAI',
		description: 'gpt-5.5 / gpt-5.4',
		category: 'Popular',
		baseUrl: 'https://api.openai.com/v1',
		models: ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5.4', 'gpt-5.4-mini'],
		modelDiscoveryUrl: 'https://api.openai.com/v1/models',
	},
	{
		id: 'anthropic',
		title: 'Anthropic',
		description: 'claude-sonnet / claude-opus',
		category: 'Popular',
		baseUrl: 'https://api.anthropic.com',
		models: ['claude-sonnet-4-6', 'claude-opus-4', 'claude-sonnet-4-5'],
		sdkProvider: 'anthropic',
	},
	{
		id: 'openrouter',
		title: 'OpenRouter',
		description: 'one key, many models',
		category: 'Popular',
		baseUrl: 'https://openrouter.ai/api',
		models: ['openrouter/auto'],
		modelDiscoveryUrl: 'https://openrouter.ai/api/v1/models',
	},
	{
		id: 'deepseek',
		title: 'DeepSeek',
		description: 'deepseek-v4-flash / deepseek-v4-pro',
		category: 'Popular',
		baseUrl: 'https://api.deepseek.com',
		models: DEEPSEEK_MODELS,
		modelDiscoveryUrl: 'https://api.deepseek.com/models',
	},
	{
		id: 'xiaomi',
		title: 'Xiaomi MiMo',
		description: 'token-plan gateway (mimo-v2.5)',
		category: 'Popular',
		baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
		models: XIAOMI_MODELS,
		// normalize() auto-adds modelDiscoveryUrl for token-plan hosts.
	},
	{
		id: 'opencode-zen',
		title: 'OpenCode Zen',
		description: 'free models without a key, subscription unlocks more',
		category: 'Popular',
		baseUrl: 'https://opencode.ai/zen/v1',
		models: OPENCODE_ZEN_MODELS,
		modelDiscoveryUrl: 'https://opencode.ai/zen/v1/models',
		// Zen is the FREE source: a blank key still connects (anonymous
		// tier, IP-limited) so users without a subscription keep the
		// `*-free` models.
		optionalKey: true,
	},
	{
		id: 'opencode-go',
		title: 'OpenCode Go',
		description: 'low-cost subscription models',
		category: 'Popular',
		baseUrl: 'https://opencode.ai/zen/go/v1',
		models: OPENCODE_GO_MODELS,
		modelDiscoveryUrl: 'https://opencode.ai/zen/go/v1/models',
	},
	{
		id: 'mistral',
		title: 'Mistral',
		description: 'mistral-large',
		category: 'Providers',
		baseUrl: 'https://api.mistral.ai',
		models: ['mistral-large'],
		modelDiscoveryUrl: 'https://api.mistral.ai/v1/models',
	},
	{
		id: 'xai',
		title: 'xAI',
		description: 'grok-4',
		category: 'Providers',
		baseUrl: 'https://api.x.ai',
		models: ['grok-4'],
		modelDiscoveryUrl: 'https://api.x.ai/v1/models',
	},
	{
		id: 'groq',
		title: 'Groq',
		description: 'fast llama',
		category: 'Providers',
		baseUrl: 'https://api.groq.com/openai',
		models: ['llama-4-scout-17b-16e-instruct'],
		modelDiscoveryUrl: 'https://api.groq.com/openai/v1/models',
	},
	{
		id: 'cerebras',
		title: 'Cerebras',
		description: 'llama / deepseek on wafer',
		category: 'Providers',
		baseUrl: 'https://api.cerebras.ai',
		models: ['llama-3.3-70b'],
		modelDiscoveryUrl: 'https://api.cerebras.ai/v1/models',
	},
	{
		id: 'together',
		title: 'Together AI',
		description: 'open-source catalog',
		category: 'Providers',
		baseUrl: 'https://api.together.xyz',
		models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
		modelDiscoveryUrl: 'https://api.together.xyz/v1/models',
	},
	{
		id: 'fireworks',
		title: 'Fireworks AI',
		description: 'fast inference',
		category: 'Providers',
		baseUrl: 'https://api.fireworks.ai/inference',
		models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
		modelDiscoveryUrl: 'https://api.fireworks.ai/inference/v1/models',
	},
	{
		id: 'nvidia',
		title: 'NVIDIA',
		description: 'nemotron',
		category: 'Providers',
		baseUrl: 'https://integrate.api.nvidia.com',
		models: ['nvidia/llama-3.3-nemotron-super-49b-v1'],
		modelDiscoveryUrl: 'https://integrate.api.nvidia.com/v1/models',
	},
	{
		id: 'custom',
		title: 'Custom provider',
		description: 'Bring your own endpoint',
		category: 'Providers',
		baseUrl: '',
		models: [],
	},
];

type View =
	| {kind: 'pick'}
	| {kind: 'manage'}
	| {kind: 'methods'}
	| {kind: 'apikey'}
	| {kind: 'chatgpt'}
	| {kind: 'name'}
	| {kind: 'custom-base'}
	| {kind: 'custom-key'}
	| {kind: 'custom-models'}
	| {kind: 'custom-name'};

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

/** Codex provider payloads (pure, unit-tested). */
export function codexAccountProvider(name = 'codex'): ProviderConfig {
	return {
		id: name.trim() || 'codex',
		name: name.trim() || 'codex',
		baseUrl: 'https://chatgpt.com/backend-api/codex',
		sdkProvider: 'responses',
		codexAccount: true,
		contextWindow: 400_000,
		models: CODEX_ACCOUNT_MODELS,
	};
}

export function codexApiKeyProvider(
	apiKey: string,
	name = 'codex',
): ProviderConfig | null {
	const key = apiKey.trim();
	if (!key) return null;
	const id = name.trim() || 'codex';
	return {
		id,
		name: id,
		baseUrl: 'https://api.openai.com/v1',
		sdkProvider: 'responses',
		apiKey: key,
		modelDiscoveryUrl: 'https://api.openai.com/v1/models',
		contextWindow: 400_000,
		models: CODEX_MODELS,
	};
}

/** DeepSeek preset: known endpoint, discovery keeps the catalog fresh. */
export function deepseekProvider(name: string, apiKey: string): ProviderConfig {
	const id = name.trim() || 'deepseek';
	return {
		id,
		name: id,
		baseUrl: 'https://api.deepseek.com',
		...(apiKey.trim() ? {apiKey: apiKey.trim()} : {}),
		modelDiscoveryUrl: 'https://api.deepseek.com/models',
		models: DEEPSEEK_MODELS,
	};
}

/** Xiaomi MiMo token-plan preset (normalize adds the /models discovery). */
export function xiaomiProvider(name: string, apiKey: string): ProviderConfig {
	const id = name.trim() || 'xiaomi';
	return {
		id,
		name: id,
		baseUrl: 'https://token-plan-sgp.xiaomimimo.com',
		...(apiKey.trim() ? {apiKey: apiKey.trim()} : {}),
		models: XIAOMI_MODELS,
	};
}

/** Generic preset builder for OpenAI-compatible endpoints (pure). */
export function openAICompatibleProvider(
	preset: ProviderPreset,
	name: string,
	apiKey: string,
): ProviderConfig {
	const id = name.trim() || preset.id;
	return {
		id,
		name: id,
		baseUrl: preset.baseUrl,
		...(apiKey.trim() ? {apiKey: apiKey.trim()} : {}),
		...(preset.modelDiscoveryUrl
			? {modelDiscoveryUrl: preset.modelDiscoveryUrl}
			: {}),
		...(preset.sdkProvider ? {sdkProvider: preset.sdkProvider} : {}),
		...(preset.contextWindow ? {contextWindow: preset.contextWindow} : {}),
		models: preset.models,
	};
}

/** Build the provider for a preset + stashed API key (codex routes apart). */
export function buildPresetProvider(
	preset: ProviderPreset,
	name: string,
	apiKey: string,
): ProviderConfig | null {
	if (preset.id === 'codex') return codexApiKeyProvider(apiKey, name);
	// OpenCode Zen allows a BLANK key: the anonymous tier still serves the
	// free models, so a user without a subscription can connect anyway.
	if (!apiKey.trim() && !preset.optionalKey) return null;
	if (preset.id === 'deepseek') return deepseekProvider(name, apiKey);
	if (preset.id === 'xiaomi') return xiaomiProvider(name, apiKey);
	return openAICompatibleProvider(preset, name, apiKey);
}

export function customProvider(config: {
	id: string;
	baseUrl: string;
	apiKey?: string;
	models: string[];
}): ProviderConfig | null {
	const id = config.id.trim();
	const baseUrl = config.baseUrl.trim();
	if (!id || !baseUrl) return null;
	return {
		id,
		name: id,
		baseUrl,
		...(config.apiKey?.trim() ? {apiKey: config.apiKey.trim()} : {}),
		models: config.models,
	};
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
		return value.length <= 4 ? '•'.repeat(value.length) : `${value.slice(0, 2)}…${value.slice(-2)}`;
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

export function ConnectProviderModal(props: {
	provider?: string;
	editId?: string;
	onConnect: (provider: ProviderConfig) => void;
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	// AUTO-CLOSE GUARD (same as every other modal): ignore the opening
	// click's mouse-UP on the backdrop — a time window, NOT a one-shot flag.
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	const initialView = (): View[] => {
		if (props.provider && props.provider !== 'custom') {
			return [{kind: 'apikey'}, {kind: 'pick'}];
		}
		if (props.provider === 'custom' || props.editId) {
			return [{kind: 'custom-base'}, {kind: 'pick'}];
		}
		return [{kind: 'pick'}];
	};
	const [viewStack, setViewStack] = createSignal<View[]>(initialView());
	const view = () => viewStack()[viewStack().length - 1]!;
	const push = (next: View): void => {
		setViewStack(prev => [...prev, next]);
	};
	const back = (): void => {
		const stack = viewStack();
		if (stack.length > 1) setViewStack(stack.slice(0, -1));
		else props.onClose();
	};

	const [query, setQuery] = createSignal('');
	const [index, setIndex] = createSignal(0);
	const [methodIndex, setMethodIndex] = createSignal(0);
	const [input, setInput] = createSignal('');
	const [error, setError] = createSignal('');
	const [selectedPreset, setSelectedPreset] = createSignal<ProviderPreset>(
		PROVIDER_PRESETS[0]!,
	);
	/** The preset whose existing connections the manage step lists. */
	const [managePreset, setManagePreset] = createSignal<ProviderPreset>(
		PROVIDER_PRESETS[0]!,
	);
	const [manageIndex, setManageIndex] = createSignal(0);
	/** Stashed API key entered BEFORE the optional name step. */
	const [presetKey, setPresetKey] = createSignal('');
	/** Codex auth mode chosen in the methods step. */
	const [presetAuth, setPresetAuth] = createSignal<'account' | 'api'>('api');
	// Force auth.json re-reads (the "check again" action after `codex login`).
	const [authTick, setAuthTick] = createSignal(0);
	const auth = createMemo(() => {
		void authTick();
		return readCodexAuth();
	});

	// EDIT target: set from the settings/edit flow (props.editId) or by the
	// manage step when the user edits an existing connection.
	const [editTargetId, setEditTargetId] = createSignal<string | null>(
		props.editId ?? null,
	);
	// REACTIVE on purpose: the manage step switches the edit target
	// mid-modal (editTargetId starts null and is set on selection). A plain
	// const would capture `undefined` at mount and the edit flow would lose
	// the keep-old fallbacks (name/key/models) AND the edit placeholders.
	// REACTIVE on purpose: the manage step switches the edit target
	// mid-modal (editTargetId starts null and is set on selection). A plain
	// const would capture `undefined` at mount and the edit flow would lose
	// the keep-old fallbacks (name/key/models) AND the edit placeholders.
	const editProvider = createMemo(() =>
		editTargetId()
			? listProviders().find(
					provider =>
						provider.id.toLowerCase() ===
						editTargetId()!.toLowerCase(),
				)
			: undefined,
	);

	// The custom edit fields stay BLANK: editing an existing connection
	// means "blank = keep the current value" (the placeholder shows the old
	// value + the keep hint). Nothing is ever staged from the old provider.
	const [customBase, setCustomBase] = createSignal('');
	const [customKey, setCustomKey] = createSignal('');
	const [customModels, setCustomModels] = createSignal('');

	const stepDefault = (current: View): string => {
		switch (current.kind) {
			// The name is OPTIONAL and asked LAST — start empty; the default
			// (id + `(n)` when taken) applies when nothing is typed.
			case 'name':
			case 'custom-name':
				return '';
			case 'custom-base':
				return customBase();
			case 'custom-key':
				return customKey();
			case 'custom-models':
				return customModels();
			default:
				return '';
		}
	};
	// On view change the input starts from that step's stored value; typing
	// never rewrites it (the stored value only changes on submit). The
	// effect tracks the VIEW ITSELF, not the derived default: two steps with
	// the same default ('' API key → '' name) would otherwise keep the
	// previous step's typed text in the input.
	createEffect(() => {
		setInput(stepDefault(view()));
		setError('');
	});

	// Provider OPTIONS: a settings-style list on narrow screens that tiles
	// into 2-3 columns when the card is wide enough (providerColumns).
	const pickerRows = (): PickerRow[] => {
		const configured = listProviders();
		const rows: PickerRow[] = [];
		let lastCategory: string | null = null;
		for (const preset of PROVIDER_PRESETS) {
			if (preset.category !== lastCategory) {
				rows.push({kind: 'header', label: preset.category});
				lastCategory = preset.category;
			}
			rows.push({
				kind: preset.id === 'custom' ? ('custom' as const) : ('provider' as const),
				preset,
				count: presetConnectionCount(preset, configured),
			});
		}
		return filterConnectPicker(rows, query());
	};
	const gridItems = (): PickerRow[] =>
		pickerRows().filter(
			row => row.kind === 'provider' || row.kind === 'custom',
		);
	// Grid navigation (row-major). Left/right wrap across columns; up/down
	// wrap to the top/bottom of the same column (mirrors the model modal).
	const moveGrid = (direction: 'up' | 'down' | 'left' | 'right'): void => {
		const items = gridItems();
		const cols = columns();
		const total = items.length;
		if (total === 0) return;
		const current = index();
		const col = current % cols;
		let next: number;
		switch (direction) {
			case 'left':
				next = (current - 1 + total) % total;
				break;
			case 'right':
				next = (current + 1) % total;
				break;
			case 'up': {
				next = current - cols;
				if (next < 0) {
					const bottomRow = Math.max(0, Math.floor((total - 1) / cols));
					const bottom = bottomRow * cols + col;
					next = bottom < total ? bottom : Math.max(0, bottom - cols);
				}
				break;
			}
			case 'down': {
				next = current + cols;
				if (next >= total) next = col;
				break;
			}
		}
		setIndex(Math.max(0, Math.min(total - 1, next)));
	};
	const activatePicker = (): void => {
		const row = gridItems()[index()];
		if (!row?.preset) return;
		if (row.kind === 'custom') {
			push({kind: 'custom-base'});
			return;
		}
		setSelectedPreset(row.preset);
		setPresetAuth('api');
		setInput('');
		// Already-connected providers offer a MANAGE step first: edit the
		// existing instances or connect a new one.
		if (presetConnections(row.preset).length > 0) {
			setManagePreset(row.preset);
			setManageIndex(0);
			push({kind: 'manage'});
			return;
		}
		if (row.preset.authMethods?.length) push({kind: 'methods'});
		else push({kind: 'apikey'});
	};
	const startNewConnection = (): void => {
		const preset = selectedPreset();
		if (preset.authMethods?.length) push({kind: 'methods'});
		else push({kind: 'apikey'});
	};
	/** Rows of the manage step: each existing connection + "new" entry. */
	const manageRows = (): Array<{id: string; baseUrl: string} | null> => {
		const preset = managePreset();
		return [...presetConnections(preset), null];
	};
	const activateManage = (): void => {
		const rows = manageRows();
		const selected = rows[manageIndex()];
		if (!selected) {
			startNewConnection();
			return;
		}
		// Edit the existing connection through the prefilled custom flow.
		setEditTargetId(selected.id);
		push({kind: 'custom-base'});
	};

	const submitApiKey = (): void => {
		setPresetKey(input().trim());
		push({kind: 'name'});
	};
	const connectPreset = (): void => {
		const preset = selectedPreset();
		const name = input().trim() || defaultProviderName(preset.id);
		if (presetAuth() === 'account') {
			props.onConnect(codexAccountProvider(name));
			return;
		}
		const provider = buildPresetProvider(preset, name, presetKey());
		if (!provider) {
			setError('API key is required.');
			return;
		}
		props.onConnect(provider);
	};
	const connectChatgpt = (): void => {
		// ChatGPT-account mode: login confirmed → the optional name is asked
		// LAST (same flow as the key path); not logged in → re-check.
		if (hasCodexChatgptAuth(auth())) {
			setPresetAuth('account');
			push({kind: 'name'});
			return;
		}
		setAuthTick(tick => tick + 1);
	};
	const submitCustom = (): void => {
		switch (view().kind) {
			case 'custom-base': {
				const baseUrl = input().trim();
				if (!baseUrl) {
					// Editing an existing connection: a blank field KEEPS the
					// current endpoint (the placeholder says so). A fresh
					// custom connect still requires a base URL.
					if (editProvider()?.baseUrl) {
						setCustomBase(editProvider()!.baseUrl);
						push({kind: 'custom-key'});
						return;
					}
					setError('Base URL is required.');
					return;
				}
				setCustomBase(baseUrl);
				push({kind: 'custom-key'});
				return;
			}
			case 'custom-key': {
				setCustomKey(input().trim());
				push({kind: 'custom-models'});
				return;
			}
			case 'custom-models': {
				setCustomModels(input());
				push({kind: 'custom-name'});
				return;
			}
			case 'custom-name': {
				const models = customModels()
					.split(',')
					.map(model => model.trim())
					.filter(Boolean);
				const id =
					input().trim() ||
					(editProvider()?.id || defaultProviderName('custom'));
				const provider = customProvider({
					id,
					baseUrl: customBase(),
					apiKey:
						customKey() ||
						(editProvider()?.apiKeyResolved
							? editProvider()!.apiKey
							: undefined),
					models:
						models.length > 0
							? models
							: (editProvider()?.models ?? []),
				});
				if (!provider) return;
				// Editing an existing connection keeps its wire fields
				// (responses/anthropic, codexAccount, discovery, context
				// window) — the custom form only edits id/base/key/models.
				props.onConnect(
					editProvider()
						? {
								...provider,
								...(editProvider()!.sdkProvider
									? {sdkProvider: editProvider()!.sdkProvider}
									: {}),
								...(editProvider()!.codexAccount
									? {
											codexAccount:
												editProvider()!.codexAccount,
										}
									: {}),
								...(editProvider()!.modelDiscoveryUrl
									? {
											modelDiscoveryUrl:
												editProvider()!
													.modelDiscoveryUrl,
										}
									: {}),
								...(editProvider()!.contextWindow
									? {
											contextWindow:
												editProvider()!.contextWindow,
										}
									: {}),
								...(editProvider()!.providerOptions
									? {
											providerOptions:
												editProvider()!
													.providerOptions,
										}
									: {}),
								...(editProvider()!.promptCacheKey
									? {
											promptCacheKey:
												editProvider()!.promptCacheKey,
										}
									: {}),
								...(editProvider()!.alwaysAllow?.length
									? {
											alwaysAllow:
												editProvider()!.alwaysAllow,
										}
									: {}),
							}
						: provider,
				);
				return;
			}
			default:
				return;
		}
	};

	useKeyboard(event => {
		const current = view();
		if (current.kind === 'pick') {
			if (event.name === 'escape') {
				props.onClose();
				return true;
			}
			if (
				event.name === 'up' ||
				event.name === 'down' ||
				event.name === 'left' ||
				event.name === 'right'
			) {
				moveGrid(event.name);
				return true;
			}
			if (event.name === 'return') {
				activatePicker();
				return true;
			}
			if (isDeleteKey(event)) {
				setQuery(prev => prev.slice(0, -1));
				setIndex(0);
				return true;
			}
			if (event.name === 'space' && !event.ctrl && !event.meta) {
				setQuery(prev => prev + ' ');
				setIndex(0);
				return true;
			}
			const char = event.name;
			if (char && char.length === 1 && !event.ctrl && !event.meta) {
				setQuery(prev => prev + char);
				setIndex(0);
			}
			// The picker owns EVERY key while open: nothing may leak into the
			// chat input or the history scrollbox behind it.
			return true;
		}
		if (current.kind === 'manage') {
			if (event.name === 'escape') {
				back();
				return true;
			}
			if (event.name === 'up' || event.name === 'down') {
				setManageIndex(prev => {
					const next = event.name === 'down' ? prev + 1 : prev - 1;
					return Math.max(0, Math.min(manageRows().length - 1, next));
				});
				return true;
			}
			if (event.name === 'return') {
				activateManage();
			}
			return true;
		}
		if (current.kind === 'methods') {
			if (event.name === 'escape') {
				back();
				return true;
			}
			if (event.name === 'up' || event.name === 'down') {
				const methods = selectedPreset().authMethods ?? [];
				setMethodIndex(prev => {
					const next = event.name === 'down' ? prev + 1 : prev - 1;
					return Math.max(0, Math.min(methods.length - 1, next));
				});
				return true;
			}
			if (event.name === 'return') {
				const methods = selectedPreset().authMethods ?? [];
				if (methods[methodIndex()]?.id === 'account') {
					push({kind: 'chatgpt'});
				} else {
					setInput('');
					push({kind: 'apikey'});
				}
				return true;
			}
			return true;
		}
		if (current.kind === 'chatgpt') {
			if (event.name === 'escape') {
				back();
				return true;
			}
			if (event.name === 'return') {
				connectChatgpt();
			}
			return true;
		}
		// Every remaining view is a single-field prompt.
		if (event.name === 'escape') {
			back();
			return true;
		}
		if (event.name === 'return') {
			if (current.kind === 'name') connectPreset();
			else if (current.kind === 'apikey') submitApiKey();
			else submitCustom();
			return true;
		}
		if (isDeleteKey(event)) {
			setInput(prev => prev.slice(0, -1));
			return true;
		}
		if (event.name === 'space' && !event.ctrl && !event.meta) {
			setInput(prev => prev + ' ');
			return true;
		}
		const char = event.name;
		if (char && char.length === 1 && !event.ctrl && !event.meta) {
			setInput(prev => prev + char);
		}
		return true;
	});

	// RESPONSIVE SHELL: the card auto-WIDENS on big screens (up to 120) so
	// the provider options can tile into more columns, and the HEIGHT
	// autofits to the current view — the picker fits its rows, prompt/method
	// steps stay compact, and short terminals cap at the window and scroll.
	const cardWidth = () => Math.min(120, Math.max(60, dims().width - 4));
	const columns = () => providerColumns(cardWidth());
	const cellWidth = () => Math.floor((cardWidth() - 4) / columns());
	const listVisible = () => Math.max(4, Math.min(60, dims().height - 9));
	/** Content height of the CURRENT step (fit-content every step): the picker
	 *  is its grid rows, manage/methods are their rows, prompts are compact.
	 *  The card is exactly that, capped by the window. */
	const viewContentLines = (): number => {
		switch (view().kind) {
			case 'pick':
				return Math.ceil(gridItems().length / columns()) * 2;
			case 'manage':
				return manageRows().length;
			case 'methods':
				return (selectedPreset().authMethods ?? []).length;
			case 'chatgpt':
				return 3;
			default:
				return 2;
		}
	};
	// The footer hint can wrap on narrow cards; reserve its REAL wrapped
	// height so it never renders below the card edge.
	const footerLines = (): number => {
		const hint =
			view().kind === 'pick'
				? '↑↓←→ navigate · Enter choose · Esc close'
				: 'Enter submit · Esc back';
		return Math.max(1, wrapText(hint, cardWidth() - 6).length);
	};
	const cardHeight = (): number =>
		Math.min(
			dims().height - 2,
			Math.max(10, viewContentLines() + 7 + footerLines()),
		);
	const cardY = () => Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();
	const pickerSelection = (row: PickerRow): boolean => {
		// Row OBJECTS are rebuilt per render, but the preset refs are stable
		// (from PROVIDER_PRESETS) — compare by preset, not object identity.
		return (
			Boolean(row.preset) &&
			row.preset === gridItems()[index()]?.preset
		);
	};
	// Grid scroll window: 2-line cells, the selected row stays in view.
	const visibleGridRows = (): Array<{
		row: number;
		cells: Array<PickerRow | null>;
	}> => {
		const items = gridItems();
		const cols = columns();
		const totalRows = Math.ceil(items.length / cols);
		if (totalRows === 0) return [];
		// The scroll window matches the CARD (fit-content), never a larger
		// listVisible budget that would clip rows below the card edge.
		const visibleRows = Math.max(
			1,
			Math.floor((cardHeight() - 7 - footerLines()) / 2),
		);
		const selectedRow = Math.min(
			Math.floor(index() / cols),
			totalRows - 1,
		);
		const startRow = Math.max(
			0,
			Math.min(
				selectedRow - visibleRows + 1,
				Math.max(0, totalRows - visibleRows),
			),
		);
		const out: Array<{row: number; cells: Array<PickerRow | null>}> = [];
		for (let r = startRow; r < Math.min(startRow + visibleRows, totalRows); r++) {
			const cells: Array<PickerRow | null> = [];
			for (let c = 0; c < cols; c++) {
				cells.push(items[r * cols + c] ?? null);
			}
			out.push({row: r, cells});
		}
		return out;
	};
	const truncateCell = (text: string, width: number): string =>
		text.length > width
			? text.slice(0, Math.max(1, width - 1)) + '…'
			: text;

	const title = (): string => {
		switch (view().kind) {
			case 'pick':
				return 'Connect a provider';
			case 'manage':
				return `${managePreset().title} connections`;
			case 'methods':
				return selectedPreset().title;
			case 'apikey':
				return `${selectedPreset().title} API key`;
			case 'chatgpt':
				return 'ChatGPT account';
			case 'name':
				return `${selectedPreset().title} name`;
			case 'custom-base':
				return 'Base URL';
			case 'custom-key':
				return 'API key (optional)';
			case 'custom-models':
				return 'Models (comma-separated, optional)';
			case 'custom-name':
				return 'Provider name';
		}
	};

	const promptDescription = (): string | undefined => {
		switch (view().kind) {
			case 'apikey':
				return selectedPreset().optionalKey
					? 'optional — empty uses free models'
					: 'sk-... or env:VAR';
			case 'name':
				return `optional — empty uses ${defaultProviderName(selectedPreset().id)}`;
			case 'custom-base':
				return editProvider()
					? editPlaceholder('custom-base', editProvider())
					: 'e.g. https://api.deepseek.com/v1';
			case 'custom-key':
				return editProvider()
					? editPlaceholder('custom-key', editProvider())
					: undefined;
			case 'custom-models':
				return editProvider()
					? editPlaceholder('custom-models', editProvider())
					: 'e.g. deepseek-v4-flash, deepseek-v4-pro';
			case 'custom-name':
				return editProvider()
					? editPlaceholder('custom-name', editProvider())
					: `optional — empty uses ${defaultProviderName('custom')}`;
			default:
				return undefined;
		}
	};

	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width={dims().width}
			height={dims().height}
			zIndex={3200}
			alignItems="center"
			paddingTop={cardY()}
			backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
			{...({
				onMouseUp: (event: {x?: number; y?: number}) => {
					if (isOpeningRelease()) return;
					if (
						typeof event.x === 'number' &&
						typeof event.y === 'number' &&
						!insideCard(event.x, event.y)
					) {
						props.onClose();
					}
				},
			} as any)}
		>
			<box
				width={cardWidth()}
				height={cardHeight()}
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						{title()}
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						{view().kind === 'pick'
							? 'Esc close'
							: 'Esc back'}
					</text>
				</box>
				<box height={1} />
				<Show
					when={view().kind === 'pick'}
					fallback={
						<Show
							when={
								view().kind === 'methods' ||
								view().kind === 'chatgpt' ||
								view().kind === 'manage'
							}
							fallback={
								<PromptField
									value={input()}
									error={error()}
									secret={view().kind === 'apikey' || view().kind === 'custom-key'}
									placeholder={promptDescription()}
								/>
							}
						>
							<Show
								when={view().kind === 'manage'}
								fallback={
									<Show
										when={view().kind === 'methods'}
										fallback={
											<ChatgptView
												authTick={authTick()}
												authSummary={codexAuthSummary(auth())}
												loggedIn={hasCodexChatgptAuth(auth())}
												onCheckAgain={() => setAuthTick(tick => tick + 1)}
											/>
										}
									>
										<MethodList
											methods={selectedPreset().authMethods ?? []}
											index={methodIndex()}
											onMove={setMethodIndex}
											onSelect={chosen => {
												if (chosen === 0) push({kind: 'chatgpt'});
												else {
													setInput('');
													push({kind: 'apikey'});
												}
											}}
										/>
									</Show>
								}
							>
								<ManageList
									presetTitle={managePreset().title}
									rows={manageRows()}
									index={manageIndex()}
									onMove={setManageIndex}
									onSelect={activateManage}
								/>
							</Show>
						</Show>
					}
				>
					<box height={1}>
						<text fg={colors().secondary} attributes={dim()}>
							⌕ {query() || 'search providers…'}
						</text>
					</box>
					<box height={1} />
					<Show
						when={gridItems().length > 0}
						fallback={
							<text fg={colors().secondary} attributes={dim()}>
								No providers match "{query()}"
							</text>
						}
					>
						{/* Responsive provider grid: 1 column on narrow cards,
						    2 on medium, 3 on wide (providerColumns). */}
						<For each={visibleGridRows()}>
							{(entry) => (
								<box flexDirection="row" height={2}>
									<For each={entry.cells}>
										{(cell, colIndex) => {
											if (!cell?.preset) {
												return (
													<box
														width={cellWidth()}
														height={2}
													/>
												);
											}
											const active = pickerSelection(cell);
											const gridPosition =
												entry.row * columns() + colIndex();
											return (
												<box
													width={cellWidth()}
													flexDirection="column"
													height={2}
													backgroundColor={
														active ? activeRow().bg : undefined
													}
													{...({
														onMouseMove: () => setIndex(gridPosition),
														onMouseUp: () => {
															if (cell.kind === 'custom') {
																push({kind: 'custom-base'});
															} else if (cell.preset) {
																setSelectedPreset(cell.preset);
																setPresetAuth('api');
																setInput('');
																if (cell.preset.authMethods?.length) {
																	push({kind: 'methods'});
																} else {
																	push({kind: 'apikey'});
																}
															}
														},
													} as any)}
												>
													<box flexDirection="row" height={1}>
														<text
															fg={
																active
																	? activeRow().fg
																	: colors().text
															}
															attributes={bold()}
														>
															{active ? '❯ ' : '  '}
															{truncateCell(
																cell.preset.title,
																Math.max(
																	6,
																	cellWidth() - 14,
																),
															)}
														</text>
														<box flexGrow={1} />
														<Show
															when={cell.count && cell.count > 0}
														>
															<text
																fg={colors().success}
																attributes={dim()}
															>
																{cell.count} connected
															</text>
														</Show>
													</box>
													<box height={1} paddingLeft={2}>
														<text
															fg={colors().secondary}
															attributes={dim()}
														>
															{truncateCell(
																cell.preset.description ??
																	'Custom provider',
																Math.max(8, cellWidth() - 4),
															)}
														</text>
													</box>
												</box>
											);
										}}
									</For>
								</box>
							)}
						</For>
					</Show>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						↑↓←→ navigate · Enter choose · Esc close
					</text>
				</Show>
			</box>
		</box>
	);
}

function PromptField(props: {
	value: string;
	error?: string;
	secret?: boolean;
	placeholder?: string;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	// Input-box caret parity: the cell under the cursor blinks (400ms) via
	// the shared spinnerFrame; the caret char is ALWAYS rendered (the last
	// char, or a space on an empty/placeholder line) so the line width never
	// shifts when it blinks.
	const cursorVisible = () => (spinnerFrame() >> 2) % 2 === 0;
	const shown = props.secret && props.value.length > 0
		? '•'.repeat(Math.min(24, props.value.length))
		: props.value;
	const filled = shown.length > 0;
	// Input-box caret parity: an EMPTY field shows the blinking box at the
	// START (before the dimmed placeholder); typing puts the caret at the
	// END over the last char. The caret cell is always rendered so the line
	// width never shifts while it blinks.
	const caretChar = filled
		? shown[shown.length - 1]!
		: ' ';
	const valueText = filled ? shown.slice(0, -1) : '';
	return (
		<box flexDirection="column">
			<box
				border
				borderStyle="rounded"
				borderColor={colors().secondary}
				paddingX={1}
				height={3}
			>
				{/* Placeholder INSIDE the field (dimmed) when empty — the hint
				    never rides below the input; the caret blinks like the
				    chat input box. */}
				<box flexDirection="row">
					{/* Caret FIRST when empty (the box sits before the
					    placeholder, like an empty chat input). */}
					<Show when={!filled}>
						<text
							bg={cursorVisible() ? activeRow().bg : undefined}
							fg={
								cursorVisible()
									? activeRow().fg
									: colors().secondary
							}
							attributes={dim()}
						>
							{caretChar}
						</text>
					</Show>
					<text
						fg={filled ? colors().text : colors().secondary}
						attributes={filled ? undefined : dim()}
					>
						{valueText}
						{!filled ? (props.placeholder ?? '') : ''}
					</text>
					<Show when={filled}>
						<text
							bg={cursorVisible() ? activeRow().bg : undefined}
							fg={
								cursorVisible()
									? activeRow().fg
									: colors().text
							}
						>
							{caretChar}
						</text>
					</Show>
				</box>
			</box>
			<Show when={props.error}>
				<box height={1} />
				<text fg={colors().warning} attributes={bold()}>
					{props.error}
				</text>
			</Show>
			<box flexGrow={1} />
			<text fg={colors().secondary} attributes={dim()}>
				Enter submit · Esc back
			</text>
		</box>
	);
}

function MethodList(props: {
	methods: Array<{id: 'account' | 'api'; label: string; detail: string}>;
	index: number;
	onMove: (next: number) => void;
	onSelect: (index: number) => void;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	return (
		<box flexDirection="column">
			<For each={props.methods}>
				{(method, i) => {
					const active = i() === props.index;
					return (
						<box
							flexDirection="row"
							height={1}
							backgroundColor={active ? activeRow().bg : undefined}
							{...({
								onMouseMove: () => props.onMove(i()),
								onMouseUp: () => props.onSelect(i()),
							} as any)}
						>
							<text
								fg={active ? activeRow().fg : colors().text}
								attributes={bold()}
							>
								{active ? '❯ ' : '  '}
								{method.label}
							</text>
							<box flexGrow={1} />
							<text fg={colors().secondary} attributes={dim()}>
								{method.detail}
							</text>
						</box>
					);
				}}
			</For>
			<box flexGrow={1} />
			<text fg={colors().secondary} attributes={dim()}>
				↑/↓ select · Enter choose · Esc back
			</text>
		</box>
	);
}

function ManageList(props: {
	presetTitle: string;
	rows: Array<{id: string; baseUrl: string} | null>;
	index: number;
	onMove: (next: number) => void;
	onSelect: (index: number) => void;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	return (
		<box flexDirection="column">
			<For each={props.rows}>
				{(row, i) => {
					const active = i() === props.index;
					return (
						<box
							flexDirection="row"
							height={1}
							backgroundColor={active ? activeRow().bg : undefined}
							{...({
								onMouseMove: () => props.onMove(i()),
								onMouseUp: () => props.onSelect(i()),
							} as any)}
						>
							<text
								fg={active ? activeRow().fg : colors().text}
								attributes={bold()}
							>
								{active ? '❯ ' : '  '}
								{row
									? row.id
									: `Connect a new ${props.presetTitle}`}
							</text>
							<box flexGrow={1} />
							<text fg={colors().secondary} attributes={dim()}>
								{row ? `${row.baseUrl} · edit` : ''}
							</text>
						</box>
					);
				}}
			</For>
			<box flexGrow={1} />
			<text fg={colors().secondary} attributes={dim()}>
				↑/↓ select · Enter choose · Esc back
			</text>
		</box>
	);
}

function ChatgptView(props: {
	authTick: number;
	authSummary: string | null;
	loggedIn: boolean;
	onCheckAgain: () => void;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	void props.authTick;
	return (
		<box flexDirection="column">
			<Show
				when={props.loggedIn}
				fallback={
					<box flexDirection="column">
						<text fg={colors().text}>
							Run `codex login` in another terminal, then check
							again. bobonyo uses the credentials it writes to
							~/.codex/auth.json.
						</text>
						<box flexGrow={1} />
						<text fg={colors().secondary} attributes={dim()}>
							Enter check again · Esc back
						</text>
					</box>
				}
			>
				<box flexDirection="column">
					<text fg={colors().success} attributes={bold()}>
						✓ {props.authSummary}
					</text>
					<box height={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Uses your ChatGPT account through the Codex backend.
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Enter connect · Esc back
					</text>
				</box>
			</Show>
		</box>
	);
}
