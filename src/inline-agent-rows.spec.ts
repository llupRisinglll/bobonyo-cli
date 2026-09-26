import {describe, expect, test} from 'bun:test';
import {
	formatInlineAgentOverflow,
	formatElapsedTime,
	formatInlineAgentRow,
	inlineAgentListHeight,
	inlineAgentLayout,
	inlineAgentRowsHeight,
	inlineAgentSelectionIndex,
	inlineAgentWindowStart,
	finishedAgentRows,
	formatFinishedAgentResult,
	formatFinishedAgentRow,
} from './components/inline-agent-rows';

describe('inline agent rows', () => {
	const makeAgent = (index: number) => ({
		id: `agent_${index}`,
		name: 'general',
		description: `Agent task ${index}`,
		output: '',
		transcript: [],
		streaming: '',
		history: [],
		status: 'running' as const,
		startedAt: Date.now(),
		tokensUsed: 0,
	});
	test('bounds footer height to available space, including overflow and separator', () => {
		for (const count of [0, 1, 2, 5, 6, 20]) {
			for (const budget of [0, 1, 2, 3, 5, 7, 24]) {
				const layout = inlineAgentLayout(count, budget);
				expect(layout.height).toBeLessThanOrEqual(budget);
				expect(layout.visibleRows).toBeLessThanOrEqual(5);
				expect(layout.height).toBe(layout.gapHeight + layout.listHeight);
				expect(layout.listHeight).toBe(
					layout.visibleRows + layout.overflowHeight,
				);
				if (count > 0 && budget > 0)
					expect(layout.listHeight).toBeGreaterThan(0);
			}
		}
		expect(inlineAgentLayout(1, 1).visibleRows).toBe(1);
		expect(inlineAgentLayout(8, 1).overflowHeight).toBe(1);
		expect(inlineAgentLayout(8, -5).height).toBe(0);
	});

	test('narrow rows retain task identity without wrapping, including wide Unicode', () => {
		for (const width of [0, 1, 4, 20, 40, 80]) {
			const row = formatInlineAgentRow(
				'general',
				'Inspect 日本語 👨‍👩‍👧‍👦\nfiles',
				2,
				42,
				width,
				false,
			);
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
			expect(row).not.toContain('\n');
		}
		expect(
			formatInlineAgentRow('general', 'Inspect files', 2, 42, 30, false),
		).toContain('Inspect files');
	});
	test('formats elapsed time using compound day/hour/minute/second units', () => {
		expect(formatElapsedTime(0)).toBe('0s');
		expect(formatElapsedTime(59)).toBe('59s');
		expect(formatElapsedTime(60)).toBe('1m 0s');
		expect(formatElapsedTime(61)).toBe('1m 1s');
		expect(formatElapsedTime(3599)).toBe('59m 59s');
		expect(formatElapsedTime(3600)).toBe('1h 0s');
		expect(formatElapsedTime(3661)).toBe('1h 1m 1s');
		expect(formatElapsedTime(86_399)).toBe('23h 59m 59s');
		expect(formatElapsedTime(86_400)).toBe('1d 0s');
		expect(formatElapsedTime(86_400 + 3600 + 183)).toBe('1d 1h 3m 3s');
		expect(formatElapsedTime(259_200)).toBe('3d 0s');
	});

	test('uses stable type, description, and elapsed columns', () => {
		const row = formatInlineAgentRow(
			'general',
			'What is hello in Japanese',
			4,
			34_500,
			80,
			false,
		);
		expect(row).toHaveLength(80);
		expect(row).toStartWith('  ◯ general-purpose    What is hello in Japane…');
		expect(row).toEndWith('    4s     34.5K tokens');
	});

	test('description, elapsed, and token columns never touch or shift', () => {
		const short = formatInlineAgentRow('general', 'Short', 4, 800, 100, false);
		const long = formatInlineAgentRow(
			'general',
			'Long description that must be clipped before telemetry',
			315,
			82_000,
			100,
			false,
		);
		const shortTokens = short.indexOf('800 tokens');
		const longTokens = long.indexOf('82.0K tokens');
		expect(shortTokens).toBe(longTokens + 2);
		expect(long.slice(0, longTokens)).toContain('5m 15s');
		expect(long.slice(longTokens - 5, longTokens)).toBe('     ');
	});

	test('description uses available row width before ellipsis', () => {
		const row = formatInlineAgentRow(
			'general',
			'alpha: inspect package structure and dependency boundaries in detail',
			315,
			82_000,
			120,
			false,
		);
		expect(row).toContain(
			'alpha: inspect package structure and dependency boundaries',
		);
		expect(row).toEndWith('        5m 15s     82.0K tokens');
	});

	test('selected row uses arrow prefix without shifting columns', () => {
		const plain = formatInlineAgentRow('general', 'Goal', 2, 8200, 60, false);
		const selected = formatInlineAgentRow('general', 'Goal', 2, 8200, 60, true);
		expect(selected.slice(2)).toBe(plain.slice(2));
		expect(selected).toStartWith('❯ ◯');
	});

	test('completed selection does not highlight a replacement agent', () => {
		expect(inlineAgentSelectionIndex([{id: 'agent_new'}], 'agent_old')).toBe(
			-1,
		);
		expect(inlineAgentSelectionIndex([{id: 'agent_new'}], null)).toBe(-1);
	});
	test('formats recent finished agents with remaining-agent count', () => {
		const finished = {
			...makeAgent(1),
			status: 'completed' as const,
			finishedAt: 1_000,
			output: 'REVIEW_PASSED: clean',
		};
		const running = makeAgent(2);
		expect(finishedAgentRows([finished, running], 2_000)).toEqual([finished]);
		expect(formatFinishedAgentResult(finished)).toBe('result passed');
		expect(formatFinishedAgentRow(finished, 1, 100)).toContain(
			'general - result passed waiting for 1 more agents',
		);
		expect(finishedAgentRows([finished], 20_000)).toEqual([]);
	});

	test('shows five agents plus one overflow row and keeps selection visible', () => {
		expect(inlineAgentListHeight(0)).toBe(0);
		expect(inlineAgentListHeight(1)).toBe(1);
		expect(inlineAgentListHeight(5)).toBe(5);
		expect(inlineAgentListHeight(6)).toBe(6);
		expect(inlineAgentRowsHeight(0)).toBe(0);
		expect(inlineAgentRowsHeight(1)).toBe(2);
		expect(inlineAgentRowsHeight(5)).toBe(6);
		expect(inlineAgentRowsHeight(6)).toBe(7);
		expect(inlineAgentWindowStart(8, -1)).toBe(0);
		expect(inlineAgentWindowStart(8, 4)).toBe(0);
		expect(inlineAgentWindowStart(8, 5)).toBe(1);
		expect(inlineAgentWindowStart(8, 7)).toBe(3);
		expect(formatInlineAgentOverflow(0, 8)).toBe('↓ 3 more below');
		expect(formatInlineAgentOverflow(1, 8)).toBe(
			'↑ 1 more above · ↓ 2 more below',
		);
		expect(formatInlineAgentOverflow(3, 8)).toBe('↑ 3 more above');
	});
});
