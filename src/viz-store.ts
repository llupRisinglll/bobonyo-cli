/**
 * REAL-TIME visualization store.
 *
 * The `visualize` tool PUBLISHES points through this store as it computes
 * them (via onProgress), and the chart card component SUBSCRIBES by reading
 * the signal in its body — so the card updates in place in the transcript,
 * exactly like the todo task list. When the tool settles, the card freezes
 * at the final dataset.
 */
import {createSignal} from 'solid-js';

export interface VizPoint {
	label: string;
	value: number;
	/** Optional secondary payload (heat/status views: suite → status). */
	status?: string;
}

export interface VizData {
	title: string;
	kind: string;
	points: VizPoint[];
}

/** Chart data keyed by tool-call id (each `visualize` call = one card). */
export const [vizData, setVizData] = createSignal<Record<string, VizData>>({});

export function publishViz(
	toolId: string,
	title: string,
	kind: string,
	points: VizPoint[],
): void {
	setVizData(prev => ({
		...prev,
		[toolId]: {title, kind, points},
	}));
}

export function clearViz(toolId: string): void {
	setVizData(prev => {
		if (!(toolId in prev)) return prev;
		const next = {...prev};
		delete next[toolId];
		return next;
	});
}
