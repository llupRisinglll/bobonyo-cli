/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {
	activeAgents,
	activeEndpoint,
	cavemanMode,
	hideThinking,
	mode,
	maxMessages,
	settingsIndex,
	settingsTab,
	setSettingsIndex,
	setSettingsTab,
	sessionId,
	sessionName,
	statusLineEnabled,
	titleShape,
	toolProfile,
} from '../state';
import {listProviders} from '../config';
import {listCheckpoints} from '../session';
import {loadSettings} from '../settings';
import {loadPreferences} from '../config';
import {bgTasks} from '../bash';
import {colors, themeName} from '../theme';
import {loadSteeringConfig} from '../steering';
import {loadMCPConfig} from '../mcp';
import {loadCustomCommands, loadCustomTools, loadSkills} from '../custom';
import {activeRowPalette} from '../row-highlight';

export const SETTINGS_TABS = [
	'Appearance',
	'Input',
	'Behavior',
	'Capabilities',
	'Providers',
	'Advanced',
] as const;

export interface SettingsRow {
	key: string;
	label: string;
	value: string;
}

/** Rows that edit through an OPTION SELECTOR (not a free-text prompt). */
export const SETTING_OPTIONS: Record<string, string[]> = {
	theme: ['omnicode', 'tokyo-night'],
	titleShape: ['powerline-angled', 'tiny', 'none'],
	statusLine: ['on', 'off'],
	hideThinking: ['on', 'off'],
	cavemanMode: ['on', 'off'],
	mode: ['yolo', 'normal', 'plan', 'auto-accept'],
	profile: ['full', 'minimal', 'nano', 'auto'],
};

/** Reactive row list for the active settings tab (GAP-19). */
export function settingsRows(tab: number): SettingsRow[] {
	switch (tab) {
		case 0:
			return [
				{key: 'theme', label: 'Theme', value: themeName()},
				{
					key: 'titleShape',
					label: 'Title Shape',
					value: titleShape(),
				},
				{
					key: 'statusLine',
					label: 'Status Line',
					value: statusLineEnabled() ? 'on' : 'off',
				},
				{key: 'profile', label: 'Tool profile', value: toolProfile()},
			];
		case 1:
			return [
				{key: 'maxMessages', label: 'Max messages', value: String(maxMessages())},
				{
					key: 'pasteThreshold',
					label: 'Paste threshold',
					value: 'single-line (multi-line pastes run immediately)',
				},
			];
		case 2:
			return [
				{key: 'mode', label: 'Mode', value: mode()},
				{
					key: 'autoCompactThreshold',
					label: 'Auto-compact threshold',
					value: loadSettings().autoCompact?.enabled
						? `${loadSettings().autoCompact?.threshold}%`
						: 'off',
				},
				{
					key: 'reasoningTraces',
					label: 'Reasoning traces',
					value: 'shown as Thought blocks',
				},
				{
					key: 'hideThinking',
					label: 'Hide thinking',
					value: hideThinking() ? 'on' : 'off',
				},
				{
					key: 'cavemanMode',
					label: 'Caveman mode',
					value: cavemanMode() ? 'on' : 'off',
				},
				{
					key: 'sessions',
					label: 'Sessions',
					value: `${listCheckpoints().length} checkpoints`,
				},
			];
		case 3:
			return [
				{key: 'model', label: 'Model', value: activeEndpoint().model},
				{key: 'skills', label: 'Skills', value: `${loadSkills().length} loaded`},
				{
					key: 'customCommands',
					label: 'Custom commands',
					value: `${loadCustomCommands().length} loaded`,
				},
				{
					key: 'customTools',
					label: 'Custom tools',
					value: `${loadCustomTools().length} loaded`,
				},
				{
					key: 'background',
					label: 'Background tasks',
					value: String(bgTasks().filter(task => task.running).length),
				},
				{
					key: 'agents',
					label: 'Agents',
					// Built-in agent personalities (General / Explore), the
					// discoverable names; active delegation count appended.
					value:
						'General · Explore' +
						(activeAgents() > 0 ? ` · ${activeAgents()} active` : ''),
				},
				{
					key: 'visionModel',
					label: 'Vision model',
					value:
						loadPreferences().visionModel ??
						'inherit (main agent model)',
				},
				{
					key: 'webSearchModel',
					label: 'Web search model',
					value:
						loadPreferences().webSearchModel ??
						'inherit (main agent model)',
				},
			];
		case 4:
			return listProviders().map(provider => ({
				key: `provider:${provider.id}`,
				label: provider.id,
				value: `${provider.baseUrl} · ${provider.models.length} models`,
			})).concat([
				{
					key: 'mcp',
					label: 'MCP servers',
					value: `${loadMCPConfig().length} configured`,
				},
				{
					key: 'toolApproval',
					label: 'Tool approval',
					value: mode() === 'yolo' ? 'off (yolo)' : 'on',
				},
			]);
		default:
			return [
				{key: 'session', label: 'Session', value: `${sessionName()} (${sessionId()})`},
				{
					key: 'checkpoints',
					label: 'Checkpoints',
					value: String(listCheckpoints().length),
				},
				{
					key: 'steering',
					label: 'Steering (InnerDaemon)',
					value: loadSteeringConfig().enabled ? 'enabled' : 'disabled',
				},
				{
					key: 'watchdog',
					label: 'Watchdog',
					value: `${loadSettings().watchdogMs ?? 0}ms`,
				},
				{
					key: 'streamGuard',
					label: 'Stream guard',
					value: loadSettings().streamGuard?.maxDurationMs
						? `${loadSettings().streamGuard?.maxDurationMs}ms`
						: 'off',
				},
				{
					key: 'privacy',
					label: 'Privacy patterns',
					value: `${loadSettings().privacy?.patterns?.length ?? 0} configured`,
				},
				{
					key: 'trustedDirs',
					label: 'Trusted directories',
					value: String(loadSettings().trustedDirs?.length ?? 0),
				},
				{
					key: 'developerMode',
					label: 'Developer mode',
					value: 'off (use `bobonyo preview tui`)',
				},
			];
	}
}

/** Fuzzy row filter (parity: nanocoder settings-tabs filterRows). */
function filterScore(text: string, query: string): number {
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	if (lower === q) return 1000;
	if (lower.startsWith(q)) return 850;
	if (lower.includes(q)) return 700;
	let cursor = 0;
	for (const ch of q) {
		const at = lower.indexOf(ch, cursor);
		if (at === -1) return 0;
		cursor = at + 1;
	}
	return 200 + (lower.length - cursor);
}

function filterRows(rows: SettingsRow[], query: string): SettingsRow[] {
	const q = query.trim();
	if (!q) return rows;
	return rows
		.map(row => ({
			row,
			// Parity: nanocoder scores the LABEL and the row ID (never the
			// displayed value, otherwise "mode" would match "omnicode").
			score: Math.max(filterScore(row.label, q), filterScore(row.key, q)),
		}))
		.filter(({score}) => score > 0)
		.sort((a, b) =>
			b.score !== a.score
				? b.score - a.score
				: a.row.label.localeCompare(b.row.label),
		)
		.map(({row}) => row);
}

/**
 * Settings panel (parity with nanocoder's settings-tabs.tsx): a SEARCH box on
 * top (⌕ prefix + placeholder), the tab bar below it, then the filtered rows
 * with a `❯` selected marker (label in a fixed column, value after it) and an
 * empty state. Search filters the ACTIVE tab and AUTO-NAVIGATES to the first
 * tab that has matches.
 */
export function SettingsPanel(props: {
	onEdit: (row: SettingsRow) => void;
	query: () => string;
	setQuery: (value: string) => void;
	focus: () => 'search' | 'list';
	hovered: () => number;
	setHovered: (index: number) => void;
}) {
	// The OpenTUI reconciler's <For> only re-renders items when the `each`
	// array REFERENCE changes, signals read inside the children (selection,
	// hover) are stale. Fold them into the memo so ↑/↓/hover re-render.
	const rows = createMemo(() =>
		filterRows(settingsRows(settingsTab()), props.query()).map(
			(row, index) => ({
				row,
				selected: settingsIndex() === index,
				hovered: props.hovered() === index,
			}),
		),
	);
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	// Active-row palette: info tint + guaranteed-readable foreground (no
	// theme can make the highlighted row's text invisible).
	const activeRow = createMemo(() => activeRowPalette(colors()));
	// The ACTIVE-tab indicator follows the selected Title Shape setting:
	// powerline-angled = filled segment, tiny = ▍ marker, none = bold text.
	// While SEARCHING, tabs with NO matches are HIDDEN so ←/→ navigate only
	// the tabs that actually have results (the query is never cleared by
	// arrow navigation).
	const tabs = createMemo(() => {
		const q = props.query().trim();
		const indices = q
			? SETTINGS_TABS.map((_, index) => index).filter(
					index => filterRows(settingsRows(index), q).length > 0,
				)
			: SETTINGS_TABS.map((_, index) => index);
		return indices.map(index => {
			const tab = SETTINGS_TABS[index]!;
			const active = settingsTab() === index;
			const shape = titleShape();
			const marker =
				shape === 'none'
					? active
						? '❯ '
						: '  '
					: shape === 'tiny'
						? active
							? '▍'
							: ' '
						: ' ';
			return {
				tab,
				index,
				active,
				marker,
				fill: shape !== 'tiny' && shape !== 'none',
			};
		});
	});
	return (
		<box flexDirection="column">
			{/* Search box (ABOVE the tabs): rounded border, ⌕ prefix. */}
			<box
				border
				borderStyle="rounded"
				borderColor={props.focus() === 'search' ? colors().info : colors().secondary}
				paddingX={1}
				flexDirection="row"
				height={3}
			>
				<text fg={colors().secondary}>⌕ </text>
				<Show when={props.query().length === 0} fallback={<text fg={colors().text}>{props.query()}▌</text>}>
					<text fg={colors().secondary}>Search settings…</text>
				</Show>
			</box>
			<box height={1} />
			<box flexDirection="row" height={1}>
				<For each={tabs()}>
					{(item) => {
						const active = item.active;
						return (
							<box
								backgroundColor={
									item.fill && active ? activeRow().bg : undefined
								}
								{...({onMouseUp: () => setSettingsTab(item.index)} as any)}
							>
								<text
									fg={
										active
											? item.fill
												? activeRow().fg
												: colors().primary
											: colors().secondary
									}
									attributes={active ? bold() : dim()}
								>
									{`${item.marker}${item.tab} `}
								</text>
							</box>
						);
					}}
				</For>
			</box>
			<box height={1} />
			<For each={rows()}>
				{(item, index) => {
					const {row, selected, hovered} = item;
					// HOVER and ARROW navigation render IDENTICALLY,
					// one highlight style (`❯` + info background), so
					// moving with the mouse looks the same as moving
					// with ↑/↓.
					const active = selected || hovered;
					return (
					// The WHOLE row is the click/hover target (not just
					// the label text), mouse support parity.
					<box
						flexDirection="row"
						height={1}
						backgroundColor={active ? activeRow().bg : undefined}
						{...({
							onMouseUp: () => setSettingsIndex(index()),
							// Hovering IS navigating: the highlight follows the
							// mouse exactly like ↑/↓.
							onMouseMove: () => {
								props.setHovered(index());
								setSettingsIndex(index());
							},
							onMouseOut: () => props.setHovered(-1),
						} as any)}
					>
						<text
							fg={active ? activeRow().fg : colors().text}
							attributes={active ? bold() : undefined}
							width={22}
						>
							{active ? '❯ ' : '  '}
							{row.label}
						</text>
						<text
							fg={active ? activeRow().fg : colors().secondary}
						>
							{'  '}
							{row.value}
						</text>
					</box>
					);
				}}
			</For>
			<box height={1} />
			<Show when={rows().length === 0}>
				<text fg={colors().secondary}>No settings match "{props.query()}"</text>
			</Show>
			<text fg={colors().secondary} attributes={dim()}>
				↑/↓ select · Enter edit · Tab focus · Esc close
			</text>
		</box>
	);
}

/**
 * modal-style settings MODAL: a full-screen translucent backdrop (the chat
 * stays visible behind it) with a card container centered near the top
 * quarter. Clicking the backdrop closes; both mouse and keyboard drive the
 * panel (search auto-navigates across tabs).
 */
export function SettingsModal(props: {
	onClose: () => void;
	onEdit: (row: SettingsRow) => void;
	onApply: (key: string, value: string) => void;
	/** Open the /model modal (Model / Vision / Web-search rows). */
	onModelSelect: (target: 'main' | 'web' | 'vision') => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const [query, setQuery] = createSignal('');
	// AUTO-CLOSE GUARD: modals opened by a row click receive the SAME
	// click's mouse-UP on the backdrop, which would close them instantly.
	// Only that opening release is ignored — a time window, NOT a one-shot
	// boolean (the flag got consumed by the opening release and swallowed
	// the user's first real outside click: click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	const [focus, setFocus] = createSignal<'search' | 'list'>('search');
	const [hoveredRow, setHoveredRow] = createSignal(-1);
	const [editing, setEditing] = createSignal<SettingsRow | null>(null);
	const [optionIndex, setOptionIndex] = createSignal(0);
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const cardWidth = () => Math.min(84, Math.max(56, dims().width - 4));
	// Vertically CENTER the card (parity: the reference centers its dialogs);
	// with a short list the old quarter-height anchor floated it near the
	// top of the screen.
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const filtered = createMemo(() =>
		SETTINGS_TABS.map((_, tab) => filterRows(settingsRows(tab), query())),
	);
	// Auto-navigate: typing a query that has no match on the active tab jumps
	// to the first tab that DOES have matches.
	createEffect(() => {
		const q = query().trim();
		if (!q) return;
		const lists = filtered();
		if ((lists[settingsTab()]?.length ?? 0) === 0) {
			const first = lists.findIndex(list => list.length > 0);
			if (first !== -1) {
				setSettingsTab(first);
				setSettingsIndex(0);
			}
		}
	});
	const activeRows = () => filtered()[settingsTab()] ?? [];
	// Preserve letter case (OpenTUI reports `S` as {name:'s', shift:true}).
	const typedChar = (ev: {name: string; shift?: boolean}): string => {
		const char = ev.name;
		if (char.length !== 1) return '';
		if (ev.shift && /^[a-z]$/.test(char)) return char.toUpperCase();
		return char;
	};
	useKeyboard(event => {
		if (event.name === 'escape') {
			if (editing()) {
				setEditing(null);
			} else if (query()) {
				setQuery('');
			} else {
				props.onClose();
			}
			return;
		}
		if (editing()) {
			const options = SETTING_OPTIONS[editing()?.key ?? ''] ?? [];
			if (event.name === 'up' || event.name === 'down') {
				setOptionIndex(prev =>
					event.name === 'up'
						? Math.max(0, prev - 1)
						: Math.min(options.length - 1, prev + 1),
				);
				return;
			}
			if (event.name === 'return') {
				const option = options[optionIndex()];
				if (option) props.onApply(editing()?.key ?? '', option);
				setEditing(null);
				return;
			}
			return;
		}
		if (event.name === 'tab') {
			setFocus(prev => (prev === 'search' ? 'list' : 'search'));
			return;
		}
		if (event.name === 'left' || event.name === 'right') {
			// While SEARCHING, ←/→ navigate ONLY the tabs that have matches,
			// the query is NOT cleared (filtering stays live while browsing).
			const q = query().trim();
			const indices = q
				? SETTINGS_TABS.map((_, index) => index).filter(
						index => filterRows(settingsRows(index), q).length > 0,
					)
				: SETTINGS_TABS.map((_, index) => index);
			if (indices.length === 0) return;
			const current = Math.max(0, indices.indexOf(settingsTab()));
			const next =
				indices[
					(event.name === 'right'
						? current + 1
						: current + indices.length - 1) % indices.length
				] ?? 0;
			setSettingsTab(next);
			setSettingsIndex(0);
			return;
		}
		if (event.name === 'up' || event.name === 'down') {
			if (focus() === 'search') {
				setFocus('list');
			}
			const count = activeRows().length;
			// Arrow navigation clears the mouse hover so the highlight never
			// lags behind on a stale row.
			setHoveredRow(-1);
			setSettingsIndex(prev =>
				event.name === 'up'
					? Math.max(0, prev - 1)
					: Math.min(Math.max(0, count - 1), prev + 1),
			);
			return;
		}
		if (event.name === 'return') {
			const row = activeRows()[settingsIndex()];
			if (row) {
				// Model-family rows open the MODEL MODAL (parity: original
				// nanocoder routes model selection to the picker).
				if (row.key === 'model') {
					props.onModelSelect('main');
					return;
				}
				if (row.key === 'visionModel') {
					props.onModelSelect('vision');
					return;
				}
				if (row.key === 'webSearchModel') {
					props.onModelSelect('web');
					return;
				}
				if (SETTING_OPTIONS[row.key]) {
					// Option-backed rows open an in-modal SELECTOR (parity with
					// nanocoder's managed setting panels) instead of a prompt.
					setOptionIndex(
						Math.max(
							0,
							SETTING_OPTIONS[row.key]?.indexOf(row.value) ?? 0,
						),
					);
					setEditing(row);
				} else {
					props.onEdit(row);
				}
			}
			return;
		}
		if (event.name === 'backspace') {
			setQuery(prev => prev.slice(0, -1));
			return;
		}
		if (event.name === 'space' && !event.ctrl && !event.meta) {
			setQuery(prev => prev + ' ');
			setFocus('search');
			return;
		}
		const char = typedChar(event);
		if (char && !event.ctrl && !event.meta) {
			setQuery(prev => prev + char);
			setFocus('search');
		}
	});
	// Card height: search box (3) + gap + tabs (1) + gap + rows + footer (1)
	// + footer gap + card padding (2).
	const cardHeight = () =>
		3 + 1 + 1 + 1 + Math.max(1, activeRows().length) + 1 + 1 + 2;
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
			// FULL-SCREEN backdrop: the input box and status line stay mounted
			// BEHIND the tint (dimmed, not hidden), the card floats above.
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
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
			>
				<Show
					when={editing()}
					fallback={
						<SettingsPanel
							onEdit={props.onEdit}
							query={query}
							setQuery={setQuery}
							focus={focus}
							hovered={hoveredRow}
							setHovered={setHoveredRow}
						/>
					}
				>
					{/* CLEAN option-selector card (parity: the reference), only the
					    options and ONE hint line; no repeated label/footers. */}
					<box flexDirection="row" height={1}>
						<text fg={colors().primary} attributes={bold()}>
							{editing()?.label}
						</text>
						<box flexGrow={1} />
						<text fg={colors().secondary} attributes={dim()}>
							Esc back
						</text>
					</box>
					<box height={1} />
					<For each={SETTING_OPTIONS[editing()?.key ?? ''] ?? []}>
						{(option, index) => (
							<box
								flexDirection="row"
								height={1}
								backgroundColor={
									optionIndex() === index()
										? colors().info
										: undefined
								}
								{...({
									onMouseUp: () => {
										setOptionIndex(index());
										props.onApply(
											editing()?.key ?? '',
											option,
										);
										setEditing(null);
									},
									onMouseMove: () => setOptionIndex(index()),
								} as any)}
							>
								<text
									fg={
										optionIndex() === index()
											? colors().base
											: colors().text
									}
									attributes={
										optionIndex() === index() ? bold() : undefined
									}
								>
									{optionIndex() === index() ? '❯ ' : '  '}
									{option}
								</text>
							</box>
						)}
					</For>
					<box height={1} />
					<text fg={colors().secondary} attributes={dim()}>
						↑/↓ select · Enter apply · Esc back
					</text>
				</Show>
			</box>
		</box>
	);
}
