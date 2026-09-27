export interface DiffLine {
	kind: 'context' | 'remove' | 'add';
	oldLineNo?: number;
	newLineNo?: number;
	text: string;
}
/** LCS-based line diff with old/new line numbers (parity: DiffView). */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
	const oldLines = oldStr === '' ? [] : oldStr.replace(/\n+$/, '').split('\n');
	const newLines = newStr === '' ? [] : newStr.replace(/\n+$/, '').split('\n');
	const n = oldLines.length;
	const m = newLines.length;
	const dp: number[][] = Array.from({length: n + 1}, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i]![j] =
				oldLines[i] === newLines[j]
					? (dp[i + 1]![j + 1] ?? 0) + 1
					: Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
		}
	}
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;
	let oldNo = 1;
	let newNo = 1;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			result.push({
				kind: 'context',
				oldLineNo: oldNo++,
				newLineNo: newNo++,
				text: oldLines[i] ?? '',
			});
			i++;
			j++;
		} else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
			result.push({
				kind: 'remove',
				oldLineNo: oldNo++,
				text: oldLines[i] ?? '',
			});
			i++;
		} else {
			result.push({kind: 'add', newLineNo: newNo++, text: newLines[j] ?? ''});
			j++;
		}
	}
	while (i < n) {
		result.push({kind: 'remove', oldLineNo: oldNo++, text: oldLines[i] ?? ''});
		i++;
	}
	while (j < m) {
		result.push({kind: 'add', newLineNo: newNo++, text: newLines[j] ?? ''});
		j++;
	}
	return result;
}
