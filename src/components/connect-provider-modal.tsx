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
 * method selection → in-modal prompt steps. Presets (Codex / DeepSeek /
 * Xiaomi MiMo) know their endpoints, so only the NAME + API key are asked;
 * custom providers ask everything. Naming is per-instance: the same
 * endpoint may be connected multiple times under different names (the user
 * organizes/splits models). Each step owns every keypress; Esc steps back.
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
	/** Default provider id/name; the user may rename each connection. */
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

/** The provider catalog the connect modal offers (order = picker order). */
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
	| {kind: 'name'}
	| {kind: 'methods'}
	| {kind: 'apikey'}
	| {kind: 'chatgpt'}
	| {kind: 'custom-id'}
	| {kind: 'custom-base'}
	| {kind: 'custom-key'}
	| {kind: 'custom-models'};

export interface PickerRow {
	kind: 'provider' | 'custom' | 'header' | 'empty';
	preset?: ProviderPreset;
	connected?: boolean;
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

/** Generic preset builder (API-key auth; Codex routes to the codex builder). */
export function buildPresetProvider(
	preset: ProviderPreset,
	name: string,
	apiKey: string,
): ProviderConfig | null {
	if (preset.id === 'codex') return codexApiKeyProvider(apiKey, name);
	if (!apiKey.trim()) return null;
	if (preset.id === 'deepseek') return deepseekProvider(name, apiKey);
	if (preset.id === 'xiaomi') return xiaomiProvider(name, apiKey);
	return null;
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

	// opencode flow: picker → name → (auth method →) prompt steps.
	const initialView = (): View[] => {
		if (props.provider && props.provider !== 'custom') {
			return [{kind: 'name'}, {kind: 'pick'}];
		}
		if (props.provider === 'custom' || props.editId) {
			return [{kind: 'custom-id'}, {kind: 'pick'}];
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
	const [presetName, setPresetName] = createSignal('');
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

	// Custom step values, kept across steps so Esc-back preserves what was
	// already entered.
	const [customId, setCustomId] = createSignal(editProvider?.id ?? '');
	const [customBase, setCustomBase] = createSignal(
		editProvider?.baseUrl ?? '',
	);
	const [customKey, setCustomKey] = createSignal('');
	const [customModels, setCustomModels] = createSignal(
		editProvider?.models.join(', ') ?? '',
	);

	const stepDefault = createMemo(() => {
		switch (view().kind) {
			case 'name':
				return presetName() || selectedPreset().id;
			case 'custom-id':
				return customId();
			case 'custom-base':
				return customBase();
			case 'custom-key':
				return customKey();
			case 'custom-models':
				return customModels();
			default:
				return '';
		}
	});
	// On view change the input starts from that step's stored value; typing
	// never rewrites it (the stored value only changes on submit).
	createEffect(() => {
		setInput(stepDefault());
		setError('');
	});

	const pickerRows = (): PickerRow[] => {
		const configured = listProviders();
		const connected = (id: string): boolean =>
			configured.some(provider => provider.id.toLowerCase() === id);
		const rows: PickerRow[] = [];
		let lastCategory: string | null = null;
		for (const preset of PROVIDER_PRESETS) {
			if (preset.category !== lastCategory) {
				rows.push({kind: 'header', label: preset.category});
				lastCategory = preset.category;
			}
			rows.push({
				kind: preset.id === 'custom' ? 'custom' : 'provider',
				preset,
				connected: connected(preset.id),
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
			push({kind: 'custom-id'});
			return;
		}
		setSelectedPreset(row.preset);
		setPresetName(row.preset.id);
		push({kind: 'name'});
	};

	const submitName = (): void => {
		const preset = selectedPreset();
		const name = input().trim() || preset.id;
		setPresetName(name);
		if (preset.authMethods?.length) {
			setMethodIndex(0);
			push({kind: 'methods'});
		} else {
			setInput('');
			push({kind: 'apikey'});
		}
	};
	const submitApiKey = (): void => {
		const preset = selectedPreset();
		const provider =
			preset.id === 'codex'
				? codexApiKeyProvider(input(), presetName())
				: buildPresetProvider(preset, presetName(), input());
		if (!provider) {
			setError('API key is required.');
			return;
		}
		props.onConnect(provider);
	};
	const connectChatgpt = (): void => {
		if (hasCodexChatgptAuth(auth())) {
			props.onConnect(codexAccountProvider(presetName()));
			return;
		}
		setAuthTick(tick => tick + 1);
	};
	const submitCustom = (): void => {
		switch (view().kind) {
			case 'custom-id': {
				const id = input().trim();
				if (!id) {
					setError('Provider id is required.');
					return;
				}
				setCustomId(id);
				push({kind: 'custom-base'});
				return;
			}
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
				const models = input()
					.split(',')
					.map(model => model.trim())
					.filter(Boolean);
				const provider = customProvider({
					id: customId(),
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
			if (current.kind === 'name') submitName();
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

	const cardWidth = () => Math.min(78, Math.max(60, dims().width - 6));
	const cardHeight = () => Math.min(18, Math.max(11, dims().height - 8));
	const cardY = () => Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();
	const pickerSelection = (row: PickerRow): boolean => {
		// Row OBJECTS are rebuilt per render (filterConnectPicker maps), but
		// the preset refs come from PROVIDER_PRESETS — compare by preset so
		// the highlight tracks the selection (identity compare was the bug).
		return (
			Boolean(row.preset) &&
			row.preset === navigableRows()[index()]?.preset
		);
	};

	const title = (): string => {
		switch (view().kind) {
			case 'pick':
				return 'Connect a provider';
			case 'name':
				return `${selectedPreset().title} name`;
			case 'methods':
				return selectedPreset().title;
			case 'apikey':
				return 'API key';
			case 'chatgpt':
				return 'ChatGPT account';
			case 'custom-id':
				return 'Provider id';
			case 'custom-base':
				return 'Base URL';
			case 'custom-key':
				return 'API key (optional)';
			case 'custom-models':
				return 'Models (comma-separated, optional)';
		}
	};

	const promptDescription = (): string | undefined => {
		switch (view().kind) {
			case 'name':
				return 'id used in /model and /provider — connect the same endpoint under multiple names';
			case 'apikey':
				return 'sk-... or env:VAR';
			case 'custom-base':
				return 'e.g. https://api.deepseek.com/v1';
			case 'custom-models':
				return 'e.g. deepseek-chat, deepseek-reasoner';
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
					<For each={pickerRows()}>
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
									<text fg={colors().primary} attributes={bold()}>
										{'  '}
										{row.label}
									</text>
								);
							}
							const active = pickerSelection(row);
							return (
								<box
									flexDirection="row"
									height={1}
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
												push({kind: 'custom-id'});
											} else if (row.preset) {
												setSelectedPreset(row.preset);
												setPresetName(row.preset.id);
												push({kind: 'name'});
											}
										},
									} as any)}
								>
									<text
										fg={
											active
												? activeRow().fg
												: colors().text
										}
										attributes={active ? bold() : undefined}
									>
										{active ? '❯ ' : '  '}
										{row.preset?.title ?? 'Custom provider'}
									</text>
									<box flexGrow={1} />
									<text fg={colors().secondary} attributes={dim()}>
										{row.connected ? '✓ connected' : row.preset?.description ?? 'Custom provider'}
									</text>
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
								attributes={active ? bold() : undefined}
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
