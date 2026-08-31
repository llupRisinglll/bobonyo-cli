import {describe, expect, test} from 'bun:test';
import {
	formatGoal,
	goalContinuationPrompt,
	goalStatusFromResponse,
	isGoalEnvironmentFailure,
	loopIntervalMs,
	newLoopJob,
	parseDuration,
	parseGoalSpec,
	parseLoopControl,
	parseLoopSpec,
} from './goal-loop';

describe('goal helpers', () => {
	test('continuation prompt carries objective and terminal markers', () => {
		const prompt = goalContinuationPrompt({
			objective: 'Raise coverage to 90%',
			status: 'active',
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		});
		expect(prompt).toContain('Raise coverage to 90%');
		expect(prompt).toContain('[GOAL_COMPLETE]');
		expect(prompt).toContain('[GOAL_BLOCKED]');
	});

	test('response markers update status only when explicit', () => {
		expect(goalStatusFromResponse('done [GOAL_COMPLETE]', 'active')).toBe(
			'complete',
		);
		expect(goalStatusFromResponse('waiting [GOAL_BLOCKED]', 'active')).toBe(
			'blocked',
		);
		expect(goalStatusFromResponse('progress report', 'active')).toBe('active');
	});
	test('bare terminal markers from compacted output still stop goals', () => {
		expect(goalStatusFromResponse('GOAL_COMPLETE', 'active')).toBe('complete');
		expect(goalStatusFromResponse('GOAL_BLOCKED', 'active')).toBe('blocked');
	});
	test('environment failures are recognized as goal blockers', () => {
		expect(isGoalEnvironmentFailure('Error: process proc_123 not found.')).toBe(
			true,
		);
		expect(
			isGoalEnvironmentFailure('curl: (7) Failed to connect to localhost'),
		).toBe(true);
		expect(isGoalEnvironmentFailure('Tests passed: 12')).toBe(false);
	});

	test('parses Ralph-style limits and quoted completion promises', () => {
		expect(
			parseGoalSpec(
				'Ship release --tokens 9000 --max-iterations 12 --completion-promise "RELEASE VERIFIED"',
			),
		).toEqual({
			objective: 'Ship release',
			tokenBudget: 9000,
			maxIterations: 12,
			completionPromise: 'RELEASE VERIFIED',
		});
	});

	test('completion promise must be exact and prompt forbids false completion', () => {
		const goal = {
			objective: 'Ship release',
			status: 'active' as const,
			tokensUsed: 0,
			iteration: 3,
			maxIterations: 5,
			completionPromise: 'RELEASE VERIFIED',
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		const prompt = goalContinuationPrompt(goal);
		expect(prompt).toContain('Iteration 3 of 5');
		expect(prompt).toContain('<promise>RELEASE VERIFIED</promise>');
		expect(prompt).toContain('Never emit this promise unless');
		expect(
			goalStatusFromResponse(
				'Done: <promise>RELEASE VERIFIED</promise>',
				'active',
				'RELEASE VERIFIED',
			),
		).toBe('active');
		expect(
			goalStatusFromResponse(
				'<promise>RELEASE VERIFIED</promise>',
				'active',
				'RELEASE VERIFIED',
			),
		).toBe('complete');
	});

	test('goal display includes objective and budget', () => {
		expect(
			formatGoal({
				objective: 'Ship release',
				status: 'budget-limited',
				tokenBudget: 1000,
				tokensUsed: 1000,
				timeUsedSeconds: 5,
				createdAt: 1,
				updatedAt: 2,
			}),
		).toContain('1000/1000 tokens');
	});
});

describe('loop parser', () => {
	test('parses supported durations', () => {
		expect(parseDuration('5s')).toBe(5000);
		expect(parseDuration('2m')).toBe(120000);
		expect(parseDuration('1h')).toBe(3600000);
		expect(parseDuration('1d')).toBe(86400000);
		expect(parseDuration('0m')).toBeUndefined();
	});

	test('defaults plain specs to after-turn', () => {
		expect(parseLoopSpec('rerun focused tests')).toEqual({
			cronExpression: '@after-turn',
			prompt: 'rerun focused tests',
			runOnce: false,
		});
	});

	test('parses recurring and one-shot intervals', () => {
		expect(parseLoopSpec('@every 5m check deployment')).toEqual({
			cronExpression: '@every 5m',
			prompt: 'check deployment',
			runOnce: false,
			intervalMs: 300000,
		});
		expect(parseLoopSpec('once after 30s fetch status')).toEqual({
			cronExpression: '@every 30s',
			prompt: 'fetch status',
			runOnce: true,
			intervalMs: 30000,
		});
	});

	test('new jobs carry next-run time for interval schedules', () => {
		const parsed = parseLoopSpec('@every 5m check deployment')!;
		const job = newLoopJob(parsed, 1000);
		expect(job.nextRunAt).toBe(301000);
		expect(loopIntervalMs(job.cronExpression)).toBe(300000);
	});

	test('parses stop controls before plain prompts', () => {
		expect(parseLoopControl('stop')).toBe('stop');
		expect(parseLoopControl(' clear ')).toBe('clear');
		expect(parseLoopControl('delete loop_abc')).toEqual({deleteId: 'loop_abc'});
		expect(parseLoopControl('stop after build')).toBeUndefined();
	});
});
