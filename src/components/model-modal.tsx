/** @jsxImportSource @opentui/solid */
import {createEffect, createSignal, For, on, Show} from 'solid-js';
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {loadPreferences} from '../config';
import {wrapText} from '../text-wrap';
import {
	EFFORT_LEVELS,
	effortLevelsForModel,
	modelWithProvider,
	providerDisplayName,
	providerHeaderParts,
	openCodeTierLabel,
	connectionPickerRow,
	openCodeTierOf,
	distinctOpenCodeTiers,
	providerGroupKey,
	groupProviders,
	sameProviderGroup,
	initialModelRowIndex,
	connectProviderShortcut,
	nextModelCursor,
} from './model-modal-helpers';
import type {ModelProvider, ProviderGroup} from './model-modal-helpers';
export * from './model-modal-helpers';

type Row =
	| {
			kind: 'provider';
			provider: ModelProvider;
			expanded: boolean;
			isCurrent: boolean;
	  }
	| {kind: 'model'; provider: ModelProvider; model: string; isCurrent: boolean}
	| {kind: 'inherit'}
	| {kind: 'spacer'}
	| {kind: 'empty'};

interface ModelCell {
	/** All connections under the cell's provider group (account picker). */
	connections: ModelProvider[];
	model: string;
	isCurrent: boolean;
	/** Effort folded INTO the cell: the OpenTUI reconciler's <For> only
	 *  re-renders when the `each` array changes, so signals read inside the
	 *  child (effort overrides) never trigger a repaint on their own. */
	shownEffort?: string;
	/** Context-window label (e.g. "400K", "1.0M") for the size column. */
	contextSize?: string;
	/** Global index in the flattened model-cell list. */
	index: number;
}

function formatContextLength(contextLength: number): string {
	if (contextLength >= 1_000_000) {
		return `${(contextLength / 1_000_000).toFixed(1)}M`;
	}
	if (contextLength >= 1000) {
		return `${Math.round(contextLength / 1000)}K`;
	}
	return `${contextLength}`;
}

interface DisplayLine {
	kind: 'inherit' | 'provider' | 'grid' | 'spacer' | 'empty';
	provider?: ModelProvider;
	/** All connections under the provider group (header name list). */
	connections?: ModelProvider[];
	isCurrent?: boolean;
	/** One grid ROW of cells (padding cells are null). */
	cells?: Array<ModelCell | null>;
}

/**
 * `/model` MODAL (parity: nanocoder's grouped ModelSelector). Providers stay
 * as grouped headers, but the model DETAILS flow into a RESPONSIVE GRID:
 * 3 columns on wide terminals, 2 on small ones (and 1 when truly narrow),
 * while the card grows with the screen (settings-modal parity) so a fetched
 * catalog of hundreds of models never forces a tiny scrollbox. ↑↓←→ move
 * through the grid, `E` cycles the reasoning effort (←/→ now owns column
 * navigation), Tab toggles search/list focus, `C` connects a provider from
 * the list, Enter selects, Esc closes.
 */
export function ModelModal(props: {
	providers: ModelProvider[];
	currentProvider: string;
	currentModel: string;
	onSelect: (providerId: string, model: string, effort?: string) => void;
	onConnectProvider: () => void;
	onClose: () => void;
	/** Optional heading for embedded selectors such as per-agent models. */
	title?: string;
	/** When set, a leading "Inherit" row restores the main agent model. */
	inheritLabel?: string;
	onInherit?: () => void;
	/** Non-empty conversation ⇒ warn that switching resends all messages. */
	hasMessages: boolean;
	/** Suppress replayed Enter when embedded inside another keyboard modal. */
	nestedReturnGuardMs?: number;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const [query, setQuery] = createSignal('');
	// Paste lands in the search (the chat box is gated while this modal is
	// open — a paste must never leak into the input behind it).
	usePaste((event: {bytes: Uint8Array}) => {
		setQuery(prev => prev + new TextDecoder().decode(event.bytes));
	});
	// Search vs list focus: single-letter shortcuts (C) are list-only so
	// typing a query can never trip them (parity: the settings modal's Tab
	// search/list toggle).
	const [focus, setFocus] = createSignal<'search' | 'list'>('search');
	// AUTO-CLOSE GUARD: modals opened by a row click receive the SAME
	// click's mouse-UP on the backdrop, which would close them instantly.
	// Only that opening release is ignored — a time window, NOT a one-shot
	// boolean (the flag got consumed by the opening release and swallowed
	// the user's first real outside click: click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;
	const suppressInitialReturn = () =>
		Boolean(props.nestedReturnGuardMs) &&
		Date.now() - mountedAt < (props.nestedReturnGuardMs ?? 0);

	const matches = (text: string): boolean => {
		const q = query().trim().toLowerCase();
		return !q || text.toLowerCase().includes(q);
	};

	// Per-model effort OVERRIDE selected with E (keyed provider\0model).
	const [effortOverrides, setEffortOverrides] = createSignal<
		Record<string, string>
	>(loadPreferences().modelEfforts ?? {});
	const effortKey = (provider: string, model: string): string =>
		`${provider}\u0000${model}`;
	const effectiveEffort = (
		provider: ModelProvider,
		model: string,
	): string | undefined =>
		effortOverrides()[effortKey(provider.id, model)] ??
		provider.modelEfforts[model];

	// RESPONSIVE SHELL (settings-modal parity): the card grows with the
	// screen height; the width grows so model details can use 3 columns on
	// big terminals, 2 on small ones.
	const cardWidth = () => Math.min(120, Math.max(60, dims().width - 4));
	const listVisible = () => Math.max(3, Math.min(60, dims().height - 9));
	// FIT-CONTENT: the card is exactly the model-list height + chrome, capped
	// by the window — a short catalog shrinks the card, a huge one fills the
	// screen and scrolls (never a fixed tall box). The footer hint can WRAP
	// on narrow cards, so its real wrapped height is reserved (a 1-line
	// estimate left the wrapped hint rendering below the card edge).
	const footerHint =
		'Tab search/list · ↑↓←→ move · E effort · Enter choose · C connect (list) · Esc close';
	const footerLines = (): number =>
		Math.max(1, wrapText(footerHint, cardWidth() - 6).length);
	const cardHeight = (): number => {
		const capped = Math.min(displayLines().length, listVisible());
		return Math.min(
			dims().height - 2,
			Math.max(10, capped + 10 + footerLines()),
		);
	};
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const modelColumns = () =>
		cardWidth() >= 100 ? 3 : cardWidth() >= 58 ? 2 : 1;
	const cellWidth = () => Math.floor((cardWidth() - 4) / modelColumns());

	/** Filtered provider groups in display order (current provider first):
	 *  ONE group per REAL provider, all user connections merged inside. */
	const groups = (): Array<{
		group: ProviderGroup;
		isCurrent: boolean;
		models: string[];
	}> => {
		const sorted = groupProviders(props.providers).sort((a, b) => {
			const aCurrent = a.connections.some(
				connection => connection.id === props.currentProvider,
			)
				? 0
				: 1;
			const bCurrent = b.connections.some(
				connection => connection.id === props.currentProvider,
			)
				? 0
				: 1;
			return aCurrent !== bCurrent
				? aCurrent - bCurrent
				: a.title.localeCompare(b.title);
		});
		const out: Array<{
			group: ProviderGroup;
			isCurrent: boolean;
			models: string[];
		}> = [];
		for (const group of sorted) {
			const isCurrent = group.connections.some(
				connection => connection.id === props.currentProvider,
			);
			const nameMatches =
				matches(group.title) ||
				group.connections.some(connection =>
					matches(connection.name ?? connection.id),
				);
			const visibleModels = group.models.filter(
				model => nameMatches || matches(model),
			);
			if (query().trim() && !nameMatches && visibleModels.length === 0) {
				continue;
			}
			out.push({group, isCurrent, models: visibleModels});
		}
		return out;
	};

	/** Display lines: inherit → spacers → provider headers → model GRID rows. */
	const displayLines = (): DisplayLine[] => {
		const lines: DisplayLine[] = [];
		if (props.inheritLabel) {
			lines.push({kind: 'inherit'});
			lines.push({kind: 'spacer'});
		}
		const cols = modelColumns();
		let cellIndex = 0;
		for (const group of groups()) {
			// Blank line BETWEEN provider groups (before every header except
			// the first), parity with the resume picker's grouping.
			if (lines.length > 0) lines.push({kind: 'spacer'});
			lines.push({
				kind: 'provider',
				provider: group.group.connections[0],
				connections: group.group.connections,
				isCurrent: group.isCurrent,
			});
			const gridRows = Math.ceil(group.models.length / cols);
			for (let r = 0; r < gridRows; r++) {
				const cells: Array<ModelCell | null> = [];
				for (let c = 0; c < cols; c++) {
					const i = r * cols + c;
					if (i < group.models.length) {
						cells.push({
							connections: group.group.connections,
							model: group.models[i]!,
							isCurrent:
								group.isCurrent && group.models[i] === props.currentModel,
							shownEffort: effectiveEffort(
								group.group.connections[0]!,
								group.models[i]!,
							),
							contextSize: (() => {
								const window =
									group.group.connections[0]!.modelContextWindows?.[
										group.models[i]!
									] ?? group.group.connections[0]!.contextWindow;
								return window ? formatContextLength(window) : undefined;
							})(),
							index: cellIndex,
						});
						cellIndex += 1;
					} else {
						cells.push(null);
					}
				}
				lines.push({kind: 'grid', cells});
			}
		}
		if (lines.length === 0) lines.push({kind: 'empty'});
		return lines;
	};

	const modelCells = (): ModelCell[] => {
		const cells: ModelCell[] = [];
		for (const line of displayLines()) {
			for (const cell of line.cells ?? []) {
				if (cell) cells.push(cell);
			}
		}
		return cells;
	};

	// Cursor over flattened model cells; -1 = the Inherit row.
	const initialCursor = (): number => {
		const cells = modelCells();
		const current = cells.findIndex(cell => cell.isCurrent);
		if (current !== -1) return current;
		if (props.inheritLabel) return -1;
		return cells.length > 0 ? 0 : -1;
	};
	const [cursor, setCursor] = createSignal<number>(initialCursor());
	const [scrollStart, setScrollStart] = createSignal(0);

	const [confirming, setConfirming] = createSignal<{
		providerId: string;
		model: string;
		effort?: string;
	} | null>(null);
	// opencode-style EFFORT STEP: picking a model asks which effort to use
	// (Default or minimal/low/medium/high) before the switch happens.
	const [effortStep, setEffortStep] = createSignal<{
		providerId: string;
		model: string;
		/** Chosen via the account picker on a DIFFERENT connection. */
		accountSwitch?: boolean;
		/**
		 * OPENCODE (Zen + Go share one key): the model-selection flow is
		 * model → effort → TIER (Zen/Go) → named connection. Present when
		 * the effort step was entered from an opencode group with multiple
		 * connections; the tier step narrows them by endpoint.
		 */
		opencodeConnections?: ModelProvider[];
	} | null>(null);
	/** OPENCODE TIER step: choose Zen or Go BEFORE the named connection. */
	const [tierStep, setTierStep] = createSignal<{
		model: string;
		/** Effort chosen at the effort step (rides through to the select). */
		effort?: string;
		connections: ModelProvider[];
	} | null>(null);
	const [tierIndex, setTierIndex] = createSignal(0);
	/** Account picker: the model is chosen, pick WHICH connection to use. */
	const [connectionStep, setConnectionStep] = createSignal<{
		model: string;
		connections: ModelProvider[];
		/** Effort already chosen (opencode tier flow) — commit directly. */
		effort?: string;
		/** True when reached via the opencode tier step. */
		fromTier?: boolean;
	} | null>(null);
	const [connectionIndex, setConnectionIndex] = createSignal(0);
	const [effortIndex, setEffortIndex] = createSignal(0);
	const effortOptions = (model: string): Array<{id: string; label: string}> => [
		{id: 'default', label: 'Default'},
		...effortLevelsForModel(model).map(level => ({id: level, label: level})),
	];
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());

	const currentCell = (): ModelCell | undefined => {
		const cells = modelCells();
		return cursor() >= 0 ? cells[cursor()] : undefined;
	};
	let suppressEffortReturn = false;
	// Grid navigation (row-major per provider group). Moving past a group's
	// last row jumps to the NEXT group's first cell so long catalogs stay
	// reachable with ↓ alone; ↑ from a group's first ROW exits to the
	// previous group's last cell (or the Inherit row) — never trapped inside
	// one provider. LEFT/RIGHT wrap across group boundaries symmetrically
	// (pure, unit-tested).
	const moveCell = (direction: 'up' | 'down' | 'left' | 'right'): void => {
		const list = groups();
		setCursor(
			nextModelCursor(
				cursor(),
				direction,
				list.map(group => group.models.length),
				modelColumns(),
				Boolean(props.inheritLabel),
			),
		);
	};

	/** Jump to the effort step for a specific connection + model. */
	const startEffort = (
		provider: ModelProvider,
		model: string,
		accountSwitch?: boolean,
		opencodeConnections?: ModelProvider[],
	): void => {
		const guardMs = props.nestedReturnGuardMs ?? 0;
		suppressEffortReturn = guardMs > 0;
		if (guardMs > 0) {
			setTimeout(() => {
				suppressEffortReturn = false;
			}, guardMs);
		}
		setEffortStep({
			providerId: provider.id,
			model,
			accountSwitch,
			opencodeConnections,
		});
		const currentEffort = effectiveEffort(provider, model);
		setEffortIndex(
			currentEffort
				? Math.max(
						0,
						effortOptions(model).findIndex(
							option => option.id === currentEffort,
						),
					)
				: 0,
		);
	};

	/** OpenCode tier options for the tier step (with a label per tier). */
	/** OpenCode tier options for the tier step (label + ENDPOINT per tier). */
	const tierOptions = (): Array<{
		tier: 'zen' | 'go';
		label: string;
		detail: string;
	}> => {
		const step = tierStep();
		if (!step) return [];
		const out: Array<{tier: 'zen' | 'go'; label: string; detail: string}> = [];
		for (const tier of distinctOpenCodeTiers(step.connections)) {
			const rep = step.connections.find(c => openCodeTierOf(c) === tier);
			out.push({
				tier,
				label: rep
					? openCodeTierLabel(rep)
					: tier === 'zen'
						? 'Zen (API usage)'
						: 'Go (Subscription)',
				// The endpoint tells the user WHICH URL the tier will use
				// (the two share the key, only the endpoint differs).
				detail: rep?.baseUrl ?? '',
			});
		}
		return out;
	};

	/** After the tier step: the tier's connections, then the named picker. */
	const chooseTier = (index: number): void => {
		const step = tierStep();
		if (!step) return;
		const option = tierOptions()[index];
		if (!option) return;
		setTierStep(null);
		const connections = step.connections.filter(
			connection => openCodeTierOf(connection) === option.tier,
		);
		setConnectionStep({
			model: step.model,
			effort: step.effort,
			connections,
			fromTier: true,
		});
		setConnectionIndex(0);
	};

	/**
	 * FINAL select for the OPENCODE tier/connection flow: the key is SHARED
	 * across Zen/Go, so switching to a DIFFERENT connection of the same
	 * group is an account swap (context + cache head stay, no resend
	 * confirm) — but only when the MODEL is unchanged; a model switch still
	 * confirms the resend.
	 */
	const commitOpenCode = (
		chosen: ModelProvider,
		model: string,
		effort?: string,
	): void => {
		const current = providerForId(props.currentProvider);
		const accountSwap =
			sameProviderGroup(chosen, current) &&
			current?.id !== chosen.id &&
			model === props.currentModel;
		const target = {providerId: chosen.id, model, effort};
		if (props.hasMessages && !accountSwap) setConfirming(target);
		else props.onSelect(chosen.id, model, effort);
	};

	const selectCell = (cell: ModelCell): void => {
		const connections = cell.connections;
		// OPENCODE (Zen + Go share ONE opencode.ai key, only the endpoint
		// differs): model → effort → TIER (Zen/Go) → named connection.
		// The tier + account are asked AFTER the effort, so the chosen
		// effort rides through to the final select.
		if (
			connections.length > 1 &&
			distinctOpenCodeTiers(connections).length > 0
		) {
			startEffort(connections[0]!, cell.model, false, connections);
			return;
		}
		// Other groups with MULTIPLE accounts ask which connection to use
		// for the selected model BEFORE the effort step.
		if (connections.length > 1) {
			setConnectionStep({model: cell.model, connections});
			setConnectionIndex(0);
			return;
		}
		startEffort(connections[0]!, cell.model);
	};

	// The display LINE holding the cursor (for the scroll window).
	const activeLine = (): number => {
		const lines = displayLines();
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (line.kind === 'inherit' && cursor() === -1) return i;
			if (line.kind === 'grid') {
				for (const cell of line.cells ?? []) {
					if (cell && cell.index === cursor()) return i;
				}
			}
		}
		return 0;
	};
	const visibleLines = (): DisplayLine[] => {
		const lines = displayLines();
		// The scroll window matches the CARD (fit-content), so rows never
		// render below the card edge.
		const visible = Math.max(1, cardHeight() - 10 - footerLines());
		const start = Math.max(
			0,
			Math.min(activeLine() - visible + 1, Math.max(0, lines.length - visible)),
		);
		setScrollStart(start);
		return lines.slice(start, start + visible);
	};

	const truncateCell = (text: string, width: number): string =>
		text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text;
	/** Provider display label for a bare model name (effort/confirm steps). */
	const providerForId = (id?: string): ModelProvider | undefined =>
		props.providers.find(provider => provider.id === id);

	// After a QUERY change the selection re-snaps to a REAL cell: the current
	// model when it still matches, otherwise the first cell (or Inherit).
	// Track ONLY the query: the cell list folds the effort override, and an
	// unfenced effect would re-run on every `E` press and snap the cursor
	// back to the current model.
	createEffect(
		on(query, () => {
			const cells = modelCells();
			const current = cells.findIndex(cell => cell.isCurrent);
			setCursor(
				current !== -1
					? current
					: props.inheritLabel
						? -1
						: cells.length > 0
							? 0
							: -1,
			);
		}),
	);

	useKeyboard(event => {
		if (event.name === 'escape') {
			if (connectionStep()) setConnectionStep(null);
			else if (tierStep()) setTierStep(null);
			else if (effortStep()) setEffortStep(null);
			else if (confirming()) setConfirming(null);
			else props.onClose();
			return true;
		}
		if (tierStep()) {
			const tiers = tierOptions();
			if (event.name === 'up' || event.name === 'down') {
				setTierIndex(prev => {
					const next = event.name === 'down' ? prev + 1 : prev - 1;
					return Math.max(0, Math.min(tiers.length - 1, next));
				});
				return true;
			}
			if (event.name === 'return') {
				chooseTier(tierIndex());
			}
			return true;
		}
		if (connectionStep()) {
			const connections = connectionStep()!.connections;
			if (event.name === 'up' || event.name === 'down') {
				setConnectionIndex(prev => {
					const next = event.name === 'down' ? prev + 1 : prev - 1;
					return Math.max(0, Math.min(connections.length - 1, next));
				});
				return true;
			}
			if (event.name === 'return') {
				const step = connectionStep()!;
				const chosen = connections[connectionIndex()]!;
				setConnectionStep(null);
				// OPENCODE tier flow: the effort was ALREADY chosen at the
				// effort step — commit directly (account-swap rules apply).
				if (step.fromTier) {
					commitOpenCode(chosen, step.model, step.effort);
					return true;
				}
				// Same provider, DIFFERENT account (and the SAME model) = an
				// account swap: the conversation context and cache head stay
				// untouched (the next turn sends normally), so no "will
				// RESEND" confirm. A model change still confirms.
				const current = providerForId(props.currentProvider);
				const sameGroup = sameProviderGroup(chosen, current);
				const sameConnection = current?.id === chosen.id;
				startEffort(
					chosen,
					step.model,
					sameGroup && !sameConnection && step.model === props.currentModel,
				);
			}
			return true;
		}
		if (effortStep()) {
			const options = effortOptions(effortStep()?.model ?? '');
			if (event.name === 'up' || event.name === 'down') {
				setEffortIndex(prev => {
					const next = event.name === 'down' ? prev + 1 : prev - 1;
					return Math.max(0, Math.min(options.length - 1, next));
				});
				return true;
			}
			if (event.name === 'return') {
				if (suppressEffortReturn) return true;
				const step = effortStep();
				if (!step) return true;
				const chosen = options[effortIndex()]!;
				const effort = chosen.id === 'default' ? undefined : chosen.id;
				setEffortStep(null);
				// OPENCODE: effort is chosen FIRST, then the TIER (Zen / Go),
				// then the named connection — the key is shared, only the
				// endpoint differs.
				if (step.opencodeConnections) {
					const tiers = distinctOpenCodeTiers(step.opencodeConnections);
					if (tiers.length > 1) {
						setTierStep({
							model: step.model,
							effort,
							connections: step.opencodeConnections,
						});
						setTierIndex(0);
						return true;
					}
					if (tiers.length === 1) {
						const tier = tiers[0]!;
						const tierConns = step.opencodeConnections.filter(
							connection => openCodeTierOf(connection) === tier,
						);
						if (tierConns.length > 1) {
							setConnectionStep({
								model: step.model,
								effort,
								connections: tierConns,
								fromTier: true,
							});
							setConnectionIndex(0);
							return true;
						}
						commitOpenCode(tierConns[0]!, step.model, effort);
						return true;
					}
					commitOpenCode(step.opencodeConnections[0]!, step.model, effort);
					return true;
				}
				const target = {
					providerId: step.providerId,
					model: step.model,
					effort,
				};
				// Mid-conversation model switches RESEND the whole history,
				// confirm first (parity: the reference warns about usage).
				// An ACCOUNT swap within the same provider skips it: the
				// context + cache head are preserved, the next turn just
				// uses the other subscription.
				if (props.hasMessages && !step.accountSwitch) setConfirming(target);
				else props.onSelect(target.providerId, target.model, target.effort);
			}
			return true;
		}
		if (confirming()) {
			if (event.name === 'y' || event.name === 'Y') {
				const target = confirming();
				if (target)
					props.onSelect(target.providerId, target.model, target.effort);
				setConfirming(null);
			} else if (event.name === 'n' || event.name === 'N') {
				setConfirming(null);
			}
			return true;
		}
		if (event.name === 'tab') {
			setFocus(prev => (prev === 'search' ? 'list' : 'search'));
			return true;
		}
		if (event.name === 'up' || event.name === 'down') {
			setFocus('list');
			moveCell(event.name === 'down' ? 'down' : 'up');
			return true;
		}
		if (event.name === 'left' || event.name === 'right') {
			setFocus('list');
			moveCell(event.name === 'right' ? 'right' : 'left');
			return true;
		}
		if (event.name === 'e' && focus() === 'list') {
			const cell = currentCell();
			if (cell) {
				const representative = cell.connections[0]!;
				const levels = effortLevelsForModel(cell.model);
				const current = effectiveEffort(representative, cell.model) ?? 'medium';
				const base = levels.indexOf(current);
				const start = base === -1 ? levels.indexOf('medium') : base;
				const next = levels[(start + 1) % levels.length] ?? 'medium';
				setEffortOverrides(prev => ({
					...prev,
					[effortKey(representative.id, cell.model)]: next,
				}));
			}
			return true;
		}
		if (connectProviderShortcut(focus(), event.name)) {
			props.onConnectProvider();
			return true;
		}
		if (event.name === 'return') {
			if (suppressInitialReturn()) return true;
			if (cursor() === -1) {
				props.onInherit?.();
				return true;
			}
			const cell = currentCell();
			if (cell) selectCell(cell);
			return true;
		}
		if (isDeleteKey(event)) {
			setFocus('search');
			setQuery(prev => prev.slice(0, -1));
			return true;
		}
		if (event.name === 'space' && !event.ctrl && !event.meta) {
			setFocus('search');
			setQuery(prev => prev + ' ');
			return true;
		}
		const char = event.name;
		if (char && char.length === 1 && !event.ctrl && !event.meta) {
			setFocus('search');
			setQuery(prev => prev + char);
		}
		return true;
	});

	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();
	const effortDefaultLabel = (): string => {
		const step = effortStep();
		if (!step) return 'Default';
		const provider = props.providers.find(
			candidate => candidate.id === step.providerId,
		);
		const catalog = provider?.modelEfforts?.[step.model];
		return catalog ? `Default (${catalog})` : 'Default';
	};

	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width={dims().width}
			height={dims().height}
			zIndex={3000}
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
				paddingY={2}
			>
				<Show
					when={
						effortStep() === null &&
						tierStep() === null &&
						confirming() === null &&
						connectionStep() === null
					}
					fallback={
						<Show
							when={connectionStep() !== null}
							fallback={
								<Show
									when={tierStep() !== null}
									fallback={
										<Show
											when={effortStep() !== null}
											fallback={
												<box flexDirection="column">
													<text fg={colors().primary} attributes={bold()}>
														Switch model
													</text>
													<box height={1} />
													<text fg={colors().warning}>
														Switching to "
														{modelWithProvider(
															confirming()?.model ?? '',
															providerForId(confirming()?.providerId),
														)}
														" will RESEND the entire conversation to the new
														model and take additional usage.
													</text>
													<box height={1} />
													<text fg={colors().secondary} attributes={dim()}>
														(y) continue · (n) cancel
													</text>
												</box>
											}
										>
											{/* opencode-style effort step: choose
									    Default or a reasoning tier for THIS
									    model before switching. */}
											<box flexDirection="column">
												<text fg={colors().primary} attributes={bold()}>
													Select effort
												</text>
												<box height={1} />
												<text fg={colors().text}>
													{modelWithProvider(
														effortStep()?.model ?? '',
														providerForId(effortStep()?.providerId),
													)}
												</text>
												<box height={1} />
												<For
													each={(() => {
														const sel = effortIndex();
														return effortOptions(effortStep()?.model ?? '').map(
															(option, idx) => ({
																option,
																active: idx === sel,
															}),
														);
													})()}
												>
													{({option, active}) => (
														<box
															flexDirection="row"
															height={1}
															backgroundColor={
																active ? activeRow().bg : undefined
															}
															{...({
																onMouseMove: () =>
																	setEffortIndex(
																		effortOptions(
																			effortStep()?.model ?? '',
																		).indexOf(option),
																	),
																onMouseUp: () => {
																	const step = effortStep();
																	if (!step) return;
																	setEffortStep(null);
																	const target = {
																		providerId: step.providerId,
																		model: step.model,
																		effort:
																			option.id === 'default'
																				? undefined
																				: option.id,
																	};
																	if (
																		props.hasMessages &&
																		!step.accountSwitch
																	) {
																		setConfirming(target);
																	} else {
																		props.onSelect(
																			target.providerId,
																			target.model,
																			target.effort,
																		);
																	}
																},
															} as any)}
														>
															<text
																fg={active ? activeRow().fg : colors().text}
																attributes={active ? bold() : undefined}
															>
																{active ? '❯ ' : '  '}
																{option.id === 'default'
																	? effortDefaultLabel()
																	: option.label}
															</text>
														</box>
													)}
												</For>
												<box height={1} />
												<text fg={colors().secondary} attributes={dim()}>
													↑/↓ select · Enter choose · Esc back
													{props.hasMessages
														? ' · will resend the conversation'
														: ''}
												</text>
											</box>
										</Show>
									}
								>
									{/* OPENCODE TIER STEP: Zen vs Go — the two share
									    ONE opencode.ai API key (only the endpoint
									    differs), so the tier is chosen BEFORE the
									    named connection. */}
									<box flexDirection="column">
										<text fg={colors().primary} attributes={bold()}>
											Select tier
										</text>
										<box height={1} />
										<text fg={colors().text}>{tierStep()?.model ?? ''}</text>
										<box height={1} />
										<For
											each={(() => {
												const sel = tierIndex();
												return tierOptions().map((option, idx) => ({
													option,
													active: idx === sel,
												}));
											})()}
										>
											{({option, active}) => (
												<box
													flexDirection="row"
													height={1}
													backgroundColor={active ? activeRow().bg : undefined}
													{...({
														onMouseMove: () =>
															setTierIndex(tierOptions().indexOf(option)),
														onMouseUp: () =>
															chooseTier(tierOptions().indexOf(option)),
													} as any)}
												>
													<text
														fg={active ? activeRow().fg : colors().text}
														attributes={active ? bold() : undefined}
													>
														{active ? '❯ ' : '  '}
														{option.label}
													</text>
													<box flexGrow={1} />
													<text fg={colors().secondary} attributes={dim()}>
														{option.detail}
													</text>
												</box>
											)}
										</For>
										<box height={1} />
										<text fg={colors().secondary} attributes={dim()}>
											↑/↓ select · Enter choose · Esc back
										</text>
									</box>
								</Show>
							}
						>
							{/* ACCOUNT PICKER: the model is chosen, pick which
							    connection (e.g. brian vs mika) to use. */}
							<box flexDirection="column">
								<text fg={colors().primary} attributes={bold()}>
									Select provider
								</text>
								<box height={1} />
								<text fg={colors().text}>{connectionStep()?.model ?? ''}</text>
								<box height={1} />
								<For
									each={(() => {
										const step = connectionStep();
										const sel = connectionIndex();
										return step
											? step.connections.map((connection, idx) => ({
													connection,
													active: idx === sel,
												}))
											: [];
									})()}
								>
									{({connection, active}) => {
										// OpenCode rows lead with the USER-GIVEN
										// name (multiple API keys per endpoint —
										// the choice is which named provider),
										// the tier + endpoint ride the detail
										// line. Other providers keep the
										// user-given name as before.
										const row = connectionPickerRow(connection);
										return (
											<box
												flexDirection="row"
												height={1}
												backgroundColor={active ? activeRow().bg : undefined}
												{...({
													onMouseMove: () =>
														setConnectionIndex(
															connectionStep()?.connections.indexOf(
																connection,
															) ?? 0,
														),
													onMouseUp: () => {
														const step = connectionStep();
														if (!step) return;
														const chosen = connection;
														setConnectionStep(null);
														const current = providerForId(
															props.currentProvider,
														);
														const sameGroup = sameProviderGroup(
															chosen,
															current,
														);
														startEffort(
															chosen,
															step.model,
															sameGroup && current?.id !== chosen.id,
														);
													},
												} as any)}
											>
												<text
													fg={active ? activeRow().fg : colors().text}
													attributes={active ? bold() : undefined}
												>
													{active ? '❯ ' : '  '}
													{row.label}
												</text>
												<box flexGrow={1} />
												<text fg={colors().secondary} attributes={dim()}>
													{row.detail}
												</text>
											</box>
										);
									}}
								</For>
								<box height={1} />
								<text fg={colors().secondary} attributes={dim()}>
									↑/↓ select · Enter choose · Esc back
								</text>
							</box>
						</Show>
					}
				>
					<box flexDirection="row" height={1}>
						<text fg={colors().primary} attributes={bold()}>
							{props.title ?? 'Select a Model'}
						</text>
						<box flexGrow={1} />
						<text fg={colors().secondary} attributes={dim()}>
							Esc close
						</text>
					</box>
					<box height={1} />
					<box height={1} />
					<box
						border
						borderStyle="rounded"
						borderColor={colors().secondary}
						paddingX={1}
						flexDirection="row"
						height={3}
					>
						<text fg={colors().secondary}>⌕ </text>
						<Show
							when={query().length === 0}
							fallback={<text fg={colors().text}>{query()}▌</text>}
						>
							<text fg={colors().secondary}>Type to filter…</text>
						</Show>
					</box>
					<box height={1} />
					<For each={visibleLines()}>
						{line => {
							if (line.kind === 'empty') {
								return (
									<text fg={colors().secondary} attributes={dim()}>
										No models match "{query()}"
									</text>
								);
							}
							if (line.kind === 'spacer') {
								return <box height={1} />;
							}
							if (line.kind === 'inherit') {
								const active = cursor() === -1;
								return (
									<box
										flexDirection="row"
										height={1}
										backgroundColor={active ? activeRow().bg : undefined}
										{...({
											onMouseUp: () => props.onInherit?.(),
										} as any)}
									>
										<text
											fg={active ? activeRow().fg : colors().text}
											attributes={active ? bold() : undefined}
										>
											{active ? '❯ ' : '  '}
											{props.inheritLabel}
										</text>
									</box>
								);
							}
							if (line.kind === 'provider') {
								// The merged OpenCode group lists its TIERS
								// (Zen / Go) instead of the raw connection
								// names — they share one account, the tier is
								// the meaningful distinction. Other groups keep
								// the user-given names (brian, mika).
								const isOpenCode = line.provider
									? providerGroupKey(line.provider) === 'opencode'
									: false;
								const names = isOpenCode
									? [
											...new Set(
												(line.connections ?? []).map(openCodeTierLabel),
											),
										].join(', ')
									: (line.connections ?? [])
											.map(connection => connection.name || connection.id)
											.join(', ');
								const title = line.provider
									? providerGroupKey(line.provider) === 'opencode'
										? 'OpenCode'
										: providerDisplayName(line.provider)
									: '';
								return (
									<box flexDirection="row" height={1}>
										<text fg={colors().primary} attributes={bold()}>
											{'  '}
											{title}
										</text>
										{names ? (
											<text fg={colors().secondary} attributes={dim()}>
												{' - '}
												{names}
											</text>
										) : (
											<></>
										)}
										{line.isCurrent ? (
											<text fg={colors().secondary} attributes={dim()}>
												{' '}
												(current)
											</text>
										) : (
											<></>
										)}
									</box>
								);
							}
							// Model DETAILS grid row: every cell is one model.
							return (
								<box flexDirection="row" height={1}>
									<For each={line.cells}>
										{(cell, colIndex) => {
											if (!cell) {
												return <box width={cellWidth()} height={1} />;
											}
											const active = cursor() === cell.index;
											const size = cell.contextSize;
											const effortBadge =
												active && cell.shownEffort
													? `[${cell.shownEffort}]`
													: '';
											const nameWidth = Math.max(
												6,
												cellWidth() -
													4 -
													(size ? size.length + 1 : 0) -
													(effortBadge ? effortBadge.length : 0),
											);
											return (
												<box
													width={cellWidth()}
													flexDirection="row"
													height={1}
													backgroundColor={active ? activeRow().bg : undefined}
													{...({
														onMouseMove: () => setCursor(cell.index),
														onMouseUp: () => selectCell(cell),
													} as any)}
												>
													<text
														fg={active ? activeRow().fg : colors().text}
														attributes={active ? bold() : undefined}
													>
														{active ? '❯ ' : '  '}
														{truncateCell(cell.model, nameWidth)}
													</text>
													<Show when={active && cell.shownEffort}>
														<text fg={activeRow().fg} attributes={dim()}>
															[{cell.shownEffort}]
														</text>
													</Show>
													<Show when={size}>
														<text fg={colors().secondary} attributes={dim()}>
															{' '}
															{size}
														</text>
													</Show>
												</box>
											);
										}}
									</For>
								</box>
							);
						}}
					</For>
					<box height={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Tab search/list · ↑↓←→ move · E effort · Enter choose · C connect
						(list) · Esc close
					</text>
				</Show>
			</box>
		</box>
	);
}
