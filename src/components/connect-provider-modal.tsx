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
 * method selection → in-modal prompt steps (API key / ChatGPT account
 * waiting view / custom fields), each step owns every keypress. Esc steps
 * back; the modal only closes at the picker root.
 */

const CODEX_MODELS = [
	'gpt-5.5-codex',
	'gpt-5.5-codex-high',
	'gpt-5.4-codex',
	'gpt-5.4-codex-mini',
];

type View =
	| {kind: 'pick'}
	| {kind: 'methods'}
	| {kind: 'apikey'}
	| {kind: 'chatgpt'}
	| {kind: 'custom-id'}
	| {kind: 'custom-base'}
	| {kind: 'custom-key'}
	| {kind: 'custom-models'};

interface PickerRow {
	kind: 'provider' | 'custom' | 'header' | 'spacer' | 'empty';
	id?: string;
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
	// The nearest unmatched header is kept when one of its items matches
	// (opencode groups the picker; a search must keep the group label).
	let pendingHeader: PickerRow | null = null;
	for (const row of rows) {
		if (row.kind === 'header') {
			pendingHeader = row;
			continue;
		}
		if (row.kind === 'spacer') continue;
		if (row.kind === 'empty') continue;
		const label =
			row.kind === 'provider' ? 'Codex' : 'Custom provider';
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

/** The provider payload a connect action produces (pure, unit-tested). */
export function codexAccountProvider(): ProviderConfig {
	return {
		id: 'codex',
		name: 'Codex',
		baseUrl: 'https://chatgpt.com/backend-api/codex',
		sdkProvider: 'responses',
		codexAccount: true,
		contextWindow: 400_000,
		models: CODEX_MODELS,
	};
}

export function codexApiKeyProvider(apiKey: string): ProviderConfig | null {
	const key = apiKey.trim();
	if (!key) return null;
	return {
		id: 'codex',
		name: 'Codex',
		baseUrl: 'https://api.openai.com/v1',
		sdkProvider: 'responses',
		apiKey: key,
		modelDiscoveryUrl: 'https://api.openai.com/v1/models',
		contextWindow: 400_000,
		models: CODEX_MODELS,
	};
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
	provider?: 'codex' | 'custom';
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

	// The opencode connect flow: picker → method select → prompt steps.
	// `back` restores the previous view so Esc walks the stack.
	const [viewStack, setViewStack] = createSignal<View[]>(
		props.provider === 'custom'
			? [{kind: 'custom-id'}, {kind: 'pick'}]
			: props.provider === 'codex' || props.editId === 'codex'
				? [{kind: 'methods'}, {kind: 'pick'}]
				: [{kind: 'pick'}],
	);
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
		const codexConnected = listProviders().some(
			provider => provider.id.toLowerCase() === 'codex',
		);
		return filterConnectPicker(
			[
				{kind: 'header', label: 'Popular'},
				{kind: 'provider', id: 'codex', connected: codexConnected},
				{kind: 'header', label: 'Providers'},
				{kind: 'custom'},
			],
			query(),
		);
	};
	const movePicker = (delta: number): void => {
		const rows = pickerRows().filter(
			row => row.kind === 'provider' || row.kind === 'custom',
		);
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
		const rows = pickerRows().filter(
			row => row.kind === 'provider' || row.kind === 'custom',
		);
		const row = rows[index()];
		if (!row) return;
		if (row.kind === 'provider') {
			push({kind: 'methods'});
			setMethodIndex(0);
		} else {
			push({kind: 'custom-id'});
		}
	};

	const submitCodexApiKey = (): void => {
		const provider = codexApiKeyProvider(input());
		if (!provider) {
			setError('API key is required.');
			return;
		}
		props.onConnect(provider);
	};
	const connectChatgpt = (): void => {
		if (hasCodexChatgptAuth(auth())) {
			props.onConnect(codexAccountProvider());
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
			// The picker owns EVERY key while it is open: nothing may leak
			// into the chat input or the history scrollbox behind it.
			return true;
		}
		if (current.kind === 'methods') {
			if (event.name === 'escape') {
				back();
				return true;
			}
			if (event.name === 'up' || event.name === 'down') {
				setMethodIndex(prev =>
					event.name === 'down'
						? Math.min(1, prev + 1)
						: Math.max(0, prev - 1),
				);
				return true;
			}
			if (event.name === 'return') {
				if (methodIndex() === 0) {
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
			if (current.kind === 'apikey') submitCodexApiKey();
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
		const navigable = pickerRows().filter(
			r => r.kind === 'provider' || r.kind === 'custom',
		);
		return navigable[index()] === row;
	};

	const title = (): string => {
		switch (view().kind) {
			case 'pick':
				return 'Connect a provider';
			case 'methods':
				return 'Codex';
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
								view().kind === 'chatgpt'
							}
							fallback={
								<PromptField
									value={input()}
									error={error()}
									secret={view().kind === 'apikey' || view().kind === 'custom-key'}
									description={
										view().kind === 'apikey'
											? 'sk-... or env:VAR'
											: view().kind === 'custom-base'
												? 'e.g. https://api.deepseek.com/v1'
												: view().kind === 'custom-models'
													? 'e.g. deepseek-chat, deepseek-reasoner'
													: undefined
									}
								/>
							}
						>
							<Show
								when={view().kind === 'methods'}
								fallback={<ChatgptView authTick={authTick()} authSummary={codexAuthSummary(auth())} loggedIn={hasCodexChatgptAuth(auth())} onCheckAgain={() => setAuthTick(tick => tick + 1)} />}
							>
								<MethodList
									index={methodIndex()}
									authSummary={codexAuthSummary(auth())}
									onMove={setMethodIndex}
									onSelect={(chosen) => {
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
										onMouseUp: () => {
											if (row.kind === 'provider') {
												push({kind: 'methods'});
											} else {
												push({kind: 'custom-id'});
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
										{row.kind === 'provider' ? 'Codex' : 'Custom provider'}
									</text>
									<box flexGrow={1} />
									{row.kind === 'provider' ? (
										<text
											fg={
												row.connected
													? colors().success
													: colors().secondary
											}
											attributes={dim()}
										>
											{row.connected
												? '✓ connected'
												: 'ChatGPT account or API key'}
										</text>
									) : (
										<text fg={colors().secondary} attributes={dim()}>
											Custom provider
										</text>
									)}
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
	index: number;
	authSummary: string | null;
	onMove: (next: number) => void;
	onSelect: (index: number) => void;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const methods: Array<{title: string; detail: string}> = [
		{
			title: 'ChatGPT account (codex login)',
			detail:
				props.authSummary ??
				'Not logged in — run `codex login` to connect',
		},
		{title: 'API key', detail: 'sk-... or env:VAR'},
	];
	return (
		<box flexDirection="column">
			<For each={methods}>
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
								{method.title}
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
