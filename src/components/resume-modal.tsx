/** @jsxImportSource @opentui/solid */
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js';
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';

export interface ResumeSession {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	firstMessage: string;
	/** Folder the conversation was created in (legacy sessions may lack it). */
	cwd?: string;
	/** Provider + model the conversation ran on (legacy sessions may lack
	 *  them) — shown in the picker so the original model is visible before
	 *  resuming. */
	provider?: string;
	model?: string;
}

type Row =
	| {kind: 'header'; label: string}
	| {kind: 'session'; session: ResumeSession}
	| {kind: 'spacer'}
	| {kind: 'empty'};

/**
 * Resume-row title: `session_id: conversation_name`, or just the session id
 * when the name is missing or still the default "New conversation" (pure,
 * unit-tested).
 */
export function sessionLabel(session: ResumeSession): string {
	const name = (session.name ?? '').trim();
	if (!name || name === 'New conversation') return session.id;
	return `${session.id}: ${name}`;
}

/**
 * Whether a session belongs in the /resume list. By default only the
 * CURRENT folder's conversations show; Ctrl+A toggles to ALL. Legacy
 * sessions without a recorded cwd are always shown (they predate the
 * filter and hiding them would silently drop conversations). Pure,
 * unit-tested.
 */
export function sessionInFolder(
	session: ResumeSession,
	cwd: string,
	showAll: boolean,
): boolean {
	return showAll || !session.cwd || session.cwd === cwd;
}

/**
 * Whether a session matches the `/resume` search: matches the SESSION ID
 * (so you can search `sess_…`), the conversation name, or the last prompt.
 * Case-insensitive; an empty query matches everything. Pure, unit-tested.
 */
export function sessionMatchesQuery(
	session: ResumeSession,
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return (
		(session.id ?? '').toLowerCase().includes(q) ||
		(session.name ?? '').toLowerCase().includes(q) ||
		(session.firstMessage ?? '').toLowerCase().includes(q)
	);
}

function dateGroup(createdAt: number): string {
	const now = new Date();
	const date = new Date(createdAt);
	const startOfDay = (d: Date): number =>
		new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const dayDiff = Math.round(
		(startOfDay(now) - startOfDay(date)) / 86_400_000,
	);
	if (dayDiff <= 0) return 'Today';
	if (dayDiff === 1) return 'Yesterday';
	if (dayDiff < 7) return 'This week';
	if (dayDiff < 30) return 'This month';
	return 'Older';
}

/** Relative "time since last convo" label (parity: the reference picker). */
function relativeTime(ts: number): string {
	const diff = Math.max(0, Date.now() - ts);
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	const weeks = Math.floor(days / 7);
	if (weeks < 5) return `${weeks}w ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

/**
 * `/resume` MODAL (parity: the reference session picker), sessions grouped
 * under date headers (Today / Yesterday / This week / …), ↑/↓ + Enter to
 * resume, Esc closes, rows are mouse-clickable.
 */
export function ResumeModal(props: {
	cwd: string;
	sessions: ResumeSession[];
	onResume: (id: string) => void;
	onClose: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const [rowIndex, setRowIndex] = createSignal(0);
	// AUTO-CLOSE GUARD: modals opened by a row click receive the SAME
	// click's mouse-UP on the backdrop, which would close them instantly.
	// Only that opening release is ignored — a time window, NOT a one-shot
	// boolean (the flag got consumed by the opening release and swallowed
	// the user's first real outside click: click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	const [query, setQuery] = createSignal('');
	// Ctrl+A toggles between the CURRENT FOLDER's conversations (default)
	// and ALL saved conversations.
	const [showAll, setShowAll] = createSignal(false);
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	// Active-row palette: info tint + guaranteed-readable foreground.
	const activeRow = () => activeRowPalette(colors());
	const cardWidth = () => Math.min(72, Math.max(52, dims().width - 6));
	// Bound the card to the screen and CENTER it vertically (the previous
	// quarter-height placement overflowed on short terminals).
	const cardHeight = () => {
		const available = Math.max(8, dims().height - 2);
		return Math.min(26, available);
	};
	const cardY = () => Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const listVisible = () => Math.max(3, cardHeight() - 10);

	// Lazy + memoized row building: dedupe duplicate session ids (same
	// session saved under several files), cap pathological lists, and only
	// re-sort/regroup when the query or session set actually changes, not on
	// every arrow key (previously each keypress rebuilt the whole list 2×).
	const allRows = createMemo(() => {
		const q = query().trim().toLowerCase();
		const seen = new Set<string>();
		const filtered = [...props.sessions]
			.sort(
				(a, b) =>
					(b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
			)
			.filter(session => {
				// Defensive dedupe (listSessions already dedupes by id).
				if (session.id === '' || seen.has(session.id)) return false;
				seen.add(session.id);
				return (
					sessionMatchesQuery(session, q) &&
					sessionInFolder(session, props.cwd, showAll())
				);
			})
			.slice(0, 500);
		const groups: Row[] = [];
		let lastGroup = '';
		filtered.forEach((session, index) => {
			const group = dateGroup(session.updatedAt ?? session.createdAt);
			if (group !== lastGroup) {
				// A blank line BETWEEN groups (before every header except the
				// first) AND after each header, parity with the expected
				// resume layout (header, blank, sessions, blank, header…).
				if (index > 0) groups.push({kind: 'spacer'});
				groups.push({kind: 'header', label: group});
				groups.push({kind: 'spacer'});
				lastGroup = group;
			}
			groups.push({kind: 'session', session});
		});
		if (groups.length === 0) groups.push({kind: 'empty'});
		return groups;
	});

	const items = createMemo(() =>
		allRows().map((row, index) => ({
			row,
			active: rowIndex() === index,
		})),
	);
	const visibleItems = () => {
		const all = items();
		const budget = Math.max(1, listVisible());
		// Sessions occupy TWO lines (reason + title); headers/spacers one.
		// The window is sliced by LINE budget so a 2-line row can never
		// overflow the card and overlap the next row.
		const lineCount = (row: Row): number =>
			row.kind === 'session' &&
			(row.session.firstMessage ?? '').trim()
				? 2
				: 1;
		const sel = Math.min(Math.max(0, rowIndex()), all.length - 1);
		let start = sel;
		let used = 0;
		const half = Math.floor(budget / 2);
		while (start > 0 && used + lineCount(all[start]!.row) <= half) {
			used += lineCount(all[start]!.row);
			start--;
		}
		const out: typeof all = [];
		let lines = 0;
		for (
			let i = start;
			i < all.length && lines + lineCount(all[i]!.row) <= budget;
			i++
		) {
			out.push(all[i]!);
			lines += lineCount(all[i]!.row);
		}
		return out;
	};
	const moveRow = (delta: number): void => {
		const rows = allRows();
		if (rows.length === 0) return;
		let next = rowIndex() + delta;
		while (
			rows[next]?.kind === 'header' ||
			rows[next]?.kind === 'spacer'
		) {
			next += delta;
		}
		if (next < 0 || next >= rows.length) return;
		setRowIndex(next);
	};
	// Snap the initial selection to the first SESSION row (never a header or
	// spacer) and re-snap after a query change.
	createEffect(() => {
		const rows = allRows();
		if (rows[rowIndex()]?.kind === 'session') return;
		const first = rows.findIndex(row => row.kind === 'session');
		if (first !== -1 && rowIndex() !== first) setRowIndex(first);
	});

	useKeyboard(event => {
		// Same modal isolation as every other modal: the global handlers in
		// App/History/InputBox already preventDefault while the modal is
		// open; this keeps the history scrollbox from acting on modal keys.
		event.preventDefault();
		if (event.name === 'escape') {
			props.onClose();
			return;
		}
		// Ctrl+A toggles the scope: current FOLDER (default) vs ALL saved
		// conversations. A plain "a" still types into the search box.
		if (event.name === 'a' && event.ctrl) {
			setShowAll(prev => !prev);
			setRowIndex(0);
			return;
		}
		if (event.name === 'up' || event.name === 'down') {
			moveRow(event.name === 'down' ? 1 : -1);
			return;
		}
		if (event.name === 'return') {
			const row = items()[rowIndex()]?.row;
			if (row?.kind === 'session') props.onResume(row.session.id);
			return;
		}
		if (event.name === 'backspace') {
			setQuery(prev => prev.slice(0, -1));
			return;
		}
		if (event.name === 'space' && !event.ctrl && !event.meta) {
			setQuery(prev => prev + ' ');
			setRowIndex(0);
			return;
		}
		const char = event.name;
		if (char && char.length === 1 && !event.ctrl && !event.meta) {
			setQuery(prev => prev + char);
			setRowIndex(0);
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
				paddingY={2}
			>
				<box flexDirection="row" height={1}>
					<text fg={colors().primary} attributes={bold()}>
						Resume session
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Esc close
					</text>
				</box>
				<box height={1} />
				{/* opencode-style title spacing: a comfortable gap before the
				    search field. */}
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
				{/* SCOPE indicator: current folder by default, Ctrl+A toggles
				    to ALL conversations. */}
				<Show
					when={!showAll()}
					fallback={
						<text fg={colors().secondary} attributes={dim()}>
							Showing all conversations · Ctrl+A: this folder
						</text>
					}
				>
					<text fg={colors().secondary} attributes={dim()}>
						Showing conversations in {props.cwd} · Ctrl+A: all
					</text>
				</Show>
				<box height={1} />
				<For each={visibleItems()}>
					{(item) => {
						const row = item.row;
						if (row.kind === 'empty') {
							return (
								<text fg={colors().secondary} attributes={dim()}>
									No sessions match "{query()}"
								</text>
							);
						}
						if (row.kind === 'header') {
							return (
								<box flexDirection="row" height={1}>
									<text fg={colors().primary} attributes={bold()}>
										{'  '}
										{row.label}
									</text>
								</box>
							);
						}
						if (row.kind === 'spacer') {
							return <box height={1} />;
						}
						const reason = (row.session.firstMessage ?? '').trim();
						return (
							<box
								flexDirection="column"
								height={reason ? 2 : 1}
								backgroundColor={
									item.active ? activeRow().bg : undefined
								}
								{...({
									onMouseUp: () =>
										props.onResume(row.session.id),
									onMouseMove: () =>
										setRowIndex(
											allRows().findIndex(
												r =>
													r.kind === 'session' &&
													r.session.id === row.session.id,
											),
										),
								} as any)}
							>
								{/* TITLE line: `session_id: conversation_name`
								    (name omitted when still the default "New
								    conversation") + flexGrow + "how long
								    ago" on ONE row. */}
								<box flexDirection="row">
									<text
										fg={
											item.active
												? activeRow().fg
												: colors().text
										}
										attributes={
											item.active ? bold() : undefined
										}
									>
										{item.active ? '❯ ' : '  '}
										{sessionLabel(row.session).slice(0, 48)}
									</text>
									<Show when={row.session.model}>
										<text
											fg={
												item.active
													? activeRow().fg
													: colors().secondary
											}
											attributes={dim()}
										>
											{' · '}
											{row.session.model}
											{row.session.provider
												? ` · ${row.session.provider}`
												: ''}
										</text>
									</Show>
									<box flexGrow={1} />
									<text
										fg={
											item.active
												? activeRow().fg
												: colors().secondary
										}
										attributes={
											item.active ? bold() : dim()
										}
									>
										{relativeTime(
											row.session.updatedAt ??
												row.session.createdAt,
										)}
									</text>
								</box>
								{/* The LAST PROMPT sits BELOW the title with a
								    ` └ ` branch, secondary (dimmed) — same
								    color rule as the other optional lines. */}
								{reason ? (
									<text
										fg={
											item.active
												? activeRow().fg
												: colors().secondary
										}
										attributes={
											item.active ? bold() : dim()
										}
									>
										{' └ '}
										{reason.slice(0, 44)}
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
					↑/↓ select · Enter resume · Ctrl+A {showAll() ? 'folder' : 'all'} · Esc close
				</text>
			</box>
		</box>
	);
}
