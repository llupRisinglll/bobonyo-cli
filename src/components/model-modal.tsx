/** @jsxImportSource @opentui/solid */
import {createSignal, For, Show} from 'solid-js';
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';

/** Reasoning effort tiers a model can be selected at (parity: nanocoder). */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export interface ModelProvider {
	id: string;
	name: string;
	models: string[];
	modelEfforts: Record<string, string>;
	contextWindow?: number;
}

type Row =
	| {kind: 'provider'; provider: ModelProvider; expanded: boolean; isCurrent: boolean}
	| {kind: 'model'; provider: ModelProvider; model: string; isCurrent: boolean}
	| {kind: 'inherit'}
	| {kind: 'spacer'}
	| {kind: 'empty'};

/**
 * `/model` MODAL (parity: nanocoder's grouped ModelSelector), providers
 * grouped and expandable, searchable, ↑/↓ + Enter, ←/→ cycles the reasoning
 * effort on a highlighted model, Esc closes. Selecting a model calls
 * `onSelect(providerId, model, effort)`.
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
	const [confirming, setConfirming] = createSignal<{
		providerId: string;
		model: string;
		effort?: string;
	} | null>(null);
	const [rowIndex, setRowIndex] = createSignal(0);
	// Per-model effort OVERRIDE selected with ←/→ (keyed provider\0model).
	const [effortOverrides, setEffortOverrides] = createSignal<
		Record<string, string>
	>({});
	const cardWidth = () => Math.min(80, Math.max(56, dims().width - 6));
	const cardY = () => Math.max(2, Math.floor(dims().height / 4));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	// Bound the card so it NEVER overlaps the input box/status line below
	// (parity: the reference popover floats over the composer area).
	const cardHeight = () =>
		Math.min(22, Math.max(8, dims().height - cardY() - 5));
	const listVisible = () => Math.max(3, cardHeight() - 9);
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	// Active-row palette: info tint + guaranteed-readable foreground.
	const activeRow = () => activeRowPalette(colors());

	const matches = (text: string): boolean => {
		const q = query().trim().toLowerCase();
		return !q || text.toLowerCase().includes(q);
	};

	const buildRows = (): Row[] => {
		const rows: Row[] = [];
		if (props.inheritLabel) {
			rows.push({kind: 'inherit'});
			rows.push({kind: 'spacer'});
		}
		// CURRENT provider is ALWAYS first (parity: the reference sorts the active
		// group to the top); the rest stay in config order.
		const sorted = [...props.providers].sort((a, b) => {
			const aCurrent = a.id === props.currentProvider ? 0 : 1;
			const bCurrent = b.id === props.currentProvider ? 0 : 1;
			return aCurrent !== bCurrent
				? aCurrent - bCurrent
				: (a.name ?? a.id).localeCompare(b.name ?? b.id);
		});
		for (const provider of sorted) {
			const isCurrent = provider.id === props.currentProvider;
			const nameMatches = matches(provider.name ?? provider.id);
			const visibleModels = provider.models.filter(
				model => nameMatches || matches(model),
			);
			if (query().trim() && !nameMatches && visibleModels.length === 0) {
				continue;
			}
			// Blank line BETWEEN provider groups (before every header except
			// the first) + after each header, parity with the resume
			// picker's grouping so the list never feels cluttered.
			if (rows.length > 0) rows.push({kind: 'spacer'});
			// NO expand/collapse, every provider is a HEADER row with its
			// models listed flat underneath (parity: the reference grouped list).
			rows.push({
				kind: 'provider',
				provider,
				expanded: true,
				isCurrent,
			});
			// Blank line after every provider header, groups breathe
			// (parity with the resume picker's date-group spacing).
			rows.push({kind: 'spacer'});
			for (const model of provider.models) {
				if (!nameMatches && !matches(model)) continue;
				rows.push({
					kind: 'model',
					provider,
					model,
					isCurrent: isCurrent && model === props.currentModel,
				});
			}
		}
		if (rows.length === 0) rows.push({kind: 'empty'});
		return rows;
	};

	// Navigation moves between MODEL/INHERIT rows only, provider headers are
	// display-only.
	const moveRow = (delta: number): void => {
		const rows = buildRows();
		if (rows.length === 0) return;
		let next = rowIndex() + delta;
		while (
			rows[next]?.kind === 'provider' ||
			rows[next]?.kind === 'spacer' ||
			rows[next]?.kind === 'empty'
		) {
			next += delta;
		}
		if (next < 0 || next >= rows.length) return;
		setRowIndex(next);
		const maxVisible = listVisible();
		setScrollStart(prev =>
			next < prev
				? next
				: next >= prev + maxVisible
					? next - maxVisible + 1
					: prev,
		);
	};

	// The OpenTUI reconciler's <For> only re-renders when the `each` array
	// reference changes, fold selection into the item array.
	// Fold the effort override INTO the item array, the OpenTUI reconciler's
	// <For> only re-renders when the `each` array reference changes.
	const items = () =>
		buildRows().map((row, index) => ({
			row,
			index,
			active: rowIndex() === index,
			shownEffort:
				row.kind === 'model'
					? effectiveEffort(row.provider, row.model)
					: undefined,
		}));

	const currentRow = (): Row | undefined => items()[rowIndex()]?.row;
	const [scrollStart, setScrollStart] = createSignal(0);
	const effortKey = (provider: string, model: string): string =>
		`${provider}\u0000${model}`;
	const effectiveEffort = (
		provider: ModelProvider,
		model: string,
	): string | undefined =>
		effortOverrides()[effortKey(provider.id, model)] ??
		provider.modelEfforts[model];

	useKeyboard(event => {
		if (event.name === 'escape') {
			if (confirming()) setConfirming(null);
			else props.onClose();
			return;
		}
		if (confirming()) {
			if (event.name === 'y' || event.name === 'Y') {
				const target = confirming();
				if (target) props.onSelect(target.providerId, target.model, target.effort);
				setConfirming(null);
			} else if (event.name === 'n' || event.name === 'N') {
				setConfirming(null);
			}
			return;
		}
		if (event.name === 'up' || event.name === 'down') {
			moveRow(event.name === 'down' ? 1 : -1);
			return;
		}
		if (event.name === 'c') {
			props.onConnectProvider();
			return;
		}
		if (event.name === 'left' || event.name === 'right') {
			const row = currentRow();
			if (row?.kind === 'model') {
				const current = effectiveEffort(row.provider, row.model) ?? 'medium';
				const base = EFFORT_LEVELS.indexOf(
					current as (typeof EFFORT_LEVELS)[number],
				);
				const start = base === -1 ? EFFORT_LEVELS.indexOf('medium') : base;
				const delta = event.name === 'right' ? 1 : -1;
				const next =
					EFFORT_LEVELS[(start + delta + EFFORT_LEVELS.length) % EFFORT_LEVELS.length] ??
					'medium';
				setEffortOverrides(prev => ({
					...prev,
					[effortKey(row.provider.id, row.model)]: next,
				}));
			}
			return;
		}
		if (event.name === 'return') {
			const row = currentRow();
			if (!row) return;
			if (row.kind === 'inherit') {
				props.onInherit?.();
				return;
			}
			if (row.kind === 'model') {
				const target = {
					providerId: row.provider.id,
					model: row.model,
					effort: effectiveEffort(row.provider, row.model),
				};
				// Mid-conversation model switches RESEND the whole history,
				// confirm first (parity: the reference warns about usage).
				if (props.hasMessages) {
					setConfirming(target);
				} else {
					props.onSelect(target.providerId, target.model, target.effort);
				}
				return;
			}
			return;
		}
		if (event.name === 'backspace') {
			setQuery(prev => prev.slice(0, -1));
			return;
		}
		const char = event.name;
		if (char && char.length === 1 && !event.ctrl && !event.meta) {
			setQuery(prev => prev + char);
			setRowIndex(0);
		}
	});

	const visibleItems = () => {
		const all = items();
		return all.slice(scrollStart(), scrollStart() + listVisible());
	};
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();

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
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
			>
				<Show
					when={confirming() === null}
					fallback={
						<box flexDirection="column">
							<text fg={colors().primary} attributes={bold()}>
								Switch model
							</text>
							<box height={1} />
							<text fg={colors().warning}>
								Switching to "{confirming()?.model}" will RESEND the
								entire conversation to the new model and take
								additional usage.
							</text>
							<box height={1} />
							<text fg={colors().secondary} attributes={dim()}>
								(y) continue · (n) cancel
							</text>
						</box>
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
					<For each={visibleItems()}>
						{(item) => {
							const row = item.row;
							if (row.kind === 'empty') {
								return (
									<text fg={colors().secondary} attributes={dim()}>
										No models match "{query()}"
									</text>
								);
							}
							if (row.kind === 'inherit') {
								return (
									<box
										flexDirection="row"
										height={1}
										backgroundColor={
											item.active ? activeRow().bg : undefined
										}
									>
										<text
											fg={
												item.active
													? activeRow().fg
													: colors().text
											}
											attributes={item.active ? bold() : undefined}
										>
											{item.active ? '❯ ' : '  '}
											{props.inheritLabel}
										</text>
									</box>
								);
							}
							if (row.kind === 'provider') {
								return (
									<box
										flexDirection="row"
										height={1}
									>
										<text
											fg={colors().primary}
											attributes={bold()}
										>
											{'  '}
											{row.provider.name ?? row.provider.id}
											{row.isCurrent ? ' (current)' : ''}
										</text>
									</box>
								);
							}
							if (row.kind === 'spacer') {
								return <box height={1} />;
							}
							return (
								<box
									flexDirection="row"
									height={1}
									backgroundColor={
										item.active ? activeRow().bg : undefined
									}
								>
									<text
										fg={
											item.active
												? activeRow().fg
												: colors().text
										}
										attributes={item.active ? bold() : undefined}
									>
										{'    '}
										{row.model}
										{row.isCurrent ? ' (current)' : ''}
									</text>
									{/* Effort in its OWN column so model names
									    and sizes align across rows. */}
									<text
										width={16}
										fg={
											item.active
												? activeRow().fg
												: colors().secondary
										}
										attributes={
											item.active ? bold() : dim()
										}
									>
										{item.shownEffort
											? ` [${item.shownEffort}]`
											: ''}
									</text>
									<box flexGrow={1} />
									{/* Model SIZE on the right (parity: the reference). */}
									<text
										fg={
											item.active
												? activeRow().fg
												: colors().secondary
										}
										attributes={item.active ? bold() : dim()}
									>
										{row.provider.contextWindow
											? formatContextLength(row.provider.contextWindow)
											: '-'}
									</text>
									{item.active ? (
										<text fg={activeRow().fg} attributes={dim()}>
											{'  ←/→ effort'}
										</text>
									) : (
										<></>
									)}
								</box>
							);
						}}
					</For>
					<box height={1} />
					<text fg={colors().secondary} attributes={dim()}>
						↑/↓ select · Enter choose · ←/→ effort · C connect provider · Esc close
					</text>
				</Show>
			</box>
		</box>
	);
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
