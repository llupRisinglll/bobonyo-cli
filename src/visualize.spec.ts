import {describe, expect, test} from 'bun:test';
import {
	parseVizData,
	renderBarChart,
	renderLineChart,
	renderTable,
	renderVisualization,
} from './visualize';

describe('parseVizData', () => {
	test('JSON array of numbers', () => {
		expect(parseVizData([1, 2, 3])).toEqual([
			{label: '1', value: 1},
			{label: '2', value: 2},
			{label: '3', value: 3},
		]);
	});

	test('JSON array of {label,value} objects', () => {
		expect(
			parseVizData([
				{label: 'bash', value: 4},
				{name: 'read', count: 2},
			]),
		).toEqual([
			{label: 'bash', value: 4},
			{label: 'read', value: 2},
		]);
	});

	test('CSV-style lines label,value', () => {
		expect(parseVizData('bash,4\nread,2')).toEqual([
			{label: 'bash', value: 4},
			{label: 'read', value: 2},
		]);
	});

	test('JSON string input parses too', () => {
		expect(parseVizData('[5,10]')).toEqual([
			{label: '5', value: 5},
			{label: '10', value: 10},
		]);
	});

	test('garbage returns empty', () => {
		expect(parseVizData('')).toEqual([]);
		expect(parseVizData(42)).toEqual([]);
	});
});

describe('renderBarChart', () => {
	test('scales bars and shows the value column', () => {
		const chart = renderBarChart(
			[
				{label: 'bash', value: 10},
				{label: 'read', value: 5},
			],
			'Tool calls',
		);
		expect(chart).toContain('✦ Tool calls');
		expect(chart).toContain('bash');
		expect(chart).toContain('10');
		expect(chart).toContain('scale: 0 … 10');
	});

	test('empty data is handled', () => {
		expect(renderBarChart([], 'x')).toBe('No data to visualize.');
	});
});

describe('renderLineChart', () => {
	test('renders a 5-row plot with labels', () => {
		const chart = renderLineChart(
			[1, 2, 3, 2, 4].map((value, index) => ({label: `t${index}`, value})),
			'Progress',
		);
		expect(chart).toContain('✦ Progress');
		expect(chart.split('\n').length).toBeGreaterThanOrEqual(7);
		expect(chart).toContain('t0');
		expect(chart).toContain('●');
	});
});

describe('renderTable', () => {
	test('aligns object columns', () => {
		const table = renderTable(
			[
				{id: 'bg_1', status: 'running'},
				{id: 'bg_2', status: 'exit 0'},
			],
			'Background tasks',
		);
		expect(table).toContain('✦ Background tasks');
		expect(table).toContain('bg_1');
		expect(table).toContain('running');
		expect(table).toContain('exit 0');
	});
});

describe('renderVisualization dispatcher', () => {
	test('kind bar/line/table route correctly', () => {
		expect(renderVisualization('bar', [1, 2], 'A')).toContain('✦ A');
		expect(renderVisualization('line', [1, 2, 3], 'B')).toContain('✦ B');
		expect(
			renderVisualization('table', [{k: 'v'}], 'C'),
		).toContain('✦ C');
	});
});
