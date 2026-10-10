import {createSignal} from 'solid-js';
import type {ChatMessage} from './state';

export const HISTORY_WINDOW_ROWS = 300;
export const HISTORY_WINDOW_BYTES = 512 * 1024;
export const HISTORY_PAGE_ROWS = 60;
export interface HistoryPage {
	rows: ChatMessage[];
	hasOlder: boolean;
	hasNewer: boolean;
}
export interface HistoryPageRequest {
	beforeId?: string;
	afterId?: string;
	limit: number;
	maxBytes: number;
}

/** Keep a contiguous bounded window, evicting only the opposite boundary. */
export function boundHistoryWindow(
	rows: ChatMessage[],
	direction: 'older' | 'newer',
) {
	const unique = [
		...new Map(rows.map(row => [row.transcriptId ?? row, row])).values(),
	];
	const ordered = direction === 'older' ? unique : unique.slice().reverse();
	let bytes = 0;
	const kept: ChatMessage[] = [];
	for (const row of ordered) {
		const originalSize = Buffer.byteLength(JSON.stringify(row));
		const visible: ChatMessage =
			originalSize > HISTORY_WINDOW_BYTES
				? {
						transcriptId: row.transcriptId,
						role: 'assistant',
						kind: 'info',
						content:
							'Oversized transcript row · original retained in session/archive; continue scrolling for adjacent rows.',
					}
				: row;
		const size = Buffer.byteLength(JSON.stringify(visible));
		if (
			kept.length === HISTORY_WINDOW_ROWS ||
			bytes + size > HISTORY_WINDOW_BYTES
		)
			break;
		bytes += size;
		kept.push(visible);
	}
	return direction === 'older' ? kept : kept.reverse();
}

/** Archive rows never enter active messages or provider history. */
export function createHistoryArchiveController(options: {
	owner: () => string;
	session: () => string;
	active: () => ChatMessage[];
	read: (session: string, request: HistoryPageRequest) => Promise<HistoryPage>;
}) {
	const [rows, setRows] = createSignal<ChatMessage[] | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal('');
	let generation = 0;
	let older = true;
	let newer = false;
	let snapshot: ChatMessage[] = [];
	const reset = () => {
		generation++;
		setRows(null);
		setLoading(false);
		setError('');
		older = true;
		newer = false;
		snapshot = [];
	};
	const load = async (direction: 'older' | 'newer') => {
		if (loading()) return false;
		if (direction === 'newer' && !rows()) return false;
		if (direction === 'older' && !older) return false;
		if (direction === 'newer' && !newer) {
			reset();
			return true;
		}
		const owner = options.owner();
		const token = generation;
		// Retain the existing state array by reference, not a second unbounded copy.
		// Failed archival may leave more than one viewport in active state.
		if (!rows()) snapshot = options.active();
		const current = rows() ?? boundHistoryWindow(snapshot, 'newer');
		setLoading(true);
		setError('');
		try {
			const edge = direction === 'older' ? current[0] : current.at(-1);
			const snapshotIndex = snapshot.findIndex(
				row => row.transcriptId === edge?.transcriptId,
			);
			let page: HistoryPage;
			if (snapshotIndex >= 0 && direction === 'newer') {
				const end = snapshotIndex + 1 + HISTORY_PAGE_ROWS;
				page = {
					rows: snapshot.slice(snapshotIndex + 1, end),
					hasOlder: true,
					hasNewer: end < snapshot.length,
				};
			} else if (snapshotIndex > 0 && direction === 'older') {
				const start = Math.max(0, snapshotIndex - HISTORY_PAGE_ROWS);
				page = {
					rows: snapshot.slice(start, snapshotIndex),
					hasOlder: true,
					hasNewer: true,
				};
			} else {
				page = await options.read(options.session(), {
					...(direction === 'older'
						? {beforeId: edge?.transcriptId}
						: {afterId: edge?.transcriptId}),
					limit: HISTORY_PAGE_ROWS,
					maxBytes: HISTORY_WINDOW_BYTES / 4,
				});
				if (direction === 'newer' && !page.hasNewer) {
					page = {
						...page,
						rows: [
							...page.rows,
							...snapshot.slice(0, HISTORY_PAGE_ROWS - page.rows.length),
						],
						hasNewer: snapshot.length > HISTORY_PAGE_ROWS - page.rows.length,
					};
				}
			}
			if (token !== generation || owner !== options.owner()) return false;
			if (!page.rows.length) {
				if (direction === 'older') older = false;
				else reset();
				return false;
			}
			const combined =
				direction === 'older'
					? [...page.rows, ...current]
					: [...current, ...page.rows];
			const bounded = boundHistoryWindow(combined, direction);
			if (direction === 'older') {
				older = page.hasOlder;
				newer =
					newer ||
					bounded.at(-1)?.transcriptId !== current.at(-1)?.transcriptId;
			} else {
				newer = page.hasNewer;
				older = older || bounded[0]?.transcriptId !== current[0]?.transcriptId;
			}
			setRows(bounded);
			return true;
		} catch (cause) {
			if (token === generation && owner === options.owner())
				setError(
					`Could not load earlier transcript: ${cause instanceof Error ? cause.message : String(cause)}. Scroll again to retry.`,
				);
			return false;
		} finally {
			if (token === generation && owner === options.owner()) setLoading(false);
		}
	};
	return {rows, loading, error, load, reset};
}
