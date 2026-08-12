/** @jsxImportSource @opentui/solid */
import {createTextAttributes} from '@opentui/core';
import {For, Show} from 'solid-js';
import {colors} from '../theme';
import type {VizPoint} from '../viz-store';
import {vizData} from '../viz-store';

/**
 * Parse streamed chart lines into points. Accepts:
 *   `label:value`            — bar/line points
 *   `label:value:status`     — heat/status cells (status = pass/fail/…)
 *   `label:value:timestamp`  — time-series points (label = time)
 */
export function parseChartPoints(text: string | undefined): VizPoint[] {
	if (!text) return [];
	return text
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => {
			const parts = line.split(':');
			if (parts.length < 2) return null;
			const label = parts[0]!.trim();
			const value = Number(parts[1]!.trim());
			if (!label || !Number.isFinite(value)) return null;
			return {
				label,
				value,
				...(parts[2] ? {status: parts.slice(2).join(':').trim()} : {}),
			};
		})
		.filter((point): point is VizPoint => Boolean(point));
}

/**
 * HORIZONTAL BAR chart (ntcharts-style): labels column + axis + proportional
 * bars + value labels. Real-time: bars grow as points stream in.
 */
export function ChartBar(props: {
	title: string;
	points: VizPoint[];
	running?: boolean;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	// EMPTY-STATE GUARD: with no points (the card mounts before the first
	// publish) `Math.max(1, ...[])` = 1 would make every later bar render at
	// 100% width until the true max arrives. Track a minimum max so the
	// first bar is proportional to the first value instead of full-width.
	const max = Math.max(
		1,
		...props.points.map(point => Math.abs(point.value)),
	);
	const barWidth = 34;
	return (
		<box flexDirection="column">
			<box flexDirection="row">
				<text fg={colors().primary} attributes={bold()}>
					{props.title}
				</text>
				<Show when={props.running}>
					<text fg={colors().secondary} attributes={dim()}>
						{'  '}● live
					</text>
				</Show>
			</box>
			<Show when={props.points.length > 0} fallback={
				<text fg={colors().secondary} attributes={dim()}>
					waiting for data…
				</text>
			}>
			<For each={props.points}>
				{(point) => {
					const barW = Math.round(
						(Math.abs(point.value) / max) * barWidth,
					);
					return (
					<box flexDirection="row" height={1}>
						<text
							width={22}
							fg={colors().text}
							attributes={bold()}
						>
							{point.label.slice(0, 20)}
						</text>
						<text fg={colors().secondary}>│</text>
						<box
							width={Math.max(1, barW)}
							backgroundColor={colors().primary}
						>
							<text fg={colors().base}>
								{' '.repeat(
									Math.max(1, barW),
								)}
							</text>
						</box>
						<text fg={colors().secondary} attributes={dim()}>
							{' '}{Math.round(point.value)}
						</text>
					</box>
					);
				}}
			</For>
			</Show>
			<text fg={colors().secondary} attributes={dim()}>
				{' '.repeat(23)}└ scale: 0 … {Math.round(max)}
			</text>
		</box>
	);
}

/**
 * STREAMING LINE chart (ntcharts streamline-style): keeps a rolling window
 * of the latest points and draws a fixed-height plot; new points slide in
 * from the right while streaming.
 */
export function ChartLine(props: {
	title: string;
	points: VizPoint[];
	running?: boolean;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const rows = 5;
	const window = Math.max(8, props.points.length);
	const visible = props.points.slice(-window);
	const min = Math.min(0, ...visible.map(point => point.value));
	const max = Math.max(1, ...visible.map(point => point.value));
	const span = Math.max(1, max - min);
	const grid: string[][] = Array.from({length: rows}, () =>
		Array(visible.length).fill(' '),
	);
	visible.forEach((point, index) => {
		const row = Math.round(((point.value - min) / span) * (rows - 1));
		grid[rows - 1 - row]![index] = '●';
	});
	const scale = (row: number): string =>
		String(Math.round(max - (row / (rows - 1)) * span)).padStart(4);
	return (
		<box flexDirection="column">
			<box flexDirection="row">
				<text fg={colors().primary} attributes={bold()}>
					{props.title}
				</text>
				<Show when={props.running}>
					<text fg={colors().secondary} attributes={dim()}>
						{' '}… live
					</text>
				</Show>
			</box>
			<For each={grid}>
				{(row, index) => (
					<box flexDirection="row" height={1}>
						<text fg={colors().secondary} attributes={dim()}>
							{scale(index())} ┤
						</text>
						<text fg={colors().primary}>{row.join('')}</text>
					</box>
				)}
			</For>
			<text fg={colors().secondary} attributes={dim()}>
				{'      └ '}
				{visible.map(point => point.label).join('  ')}
			</text>
		</box>
	);
}

/**
 * COMPACT SPARKLINE: one dense row of columns (ntcharts sparkline), great
 * for "pass rate over time" in CI.
 */
export function ChartSpark(props: {
	title: string;
	points: VizPoint[];
	running?: boolean;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const max = Math.max(1, ...props.points.map(point => Math.abs(point.value)));
	return (
		<box flexDirection="column">
			<box flexDirection="row">
				<text fg={colors().primary} attributes={bold()}>
					{props.title}
				</text>
				<Show when={props.running}>
					<text fg={colors().secondary} attributes={dim()}>
						{'  '}● live
					</text>
				</Show>
			</box>
			<box flexDirection="row">
				<For each={props.points.slice(-40)}>
					{(point) => (
						<text
							fg={
								point.status === 'pass'
									? colors().success
									: point.status === 'fail'
										? colors().error
										: colors().primary
							}
						>
							{Math.round((Math.abs(point.value) / max) * 4) >= 1
								? '█'
								: '▁'}
						</text>
					)}
				</For>
			</box>
			<text fg={colors().secondary} attributes={dim()}>
				{props.points[props.points.length - 1]?.label ?? ''}
			</text>
		</box>
	);
}

/**
 * HEAT/STATUS card (ntcharts heatmap-inspired): each point is a ROW (test
 * suite / CI job) with a color-coded status cell that updates LIVE — green
 * pass, red fail, yellow running. The e2e/CI answer to "how many passed /
 * what failed" without flooding the chat.
 */
export function ChartHeat(props: {
	title: string;
	points: VizPoint[];
	running?: boolean;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const statusFg = (status: string | undefined): string => {
		if (status === 'pass' || status === 'passed') return colors().success;
		if (status === 'fail' || status === 'failed') return colors().error;
		if (status === 'run' || status === 'running') return colors().warning;
		return colors().secondary;
	};
	const statusLabel = (status: string | undefined): string => {
		if (status === 'pass' || status === 'passed') return '✓ pass';
		if (status === 'fail' || status === 'failed') return '✗ fail';
		if (status === 'run' || status === 'running') return '◐ run';
		return status ?? '—';
	};
	const passed = props.points.filter(p => p.status === 'pass' || p.status === 'passed').length;
	const failed = props.points.filter(p => p.status === 'fail' || p.status === 'failed').length;
	const running = props.points.filter(p => p.status === 'run' || p.status === 'running').length;
	return (
		<box flexDirection="column">
			<box flexDirection="row">
				<text fg={colors().primary} attributes={bold()}>
					{props.title}
				</text>
				<Show when={props.running}>
					<text fg={colors().secondary} attributes={dim()}>
						{'  '}● live
					</text>
				</Show>
			</box>
			<For each={props.points}>
				{(point) => (
					<box flexDirection="row" height={1}>
						<text width={26} fg={colors().text}>
							{point.label.slice(0, 24)}
						</text>
						<text fg={statusFg(point.status)} attributes={bold()}>
							{statusLabel(point.status)}
						</text>
						<Show when={point.value !== 0}>
							<text fg={colors().secondary} attributes={dim()}>
								{' '}{Math.round(point.value)}ms
							</text>
						</Show>
					</box>
				)}
			</For>
			<Show when={props.points.length > 0}>
				<text fg={colors().secondary} attributes={dim()}>
					{passed} passed · {failed} failed · {running} running ·{' '}
					{props.points.length} total
				</text>
			</Show>
		</box>
	);
}

/**
 * DASHBOARD-STYLE chart card rendered in the chat transcript. Reads the
 * tool's PUBLISHED points through the store accessor (a signal read in the
 * component body), so the card UPDATES IN PLACE while the tool streams —
 * like the todo task list — and freezes when the tool settles.
 */
export function VizCard(props: {
	toolId: string;
	title: string;
	kind: string;
	running?: boolean;
}) {
	// Read the store signal DIRECTLY in the component body so OpenTUI's
	// reconciler tracks the dependency and re-renders the card IN PLACE as
	// the tool publishes points (a prop-function indirection was invisible
	// to the reconciler — the card only re-rendered on mount/settle).
	// NOTE: vizData() is read HERE (not inside a memo) so the reconciler
	// subscribes this component to the store signal.
	// Read the store DIRECTLY in the render body (the spinner pattern: a
	// signal read in the JSX path is what the reconciler tracks).
	const chartPoints = vizData()[props.toolId]?.points ?? [];
	return (
		<box flexDirection="column" paddingX={1} paddingY={1}>
			{props.kind === 'line' ? (
				<ChartLine
					title={props.title}
					points={chartPoints}
					running={props.running}
				/>
			) : props.kind === 'spark' || props.kind === 'sparkline' ? (
				<ChartSpark
					title={props.title}
					points={chartPoints}
					running={props.running}
				/>
			) : props.kind === 'heat' || props.kind === 'status' ? (
				<ChartHeat
					title={props.title}
					points={chartPoints}
					running={props.running}
				/>
			) : (
				<ChartBar
					title={props.title}
					points={chartPoints}
					running={props.running}
				/>
			)}
		</box>
	);
}
