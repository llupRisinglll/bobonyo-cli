import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'bun:test';

// App owns these callbacks inside its Solid root. Guard the ownership wiring
// as well as the pure revision/queue behavior in the neighboring specs.
describe('goal accounting ownership wiring', () => {
	const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');
	const tools = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
	test('usage captures the turn owner instead of a mutable boolean', () => {
		expect(app).not.toContain('goalAccountingTurnRef');
		expect(app).toContain('recordUsage(usage, goalOwner)');
		expect(app).not.toContain('recordUsage(result.usage)');
		expect(app).toContain(
			'currentGoal && goalMatchesOwner(currentGoal, owner)',
		);
	});
	test('terminal status and elapsed time require matching revision', () => {
		expect(
			app.match(
				/if\s*\(\s*(?:!contextLease\.evidenceOnly\s*&&\s*)?currentGoal\s*&&\s*goalMatchesOwner\(currentGoal, goalOwner\)\s*\)/g,
			),
		).toHaveLength(2);
		expect(app).toContain('refreshGoalProgress(goalOwner, visibleReply)');
		expect(app).toContain('goalOwner: next.goalOwner');
		expect(app).toContain('invalidateGoalContinuations(previous, currentGoal)');
	});
	test('bash and process completion callbacks retain their graph', () => {
		expect(tools).toMatch(
			/result\.task!\.owner \?\? ctx\.backgroundOwner \?\? 'user',\s*ctx\.workGraphId/,
		);
		expect(tools).toMatch(/completed\.owner \?\? 'user',\s*ctx\.workGraphId/);
	});
});
