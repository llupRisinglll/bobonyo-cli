/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {ModalHeader, modalWheel} from './modal-header';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {
	listProviders,
	type ProviderConfig,
	type ResolvedProvider,
} from '../config';
import {
	PromptField,
	MethodList,
	ManageList,
	ChatgptView,
} from './connect-provider-views';
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

import {
	PROVIDER_PRESETS,
	OPENCODE_ZEN_MODELS,
	OPENCODE_GO_MODELS,
	type ProviderPreset,
} from './provider-presets';
export {PROVIDER_PRESETS, type ProviderPreset} from './provider-presets';
import {
	filterConnectPicker,
	providerColumns,
	defaultProviderName,
	presetConnections,
	presetConnectionCount,
	codexAccountProvider,
	buildPresetProvider,
	customProvider,
	editPlaceholder,
	knownPresetFor,
	providerFetchesModels,
	type PickerRow,
} from './connect-provider-helpers';
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

export {
	filterConnectPicker,
	providerColumns,
	defaultProviderName,
	presetConnections,
	presetConnectionCount,
	codexAccountProvider,
	codexApiKeyProvider,
	deepseekProvider,
	xiaomiProvider,
	openAICompatibleProvider,
	buildPresetProvider,
	customProvider,
	maskSecret,
	editPlaceholder,
	knownPresetFor,
	providerFetchesModels,
} from './connect-provider-helpers';
export type {PickerRow} from './connect-provider-helpers';
export function ConnectProviderModal(props: {
	provider?: string;
	editId?: string;
	onConnect: (provider: ProviderConfig) => void;
	/** Delete an existing connection from the manage step (d → y). */
	onDelete?: (id: string) => void;
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
			// Stack = [pick (back target), current]: the /codex and /custom
			// commands open DIRECTLY at their step; Esc goes back to the
			// picker. The old order [current, pick] opened at the picker and
			// hid the form behind Esc.
			return [{kind: 'pick'}, {kind: 'apikey'}];
		}
		if (props.provider === 'custom' || props.editId) {
			const edit = props.editId
				? listProviders().find(
						provider =>
							provider.id.toLowerCase() === props.editId!.toLowerCase(),
					)
				: undefined;
			// A known preset endpoint is NOT re-asked in the edit flow
			// (custom providers still go through the base step).
			return [
				{kind: 'pick'},
				{
					kind: edit && knownPresetFor(edit) ? 'custom-key' : 'custom-base',
				},
			];
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
	// Paste lands in the CURRENT step's field: the picker search while
	// choosing a provider, the wizard input otherwise (API keys, base URLs,
	// model lists, names). The chat box is gated while this modal is open.
	usePaste((event: {bytes: Uint8Array}) => {
		const text = new TextDecoder().decode(event.bytes);
		if (view().kind === 'pick') setQuery(prev => prev + text);
		else setInput(prev => prev + text);
	});
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
	/** Connection id pending a delete confirmation (manage step `d`). */
	const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(
		null,
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
						provider.id.toLowerCase() === editTargetId()!.toLowerCase(),
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
		// Zen and Go share one API-key connection. Show ONE OpenCode
		// option here; tier/endpoint is chosen later in `/model`.
		const pickerPresets = PROVIDER_PRESETS.filter(
			preset => preset.id !== 'opencode-go',
		).map(preset =>
			preset.id === 'opencode-zen'
				? {...preset, title: 'OpenCode', description: 'Zen + Go · one API key'}
				: preset,
		);
		for (const preset of pickerPresets) {
			if (preset.category !== lastCategory) {
				rows.push({kind: 'header', label: preset.category});
				lastCategory = preset.category;
			}
			rows.push({
				kind:
					preset.id === 'custom' ? ('custom' as const) : ('provider' as const),
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
		// Edit the existing connection through the custom flow, skipping the
		// base-URL step when the endpoint is a KNOWN preset (only Custom /
		// modified endpoints are asked again).
		setEditTargetId(selected.id);
		const provider = editProvider();
		push({
			kind: provider && knownPresetFor(provider) ? 'custom-key' : 'custom-base',
		});
	};

	const submitApiKey = (): void => {
		setPresetKey(input().trim());
		// OpenCode Zen/Go share one key, but each named connection still
		// needs a user-provided name so multiple keys remain distinguishable.
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
				const edit = editProvider();
				// Fetch-capable providers skip the models step — discovery
				// refreshes the catalog, a static list is pointless.
				push({
					kind:
						edit && providerFetchesModels(edit)
							? 'custom-name'
							: 'custom-models',
				});
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
					input().trim() || editProvider()?.id || defaultProviderName('custom');
				const provider = customProvider({
					id,
					// A skipped base step (known preset) keeps the existing
					// endpoint instead of failing on the empty staged value.
					baseUrl: customBase() || editProvider()?.baseUrl || '',
					apiKey:
						customKey() ||
						(editProvider()?.apiKeyResolved
							? editProvider()!.apiKey
							: undefined),
					models: models.length > 0 ? models : (editProvider()?.models ?? []),
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
											codexAccount: editProvider()!.codexAccount,
										}
									: {}),
								...(editProvider()!.modelDiscoveryUrl
									? {
											modelDiscoveryUrl: editProvider()!.modelDiscoveryUrl,
										}
									: {}),
								...(editProvider()!.contextWindow
									? {
											contextWindow: editProvider()!.contextWindow,
										}
									: {}),
								...(editProvider()!.providerOptions
									? {
											providerOptions: editProvider()!.providerOptions,
										}
									: {}),
								...(editProvider()!.promptCacheKey
									? {
											promptCacheKey: editProvider()!.promptCacheKey,
										}
									: {}),
								...(editProvider()!.alwaysAllow?.length
									? {
											alwaysAllow: editProvider()!.alwaysAllow,
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

	const handleKey: Parameters<typeof useKeyboard>[0] = event => {
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
			// Delete confirmation owns every key: (y) deletes the selected
			// connection, (n)/Esc cancels back to the manage list.
			if (confirmingDelete()) {
				if (event.name === 'y' || event.name === 'Y') {
					const id = confirmingDelete()!;
					setConfirmingDelete(null);
					props.onDelete?.(id);
					// Close after a successful delete: the manage list sits
					// inside a frozen Show child (it cannot refresh in
					// place), and closing is the standard delete UX anyway.
					props.onClose();
				} else if (
					event.name === 'n' ||
					event.name === 'N' ||
					event.name === 'escape'
				) {
					setConfirmingDelete(null);
				}
				return true;
			}
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
			// `d` deletes the selected EXISTING connection (the "Connect a
			// new" row is not deletable).
			if (event.name === 'd' && !event.ctrl && !event.meta) {
				const selected = manageRows()[manageIndex()];
				if (selected) setConfirmingDelete(selected.id);
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
	};
	useKeyboard(handleKey);

	// RESPONSIVE SHELL: the card auto-WIDENS on big screens (up to 120) so
	// the provider options can tile into more columns, and the HEIGHT
	// autofits to the current view — the picker fits its rows, prompt/method
	// steps stay compact, and short terminals cap at the window and scroll.
	const cardWidth = () => Math.min(120, Math.max(1, dims().width - 2));
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
		return Math.max(1, wrapText(hint, Math.max(1, cardWidth() - 6)).length);
	};
	const cardHeight = (): number =>
		Math.min(
			Math.max(1, dims().height - (dims().height >= 9 ? 2 : 0)),
			Math.max(10, viewContentLines() + 9 + footerLines()),
		);
	const cardY = () =>
		Math.max(0, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();
	const pickerSelection = (row: PickerRow): boolean => {
		// Row OBJECTS are rebuilt per render, but the preset refs are stable
		// (from PROVIDER_PRESETS) — compare by preset, not object identity.
		return Boolean(row.preset) && row.preset === gridItems()[index()]?.preset;
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
			Math.floor((cardHeight() - 9 - footerLines()) / 2),
		);
		const selectedRow = Math.min(Math.floor(index() / cols), totalRows - 1);
		const startRow = Math.max(
			0,
			Math.min(
				selectedRow - visibleRows + 1,
				Math.max(0, totalRows - visibleRows),
			),
		);
		const out: Array<{row: number; cells: Array<PickerRow | null>}> = [];
		for (
			let r = startRow;
			r < Math.min(startRow + visibleRows, totalRows);
			r++
		) {
			const cells: Array<PickerRow | null> = [];
			for (let c = 0; c < cols; c++) {
				cells.push(items[r * cols + c] ?? null);
			}
			out.push({row: r, cells});
		}
		return out;
	};
	const truncateCell = (text: string, width: number): string =>
		text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text;

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
			onMouseScroll={modalWheel(handleKey)}
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
				flexDirection="column"
				overflow="hidden"
			>
				<ModalHeader
					width={cardWidth()}
					title={title()}
					hint={view().kind === 'pick' ? 'Esc close' : 'Esc back'}
					caps={dims().height >= 9}
				/>
				<box
					flexDirection="column"
					flexGrow={1}
					minHeight={0}
					overflow="hidden"
					paddingX={Math.min(1, Math.floor(cardWidth() / 3))}
					paddingY={dims().height >= 9 ? 1 : 0}
				>
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
										value={input}
										error={error}
										secret={
											view().kind === 'apikey' || view().kind === 'custom-key'
										}
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
												index={methodIndex}
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
									<Show
										when={confirmingDelete() === null}
										fallback={
											<box flexDirection="column">
												<text fg={colors().warning} attributes={bold()}>
													Delete provider
												</text>
												<box height={1} />
												<text fg={colors().text}>
													Delete "{confirmingDelete()}"? This cannot be undone.
												</text>
												<box height={1} />
												<text fg={colors().secondary} attributes={dim()}>
													(y) delete · (n) cancel
												</text>
											</box>
										}
									>
										<ManageList
											presetTitle={managePreset().title}
											rows={manageRows()}
											index={manageIndex}
											onMove={setManageIndex}
											onSelect={activateManage}
										/>
									</Show>
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
								{entry => (
									<box flexDirection="row" height={2}>
										<For each={entry.cells}>
											{(cell, colIndex) => {
												if (!cell?.preset) {
													return <box width={cellWidth()} height={2} />;
												}
												const active = pickerSelection(cell);
												const gridPosition = entry.row * columns() + colIndex();
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
																fg={active ? activeRow().fg : colors().text}
																attributes={bold()}
															>
																{active ? '❯ ' : '  '}
																{truncateCell(
																	cell.preset.title,
																	Math.max(6, cellWidth() - 14),
																)}
															</text>
															<box flexGrow={1} />
															<Show when={cell.count && cell.count > 0}>
																<text fg={colors().success} attributes={dim()}>
																	{cell.count} connected
																</text>
															</Show>
														</box>
														<box height={1} paddingLeft={2}>
															<text fg={colors().secondary} attributes={dim()}>
																{truncateCell(
																	cell.preset.description ?? 'Custom provider',
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
		</box>
	);
}
