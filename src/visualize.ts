/**
 * Built-in VISUALIZATION helpers for the agent tools. Tool output renders in
 * the transcript as text under the `  └   ` container, so the charts are
 * ASCII — readable, font-proof, and consistent with the rest of the TUI.
 * Pure functions, unit-tested.
 */

export interface VizPoint {
	label: string;
	value: number;
}

/** Parse a tool `data` argument: JSON array or simple `label,value` lines. */
export function parseVizData(
	data: unknown,
): VizPoint[] {
	if (typeof data === 'string') {
		const trimmed = data.trim();
		if (trimmed) {
			try {
				const parsed = JSON.parse(trimmed);
				return parseVizData(parsed);
			} catch {
				// fall through to CSV-style lines
			}
		}
		return trimmed
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => {
				const [label, value] = line.split(/[,\t]/).map(part => part.trim());
				const n = Number(value);
				return {label: label ?? '', value: Number.isFinite(n) ? n : 0};
			})
			.filter(point => point.label !== '');
	}
	if (Array.isArray(data)) {
		return data
			.map(item => {
				if (typeof item === 'number') return {label: String(item), value: item};
				if (typeof item === 'string') return {label: item, value: 0};
				if (item && typeof item === 'object') {
					const record = item as Record<string, unknown>;
					const label = String(record.label ?? record.name ?? record.key ?? '');
					const value = Number(record.value ?? record.count ?? record.total ?? 0);
					return {
						label,
						value: Number.isFinite(value) ? value : 0,
					};
				}
				return null;
			})
			.filter((point): point is VizPoint => Boolean(point));
	}
	return [];
}

/**
 * Horizontal bar chart. Renders a scale header, one `label | ███ value` row
 * per point, and a numeric scale footer. Bars scale to the widest label +
 * bar columns so the chart stays inside the terminal.
 */
export function renderBarChart(
	points: VizPoint[],
	title = 'Values',
	barWidth = 24,
): string {
	if (points.length === 0) return 'No data to visualize.';
	const max = Math.max(1, ...points.map(point => Math.abs(point.value)));
	const labelWidth = Math.min(
		24,
		Math.max(...points.map(point => point.label.length)),
	);
	const rows = points.map(point => {
		const bars = Math.max(
			0,
			Math.round((Math.abs(point.value) / max) * barWidth),
		);
		return (
			`${point.label.padEnd(labelWidth)} | ` +
			`${'█'.repeat(bars).padEnd(barWidth)} ${point.value}`
		);
	});
	return `${title}\n${rows.join('\n')}\nscale: 0 … ${max}`;
}

/**
 * Sparkline / line chart for time-series points. Renders a fixed-height
 * (5-row) ASCII line plot with the min/max scale and every label beneath.
 */
export function renderLineChart(
	points: VizPoint[],
	title = 'Trend',
	rows = 5,
): string {
	if (points.length === 0) return 'No data to visualize.';
	if (points.length === 1) return renderBarChart(points, title);
	const min = Math.min(...points.map(point => point.value));
	const max = Math.max(...points.map(point => point.value));
	const span = Math.max(1, max - min);
	const height = Math.max(3, rows);
	const grid: string[][] = Array.from({length: height}, () =>
		Array(points.length).fill(' '),
	);
	points.forEach((point, index) => {
		const row = Math.round(((point.value - min) / span) * (height - 1));
		grid[height - 1 - row]![index] = '●';
	});
	const scale = (row: number): string =>
		String(Math.round(max - (row / (height - 1)) * span)).padStart(6);
	const lines = grid
		.map((row, index) => `${scale(index)} │ ${row.join('')}`)
		.join('\n');
	const labels = points
		.map(point => point.label.slice(0, Math.max(3, Math.floor(40 / points.length))))
		.map(label => label.padEnd(40 / points.length))
		.join('');
	return `${title}\n${lines}\n       └ ${labels}`;
}

/**
 * Table renderer for mixed/status data: array of objects → aligned columns.
 * Useful for background tasks, git stats, file sizes, etc.
 */
export function renderTable(
	rowsData: unknown,
	title = 'Table',
): string {
	if (!Array.isArray(rowsData) || rowsData.length === 0) {
		return 'No data to visualize.';
	}
	const records = rowsData.map(row =>
		row && typeof row === 'object'
			? (Object.fromEntries(
					Object.entries(row as Record<string, unknown>).map(
						([key, value]) => [key, String(value ?? '')],
					),
				) as Record<string, string>)
			: {value: String(row)},
	);
	const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
	const widths = columns.map(column =>
		Math.min(
			32,
			Math.max(
				column.length,
				...records.map(record => (record[column] ?? '').length),
			),
		),
	);
	const header = columns.map((column, index) => column.padEnd(widths[index]!)).join(' | ');
	const separator = widths.map(width => '-'.repeat(width)).join('-+-');
	const rows = records.map(record =>
		columns.map((column, index) => (record[column] ?? '').padEnd(widths[index]!)).join(' | '),
	);
	return `${title}\n${header}\n${separator}\n${rows.join('\n')}`;
}

/**
 * Entry point: pick the renderer from the tool's `kind` argument and parse
 * `data`/`rows` automatically. The agent calls this instead of dumping raw
 * numbers, so the user SEES the shape of the data.
 */
export function renderVisualization(
	kind: string,
	data: unknown,
	title?: string,
	extra?: Record<string, unknown>,
): string {
	const points = parseVizData(data);
	switch (kind) {
		case 'line':
		case 'trend':
		case 'sparkline':
			return renderLineChart(points, title ?? 'Trend');
		case 'table':
			return renderTable(data, title ?? 'Table');
		case 'bar':
		default:
			return renderBarChart(points, title ?? 'Values');
	}
}
