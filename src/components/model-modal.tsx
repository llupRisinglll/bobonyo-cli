/** @jsxImportSource @opentui/solid */
import {createEffect, createSignal, For, on, Show} from 'solid-js';
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {knownPresetFor} from './connect-provider-modal';
import {loadPreferences} from '../config';
import {wrapText} from '../text-wrap';

/** Reasoning effort tiers a model can be selected at (parity: nanocoder). */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export interface ModelProvider {
	id: string;
	name: string;
	/** Endpoint the connection runs on — resolves the REAL provider title. */
	baseUrl?: string;
	models: string[];
	modelEfforts: Record<string, string>;
	contextWindow?: number;
	/**
	 * Per-model context windows (models.dev, auto-discovered catalogs like
	 * DeepSeek / MiMo are bare ids — the size column reads this map first).
	 */
	modelContextWindows?: Record<string, number>;
}

/**
 * A model name with its provider in parentheses (`deepseek-v4-flash
 * (deepseek)`). The same model name can exist under several providers
 * (e.g. a DeepSeek catalog routed through OpenCode Go), so every place the
 * modal shows a BARE model name outside its group header carries the
 * provider. Pure, unit-tested.
 */
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

/**
 * The ACTUAL provider name shown in the model modal: the matching builtin
 * preset's title (DeepSeek, OpenCode Go, Xiaomi MiMo, …) when the
 * connection is an instance of one, otherwise the user-given connection
 * name. A connection named `deepseek` must read `DeepSeek`, not the raw id.
 * Pure, unit-tested.
 */
export function providerDisplayName(provider: ModelProvider): string {
	const preset = provider.baseUrl
		? knownPresetFor({id: provider.id, baseUrl: provider.baseUrl})
		: undefined;
	return preset?.title ?? (provider.name || provider.id);
}

/**
 * Header label parts for a provider group: the USER-GIVEN connection name
 * first, plus the REAL provider name when it differs (rendered secondary —
 * `(deepseek · DeepSeek)`). Pure, unit-tested.
 */
export function providerHeaderParts(provider: ModelProvider): {
	user: string;
	real?: string;
} {
	const user = provider.name || provider.id;
	const real = providerDisplayName(provider);
	return {user, real: real && real !== user ? real : undefined};
}

/** REAL provider identity used to merge multiple connections (preset id). */
export function providerGroupKey(provider: ModelProvider): string {
	const preset = provider.baseUrl
		? knownPresetFor({id: provider.id, baseUrl: provider.baseUrl})
		: undefined;
	return preset?.id ?? provider.id;
}

/**
 * ONE group per REAL provider: connections that resolve to the same preset
 * (e.g. two opencode-go accounts named `brian` and `mika`) merge into a
 * single list whose models are the union. Custom providers keep their own
 * group. Pure, unit-tested.
 */
export function groupProviders(providers: ModelProvider[]): ProviderGroup[] {
	const byKey = new Map<string, ProviderGroup>();
	for (const provider of providers) {
		const key = providerGroupKey(provider);
		let group = byKey.get(key);
		if (!group) {
			group = {
				providerId: key,
				title: providerDisplayName(provider),
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

/** One provider group = all connections under one REAL provider. */
export interface ProviderGroup {
	providerId: string;
	title: string;
	connections: ModelProvider[];
	models: string[];
}

/** Whether two connections belong to the SAME real provider. */
export function sameProviderGroup(
	a: ModelProvider | undefined,
	b: ModelProvider | undefined,
): boolean {
	if (!a || !b) return false;
	return providerGroupKey(a) === providerGroupKey(b);
}

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

/**
 * Row the `/model` modal OPENS on: the CURRENT model row when it is in the
 * list, otherwise the first navigable row (a model, or the Inherit row in
 * settings fallback mode). -1 when there is nothing to navigate to. Pure,
 * unit-tested.
 */
export function initialModelRowIndex(
	rows: ReadonlyArray<{kind: string; isCurrent?: boolean}>,
): number {
	const current = rows.findIndex(row => row.kind === 'model' && row.isCurrent);
	if (current !== -1) return current;
	return rows.findIndex(row => row.kind === 'model' || row.kind === 'inherit');
}

/**
 * The bare `C` connect-provider shortcut must ONLY fire while the LIST is
 * focused. Typing a search query starts in the search box, so an
 * ungated `C` would open the provider wizard on the first letter of
 * "codex"/"claude" — every search would explode. Pure, unit-tested.
 */
export function connectProviderShortcut(
	focus: 'search' | 'list',
	key: string,
): boolean {
	return key === 'c' && focus === 'list';
}

/**
 * Next grid cursor for one model-modal navigation step (pure, unit-tested).
 * `current` is a global index over the flattened model cells; -1 is the
 * Inherit row. LEFT/RIGHT wrap across provider-group boundaries — LEFT from
 * the first cell of a group jumps to the PREVIOUS group's last cell and
 * RIGHT from the last cell jumps to the NEXT group's first cell (they must
 * stay symmetric); the very first/last cell of the whole grid stay put.
 */
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
			let next = local - columns;
			if (next < 0) {
				const bottomRow = Math.max(0, Math.floor((count - 1) / columns));
				const bottom = bottomRow * columns + col;
				next = bottom < count ? bottom : Math.max(0, bottom - columns);
				if (next === local) {
					if (groupIndex > 0) {
						return (
							offset(groupIndex - 1) + (groupSizes[groupIndex - 1] ?? 0) - 1
						);
					}
					if (hasInherit) return -1;
					return current;
				}
			}
			return offset(groupIndex) + next;
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
	/** When set, a leading "Inherit" row restores the main agent model. */
	inheritLabel?: string;
	onInherit?: () => void;
	/** Non-empty conversation ⇒ warn that switching resends all messages. */
	hasMessages: boolean;
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
	} | null>(null);
	/** Account picker: the model is chosen, pick WHICH connection to use. */
	const [connectionStep, setConnectionStep] = createSignal<{
		model: string;
		connections: ModelProvider[];
	} | null>(null);
	const [connectionIndex, setConnectionIndex] = createSignal(0);
	const [effortIndex, setEffortIndex] = createSignal(0);
	const EFFORT_OPTIONS: Array<{id: string; label: string}> = [
		{id: 'default', label: 'Default'},
		...EFFORT_LEVELS.map(level => ({id: level, label: level})),
	];
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());

	const currentCell = (): ModelCell | undefined => {
		const cells = modelCells();
		return cursor() >= 0 ? cells[cursor()] : undefined;
	};
	// Grid navigation (row-major per provider group). Moving past a group's
	// last row jumps to the NEXT group's first cell so long catalogs stay
	// reachable with ↓ alone; ↑ from a group's first cell wraps to the
	// previous group's last cell (or the Inherit row). LEFT/RIGHT wrap across
	// group boundaries symmetrically (pure, unit-tested).
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
	): void => {
		setEffortStep({
			providerId: provider.id,
			model,
			accountSwitch,
		});
		const currentEffort = effectiveEffort(provider, model);
		setEffortIndex(
			currentEffort
				? Math.max(
						0,
						EFFORT_OPTIONS.findIndex(option => option.id === currentEffort),
					)
				: 0,
		);
	};

	const selectCell = (cell: ModelCell): void => {
		// A provider group with MULTIPLE accounts asks which connection to
		// use for the selected model BEFORE the effort step.
		if (cell.connections.length > 1) {
			setConnectionStep({model: cell.model, connections: cell.connections});
			setConnectionIndex(0);
			return;
		}
		startEffort(cell.connections[0]!, cell.model);
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
			else if (effortStep()) setEffortStep(null);
			else if (confirming()) setConfirming(null);
			else props.onClose();
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
				// Same provider, DIFFERENT account = an account swap: the
				// conversation context and cache head stay untouched (the
				// next turn sends normally), so no "will RESEND" confirm.
				const current = providerForId(props.currentProvider);
				const sameGroup = sameProviderGroup(chosen, current);
				const sameConnection = current?.id === chosen.id;
				startEffort(chosen, step.model, sameGroup && !sameConnection);
			}
			return true;
		}
		if (effortStep()) {
			const options = EFFORT_OPTIONS;
			if (event.name === 'up' || event.name === 'down') {
				setEffortIndex(prev => {
					const next = event.name === 'down' ? prev + 1 : prev - 1;
					return Math.max(0, Math.min(options.length - 1, next));
				});
				return true;
			}
			if (event.name === 'return') {
				const step = effortStep();
				if (!step) return true;
				const chosen = options[effortIndex()]!;
				const target = {
					providerId: step.providerId,
					model: step.model,
					effort: chosen.id === 'default' ? undefined : chosen.id,
				};
				setEffortStep(null);
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
				const current = effectiveEffort(representative, cell.model) ?? 'medium';
				const base = EFFORT_LEVELS.indexOf(
					current as (typeof EFFORT_LEVELS)[number],
				);
				const start = base === -1 ? EFFORT_LEVELS.indexOf('medium') : base;
				const next =
					EFFORT_LEVELS[(start + 1) % EFFORT_LEVELS.length] ?? 'medium';
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
						confirming() === null &&
						connectionStep() === null
					}
					fallback={
						<Show
							when={connectionStep() !== null}
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
												" will RESEND the entire conversation to the new model
												and take additional usage.
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
												return EFFORT_OPTIONS.map((option, idx) => ({
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
															setEffortIndex(EFFORT_OPTIONS.indexOf(option)),
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
															if (props.hasMessages && !step.accountSwitch) {
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
									{({connection, active}) => (
										<box
											flexDirection="row"
											height={1}
											backgroundColor={active ? activeRow().bg : undefined}
											{...({
												onMouseMove: () =>
													setConnectionIndex(
														connectionStep()?.connections.indexOf(connection) ??
															0,
													),
												onMouseUp: () => {
													const step = connectionStep();
													if (!step) return;
													const chosen = connection;
													setConnectionStep(null);
													const current = providerForId(props.currentProvider);
													const sameGroup = sameProviderGroup(chosen, current);
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
												{connection.name || connection.id}
											</text>
											<box flexGrow={1} />
											<text fg={colors().secondary} attributes={dim()}>
												{connection.baseUrl ?? ''}
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
					<box flexDirection="row" height={1}>
						<text fg={colors().primary} attributes={bold()}>
							Select a Model
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
								const names = (line.connections ?? [])
									.map(connection => connection.name || connection.id)
									.join(', ');
								const title = line.provider
									? providerDisplayName(line.provider)
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
