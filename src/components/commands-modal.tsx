/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {
	useKeyboard,
	usePaste,
	useTerminalDimensions,
} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {COMMAND_DESCRIPTIONS, commandNames} from '../commands';
import {loadCustomCommands, loadSkills} from '../custom';
import {wrapDescription} from '../description-wrap';
import {isPreviewTui} from '../preview';

interface CommandEntry {
	name: string;
	kind: 'built-in' | 'custom' | 'skill';
	description: string;
}

/**
 * `/commands` MODAL (parity: the grouped model selector): built-in and
 * custom commands in CATEGORY groups, each row is TWO COLUMNS — the command
 * (`/name`) on the left, the description on the right wrapped up to 2
 * lines. Search filters across both categories; ↑/↓ + Enter inserts the
 * selected command into the input; Esc closes. Responsive: the card uses as
 * much of the terminal height as it can, so more rows are readable without
 * scrolling.
 */
export function CommandsModal(props: {
	onInsert: (text: string) => void;
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const [query, setQuery] = createSignal('');
	usePaste((event: {bytes: Uint8Array}) => {
		setQuery(prev => prev + new TextDecoder().decode(event.bytes));
	});
	// AUTO-CLOSE GUARD: modals opened by a row click receive the SAME
	// click's mouse-UP on the backdrop, which would close them instantly.
	// Only that opening release is ignored — a time window, NOT a one-shot
	// boolean (the flag got consumed by the opening release and swallowed
	// the user's first real outside click: click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	const [index, setIndex] = createSignal(0);

	const cardWidth = () => Math.min(100, Math.max(72, dims().width - 6));
	// RESPONSIVE: use nearly the whole terminal height (headers + search +
	// footer + padding ≈ 7 rows of chrome), capped only by the screen.
	const listVisible = () =>
		Math.max(6, Math.min(60, dims().height - 9));
	// FIT-CONTENT: the card is exactly the command list height + chrome,
	// capped by the window (short lists shrink the card, long ones scroll).
	const contentLines = () =>
		rows().reduce((sum, row) => sum + rowLines(row), 0);
	const cardHeight = () =>
		Math.min(
			dims().height - 2,
			Math.max(10, Math.min(contentLines(), listVisible()) + 7),
		);
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const descWidth = () => Math.max(30, cardWidth() - 34);

	const entries = createMemo<CommandEntry[]>(() => {
		const builtIn: CommandEntry[] = commandNames()
			.filter(name => name !== 'quit')
			.sort()
			.map(name => ({
				name,
				kind: 'built-in',
				description: COMMAND_DESCRIPTIONS[name] ?? 'Run command',
			}));
		const custom: CommandEntry[] = loadCustomCommands().map(command => ({
			name: command.name,
			kind: 'custom',
			description: command.description,
		}));
		const skills: CommandEntry[] = isPreviewTui()
			? []
			: loadSkills().map(skill => ({
					name: `skill:${skill.name}`,
					kind: 'skill',
					description: skill.description,
				}));
		const q = query().trim().toLowerCase();
		const matches = (entry: CommandEntry): boolean =>
			!q ||
			entry.name.toLowerCase().includes(q) ||
			entry.description.toLowerCase().includes(q);
		const filter = (group: CommandEntry[]): CommandEntry[] =>
			group.filter(matches);
		return [...filter(builtIn), ...filter(custom), ...filter(skills)];
	});

	/** Rows with a category HEADER before each group (model-modal style). */
	const rows = createMemo(() => {
		const all = entries();
		const groups: Array<{kind: CommandEntry['kind']; entries: CommandEntry[]}> =
			[
				{kind: 'built-in', entries: all.filter(e => e.kind === 'built-in')},
				{kind: 'custom', entries: all.filter(e => e.kind === 'custom')},
				{kind: 'skill', entries: all.filter(e => e.kind === 'skill')},
			].filter(
				(group): group is {kind: CommandEntry['kind']; entries: CommandEntry[]} =>
					group.entries.length > 0,
			);
		const flat: Array<{
			header?: string;
			entry?: CommandEntry;
			wrapped?: string[];
		}> = [];
		for (const group of groups) {
			flat.push({header: group.kind});
			for (const entry of group.entries) {
				flat.push({entry, wrapped: wrapDescription(entry.description, descWidth())});
			}
		}
		return flat;
	});
	/** Header = 1 line; entry = 1 + (description wrap up to 2 lines). */
	const rowLines = (
		row: {header?: string; entry?: CommandEntry; wrapped?: string[]},
	): number => row.header ? 1 : Math.max(1, Math.min(2, row.wrapped?.length ?? 1));

	const scrollStart = () => {
		// Walk backward from the SELECTED row until the window fits
		// the CARD (headers 1 line, entries 1-2 lines), so the selection is
		// always visible and the window never renders below the card edge.
		const windowBudget = cardHeight() - 7;
		let start = index();
		let lines = 0;
		while (start > 0 && lines < windowBudget) {
			start -= 1;
			const rl = rowLines(rows()[start]!);
			if (lines + rl > windowBudget && start < index()) {
				start += 1;
				break;
			}
			lines += rl;
		}
		return start;
	};

	const visibleRows = createMemo(() => {
		const all = rows();
		const start = scrollStart();
		const out: typeof all = [];
		let lines = 0;
		for (let i = start; i < all.length; i++) {
			const row = all[i]!;
			const rl = rowLines(row);
			if (out.length > 0 && lines + rl > cardHeight() - 7) break;
			out.push(row);
			lines += rl;
		}
		return out;
	});

	useKeyboard(event => {
		if (event.name === 'escape') {
			if (query()) setQuery('');
			else props.onClose();
			return;
		}
		if (event.name === 'up' || event.name === 'down') {
			const count = rows().length;
			setIndex(prev =>
				event.name === 'down'
					? Math.min(Math.max(0, count - 1), prev + 1)
					: Math.max(0, prev - 1),
			);
			return;
		}
		if (event.name === 'return') {
			const row = rows()[index()];
			if (row?.entry) {
				props.onInsert(`/${row.entry.name} `);
			}
			return;
		}
		if (isDeleteKey(event)) {
			setQuery(prev => prev.slice(0, -1));
			setIndex(0);
			return;
		}
		if (event.name === 'space' && !event.ctrl && !event.meta) {
			setQuery(prev => prev + ' ');
			setIndex(0);
			return;
		}
		const char = event.name;
		if (char && char.length === 1 && !event.ctrl && !event.meta) {
			setQuery(prev => prev + char);
			setIndex(0);
		}
	});

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
				backgroundColor={colors().base}
				paddingX={2}
				paddingY={1}
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						Commands
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						{entries().length} commands · ↑/↓ + Enter insert · Esc close
					</text>
				</box>
				<box height={1} />
				<box height={1}>
					<text fg={colors().secondary} attributes={dim()}>
						⌕ {query() || 'search…'}
					</text>
				</box>
				<box height={1} />
				<For each={visibleRows()}>
					{(row, i) => {
						const rowIndex = i() + scrollStart();
						return row.header ? (
							<box height={1} paddingLeft={1}>
								<text fg={colors().secondary} attributes={bold()}>
									{row.header === 'built-in'
										? 'Built-in'
										: row.header === 'skill'
											? 'Skills'
											: 'Custom'}
								</text>
							</box>
						) : (
							<box
								flexDirection="column"
								height={rowLines(row)}
								backgroundColor={
									rowIndex === index()
										? activeRow().bg
										: undefined
								}
								{...({
									onMouseMove: () => setIndex(rowIndex),
									onMouseUp: () =>
										props.onInsert(`/${row.entry!.name} `),
								} as any)}
							>
								<box flexDirection="row" height={1}>
									<text
										width={2}
										fg={
											rowIndex === index()
												? activeRow().fg
												: colors().secondary
										}
									>
										{rowIndex === index() ? '❯ ' : '  '}
									</text>
									<text
										width={30}
										fg={
											rowIndex === index()
												? activeRow().fg
												: colors().text
										}
										attributes={bold()}
									>
										/{row.entry!.name}
									</text>
									<text
										fg={
											rowIndex === index()
												? activeRow().fg
												: colors().secondary
										}
										attributes={dim()}
									>
										{row.wrapped?.[0] ?? ''}
									</text>
								</box>
								<Show when={(row.wrapped?.length ?? 1) > 1}>
									<text
										fg={
											rowIndex === index()
												? activeRow().fg
												: colors().secondary
										}
										attributes={dim()}
									>
										{' '.repeat(32)}
										{row.wrapped?.[1] ?? ''}
									</text>
								</Show>
							</box>
						);
					}}
				</For>
				<Show when={entries().length === 0}>
					<text fg={colors().secondary} attributes={dim()}>
						No commands match.
					</text>
				</Show>
			</box>
		</box>
	);
}
