export interface ResolvedDisplayChunk {
	start: number;
	oldLines: string[];
	newLines: string[];
}

export const PATCH_CONTEXT_LINES = 3;

/** Merge overlapping file-context windows before computing display diffs. */
export function patchContextWindows(
	source: string[],
	chunks: ResolvedDisplayChunk[],
) {
	const windows: Array<{
		start: number;
		end: number;
		chunks: ResolvedDisplayChunk[];
	}> = [];
	// Patch application splices from the end. Equal-position insertions thus
	// appear in reverse patch order in the final file.
	const ordered = chunks
		.map((chunk, index) => ({chunk, index}))
		.sort((a, b) => a.chunk.start - b.chunk.start || b.index - a.index);
	for (const {chunk} of ordered) {
		const start = Math.max(0, chunk.start - PATCH_CONTEXT_LINES);
		const end = Math.min(
			source.length,
			chunk.start + chunk.oldLines.length + PATCH_CONTEXT_LINES,
		);
		const previous = windows.at(-1);
		if (previous && start <= previous.end) {
			previous.end = Math.max(previous.end, end);
			previous.chunks.push(chunk);
		} else windows.push({start, end, chunks: [chunk]});
	}
	let delta = 0;
	return windows.map(window => {
		const newLines: string[] = [];
		let cursor = window.start;
		for (const chunk of window.chunks) {
			newLines.push(...source.slice(cursor, chunk.start), ...chunk.newLines);
			cursor = chunk.start + chunk.oldLines.length;
		}
		newLines.push(...source.slice(cursor, window.end));
		const result = {
			oldLines: source.slice(window.start, window.end),
			newLines,
			oldStart: window.start + 1,
			newStart: window.start + 1 + delta,
		};
		delta += newLines.length - result.oldLines.length;
		return result;
	});
}

/** Retain bounded context around actual changes, not around patch anchors. */
export function boundedPatchRows<T extends {kind: string}>(rows: T[]) {
	const visible = new Set<number>();
	for (let index = 0; index < rows.length; index++) {
		if (rows[index]!.kind === 'context') continue;
		for (
			let neighbor = Math.max(0, index - PATCH_CONTEXT_LINES);
			neighbor <= Math.min(rows.length - 1, index + PATCH_CONTEXT_LINES);
			neighbor++
		)
			visible.add(neighbor);
	}
	let previous = -1;
	return [...visible]
		.sort((a, b) => a - b)
		.map(index => {
			const row = rows[index]!;
			const result =
				previous >= 0 && index > previous + 1 ? {...row, gapBefore: true} : row;
			previous = index;
			return result;
		});
}
