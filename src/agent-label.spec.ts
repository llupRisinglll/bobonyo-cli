import {describe, expect, test} from 'bun:test';
import {
	agentDisplayLabels,
	agentLabelBase,
	nextAgentDisplayLabel,
} from './agent-label';

describe('active agent labels', () => {
	test('strips launch boilerplate without imposing a display-width cap', () => {
		expect(
			agentLabelBase(
				'Do not edit files. First run exactly `sleep 45`. Then inspect package structure and dependency boundaries in detail.',
			),
		).toBe('inspect package structure and dependency boundaries in detail');
	});

	test('keeps the unique actionable goal, not workspace or instructions', () => {
		expect(
			agentLabelBase(
				'In /mnt/data/project/worktree, add focused VoucherPicker tests for package lineage applicability. Do not edit production code. Run focused tests and report.',
			),
		).toBe('add focused VoucherPicker tests for package lineage applicability');
	});

	test('prefixes repeated goals with deterministic ordinals', () => {
		const description = 'Inspect package structure';
		const first = nextAgentDisplayLabel(description, []);
		const second = nextAgentDisplayLabel(description, [
			{description, displayLabel: first},
		]);
		const third = nextAgentDisplayLabel(description, [
			{description, displayLabel: first},
			{description, displayLabel: second},
		]);
		expect([first, second, third]).toEqual([
			'Inspect package structure',
			'alpha: Inspect package structure',
			'beta: Inspect package structure',
		]);
	});

	test('legacy runs without saved labels remain unique', () => {
		expect(
			agentDisplayLabels([
				{description: 'Inspect tests'},
				{description: 'Inspect tests'},
				{description: 'Inspect UI'},
			]),
		).toEqual(['alpha: Inspect tests', 'beta: Inspect tests', 'Inspect UI']);
	});
});
