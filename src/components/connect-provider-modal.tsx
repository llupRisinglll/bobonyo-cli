/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {listProviders, type ProviderConfig} from '../config';
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

const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

const XIAOMI_MODELS = [
	'mimo-v2.5',
	'mimo-v2.5-pro',
	'mimo-v2.5-asr',
	'mimo-v2.5-tts',
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
		description: 'deepseek-chat / deepseek-reasoner',
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
		models: CODEX_MODELS,
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
	if (!apiKey.trim()) return null;
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

	const editProvider = props.editId
		? listProviders().find(
				provider => provider.id.toLowerCase() === props.editId!.toLowerCase(),
			)
		: undefined;

	const [customBase, setCustomBase] = createSignal(
		editProvider?.baseUrl ?? '',
	);
	const [customKey, setCustomKey] = createSignal('');
	const [customModels, setCustomModels] = createSignal(
		editProvider?.models.join(', ') ?? '',
	);

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

	// The provider OPTIONS stay a single settings-style column (multi-column
	// layouts are for model DETAILS, not the option list).
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
	const navigableRows = (): PickerRow[] =>
		pickerRows().filter(
			row => row.kind === 'provider' || row.kind === 'custom',
		);
	const movePicker = (delta: number): void => {
		const rows = navigableRows();
		if (rows.length === 0) return;
		const current = rows[index()];
		const currentIndex = current ? rows.indexOf(current) : -1;
		const next =
			currentIndex === -1
				? delta > 0
					? 0
					: rows.length - 1
				: currentIndex + delta;
		if (next < 0 || next >= rows.length) return;
		setIndex(next);
	};
	const activatePicker = (): void => {
		const row = navigableRows()[index()];
		if (!row?.preset) return;
		if (row.kind === 'custom') {
			push({kind: 'custom-base'});
			return;
		}
		setSelectedPreset(row.preset);
		setPresetAuth('api');
		setInput('');
		if (row.preset.authMethods?.length) push({kind: 'methods'});
		else push({kind: 'apikey'});
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
					(editProvider?.id || defaultProviderName('custom'));
				const provider = customProvider({
					id,
					baseUrl: customBase(),
					apiKey:
						customKey() ||
						(editProvider?.apiKeyResolved ? editProvider.apiKey : undefined),
					models: models.length > 0 ? models : (editProvider?.models ?? []),
				});
				if (provider) props.onConnect(provider);
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
			if (event.name === 'up' || event.name === 'down') {
				movePicker(event.name === 'down' ? 1 : -1);
				return true;
			}
			if (event.name === 'return') {
				activatePicker();
				return true;
			}
			if (event.name === 'backspace') {
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
		if (event.name === 'backspace') {
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

	// Settings-modal shell: the card uses as much of the screen as the
	// content needs — tall terminals grow the card up to the window height.
	const cardWidth = () => Math.min(78, Math.max(60, dims().width - 6));
	const listVisible = () => Math.max(4, Math.min(60, dims().height - 9));
	const cardHeight = () =>
		Math.min(dims().height - 2, Math.max(12, listVisible() + 8));
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
			row.preset === navigableRows()[index()]?.preset
		);
	};
	// Settings-list scrolling: rows are 2 lines (title + examples) so the
	// window walks line counts, not row indexes.
	const rowLines = (row: PickerRow): number =>
		row.kind === 'header' || row.kind === 'empty' ? 1 : 2;
	const fullRowIndex = (): number => {
		const all = pickerRows();
		const selected = navigableRows()[index()];
		if (!selected) return 0;
		return Math.max(
			0,
			all.findIndex(candidate => candidate.preset === selected.preset),
		);
	};
	const visiblePickerRows = (): PickerRow[] => {
		const all = pickerRows();
		const full = Math.min(fullRowIndex(), Math.max(0, all.length - 1));
		// Walk BACK from the selection so it ALWAYS fits in the window, then
		// extend forward; a forward-only window dropped the selected row
		// when the next row overflowed.
		let start = full;
		let lines = rowLines(all[full] ?? all[0]!);
		while (start > 0) {
			const rl = rowLines(all[start - 1]!);
			// Stop BEFORE the walk-back fills the whole window: the
			// selection must stay inside, with room left for rows after it.
			if (lines + rl >= listVisible()) break;
			start -= 1;
			lines += rl;
		}
		// Rows from start THROUGH the selection were counted in `lines`;
		// take them all, then extend forward with whatever budget is left.
		const out = all.slice(start, full + 1);
		let used = lines;
		for (let i = full + 1; i < all.length; i++) {
			const rl = rowLines(all[i]!);
			if (used + rl > listVisible()) break;
			out.push(all[i]!);
			used += rl;
		}
		return out;
	};

	const title = (): string => {
		switch (view().kind) {
			case 'pick':
				return 'Connect a provider';
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
				return 'sk-... or env:VAR';
			case 'name':
				return `optional — empty uses ${defaultProviderName(selectedPreset().id)}`;
			case 'custom-base':
				return 'e.g. https://api.deepseek.com/v1';
			case 'custom-models':
				return 'e.g. deepseek-chat, deepseek-reasoner';
			case 'custom-name':
				return `optional — empty uses ${editProvider?.id ?? defaultProviderName('custom')}`;
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
							when={view().kind === 'methods' || view().kind === 'chatgpt'}
							fallback={
								<PromptField
									value={input()}
									error={error()}
									secret={view().kind === 'apikey' || view().kind === 'custom-key'}
									description={promptDescription()}
								/>
							}
						>
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
						</Show>
					}
				>
					<box height={1}>
						<text fg={colors().secondary} attributes={dim()}>
							⌕ {query() || 'search providers…'}
						</text>
					</box>
					<box height={1} />
					<For each={visiblePickerRows()}>
						{(row) => {
							if (row.kind === 'empty') {
								return (
									<text fg={colors().secondary} attributes={dim()}>
										No providers match "{query()}"
									</text>
								);
							}
							if (row.kind === 'header') {
								return (
									// Headers reserve their OWN row (a bare text
									// doesn't, and the next provider row paints
									// over it — the "rs" left from Providers).
									<box height={1}>
										<text fg={colors().primary} attributes={bold()}>
											{'  '}
											{row.label}
										</text>
									</box>
								);
							}
							const active = pickerSelection(row);
							return (
								<box
									flexDirection="column"
									height={2}
									backgroundColor={
										active ? activeRow().bg : undefined
									}
									{...({
										onMouseMove: () => {
											const navigable = navigableRows();
											const rowIndex = navigable.findIndex(
												candidate => candidate.preset === row.preset,
											);
											if (rowIndex !== -1) setIndex(rowIndex);
										},
										onMouseUp: () => {
											if (row.kind === 'custom') {
												push({kind: 'custom-base'});
											} else if (row.preset) {
												setSelectedPreset(row.preset);
												setPresetAuth('api');
												setInput('');
												if (row.preset.authMethods?.length) {
													push({kind: 'methods'});
												} else {
													push({kind: 'apikey'});
												}
											}
										},
									} as any)}
								>
									{/* Settings-list layout: title + count on the
									    first line, the model examples BELOW it —
									    never same-line (OpenTUI clips the title
									    when the row overflows). */}
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
											{row.preset?.title ?? 'Custom provider'}
										</text>
										<box flexGrow={1} />
										<Show when={row.count && row.count > 0}>
											<text
												fg={colors().success}
												attributes={dim()}
											>
												{row.count} connected
											</text>
										</Show>
									</box>
									<box height={1} paddingLeft={2}>
										<text fg={colors().secondary} attributes={dim()}>
											{row.preset?.description ?? 'Custom provider'}
										</text>
									</box>
								</box>
							);
						}}
					</For>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						↑/↓ select · Enter choose · Esc close
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
	description?: string;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const shown = props.secret && props.value.length > 0
		? '•'.repeat(Math.min(24, props.value.length))
		: props.value;
	return (
		<box flexDirection="column">
			<box
				border
				borderStyle="rounded"
				borderColor={colors().secondary}
				paddingX={1}
				height={3}
			>
				<text fg={colors().text}>
					{shown.length > 0 ? shown : ''}▌
				</text>
			</box>
			<Show when={props.description}>
				<box height={1} />
				<text fg={colors().secondary} attributes={dim()}>
					{props.description}
				</text>
			</Show>
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
