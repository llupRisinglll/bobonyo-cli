import {describe, expect, test} from 'bun:test';
import {
	createContextGoal,
	parseContextGoal,
	uncoveredCasesGoal,
} from './context-goal';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveSession, loadSession} from './session';
import {
	goalContinuationPrompt,
	normalizeGoal,
	type SessionGoal,
} from './goal-loop';

describe('context-derived goal', () => {
	test('subset requests and newer corrections do not reuse an older uncovered list', () => {
		const history = [
			{role: 'assistant', content: 'Still uncovered:\n1. Identity\n2. SQLite'},
		];
		expect(
			uncoveredCasesGoal(history, 'finish only the SQLite uncovered cases'),
		).toBeUndefined();
		expect(
			uncoveredCasesGoal(
				history,
				'finish all of these uncovered cases except SQLite',
			),
		).toBeUndefined();
		expect(
			uncoveredCasesGoal(
				[...history, {role: 'assistant', content: 'Identity is now covered.'}],
				'finish all of these uncovered cases',
			),
		).toBeUndefined();
		expect(
			uncoveredCasesGoal(
				[
					{
						role: 'assistant',
						content:
							'Uncovered:\n1. Identity with\n   malformed headers\n2. SQLite',
					},
				],
				'finish all of these uncovered cases',
			),
		).toBeUndefined();
	});
	test('current explicit focus takes precedence in compact synthesis contract', async () => {
		await createContextGoal({
			history: [
				{role: 'user', content: 'Earlier: release the SDK and improve CI'},
			],
			focus: 'Only cover SQLite transaction failures',
			cwd: '/sdk',
			isCurrent: () => true,
			request: async messages => {
				const prompt = messages.at(-1)!.content;
				expect(prompt).toContain(
					'Current focus (authoritative scope): "Only cover SQLite transaction failures"',
				);
				expect(prompt).toContain(
					'Explicit focus overrides older broad objectives',
				);
				expect(prompt).toContain('Do not add CI changes');
				expect(prompt).not.toContain('with sections: Outcome');
				return JSON.stringify({
					objective:
						'Add passing regression coverage for SQLite transaction failures only.',
				});
			},
			save: goal => {
				expect(goal.objective.length).toBeLessThan(300);
			},
			start: () => {},
		});
	});
	test('explicit uncovered-list focus preserves every case without synthesizing a release plan', async () => {
		const cases = [
			'createPluginServer dev identity and tenant propagation',
			'Production identity parsing and malformed headers',
			'Internal service authorization: 403/405/404/500 paths',
			'SQLite semicolon/transaction handling',
			'SQLite placeholder translation and result semantics',
			'Cross-workspace isolation',
			'RPC token forwarding and provider failures',
			'Asset ownership, invalid IDs, expiry, and failure cleanup',
			'Flow runtime success/error/branch/loop behavior',
			'Resource-generated flows',
			'CLI behavior and shutdown',
			'Strong external-consumer package imports',
			'Solid UI states beyond Switch',
		];
		let requests = 0;
		let saved: SessionGoal | undefined;
		await createContextGoal({
			history: [
				{role: 'user', content: 'Earlier task: strengthen CI and open a PR.'},
				{
					role: 'assistant',
					content: `Covered:\n- Basic helper tests\nStill uncovered, highest risk:\n${cases.map((item, i) => `${i + 1}. ${item}`).join('\n')}\nThe next sensible batch is:\n- Only server tests`,
				},
			],
			focus: 'finish all of these uncovered cases yet',
			cwd: '/sdk',
			isCurrent: () => true,
			request: async () => {
				requests++;
				return JSON.stringify({objective: 'Strengthen CI and open a PR.'});
			},
			save: goal => {
				saved = goal;
			},
			start: () => {
				expect(saved).toBeDefined();
			},
		});
		expect(requests).toBe(0);
		expect(
			saved!.objective.split('\n').filter(line => line.startsWith('- ')),
		).toEqual(cases.map(item => `- ${item}`));
		expect(saved!.objective).not.toMatch(
			/CI|PR|changeset|hilinga-e2e|Basic helper|Only server|Execution directive/,
		);
		expect(saved!.objective.length).toBeLessThan(1500);
		expect(saved!.objective).toContain('passing coverage');
		expect(
			goalContinuationPrompt(normalizeGoal(JSON.parse(JSON.stringify(saved)))),
		).toContain(cases.at(-1)!);
	});
	test('rejects an oversized generated plan rather than saving or truncating its scope', async () => {
		let saved = false;
		await expect(
			createContextGoal({
				history: [{role: 'user', content: 'Implement missing tests'}],
				focus: '',
				cwd: '/',
				isCurrent: () => true,
				request: async () =>
					JSON.stringify({
						objective: 'Release planning and unrelated scope. '.repeat(100),
					}),
				save: () => {
					saved = true;
				},
				start: () => {
					throw new Error('must not start');
				},
			}),
		).rejects.toThrow('concise');
		expect(saved).toBe(false);
	});
	test('investigation-only history becomes a persisted execution directive in every continuation', async () => {
		let saved: SessionGoal | undefined;
		await createContextGoal({
			history: [
				{role: 'user', content: 'Investigate only; do not implement yet.'},
				{
					role: 'assistant',
					content:
						'Found missing atomic redemption. Implementation remains paused. GOAL_COMPLETE',
				},
			],
			focus: '',
			cwd: '/project',
			isCurrent: () => true,
			request: async messages => {
				expect(messages.at(-1)?.content).toContain(
					'/goal:this is a new execution request',
				);
				return JSON.stringify({
					objective:
						'Implement atomic redemption; verify retries and concurrent last-use requests.',
				});
			},
			save: goal => {
				saved = goal;
			},
			start: () => {
				expect(saved?.objective).toContain('Carry out this scope');
			},
		});
		const restored = normalizeGoal(JSON.parse(JSON.stringify(saved)));
		const continuation = goalContinuationPrompt(restored);
		expect(continuation).toContain('not another proposed plan');
		expect(continuation).toContain(
			'Existing safety and approval rules still apply',
		);
		expect(continuation).toContain(
			'verify retries and concurrent last-use requests',
		);
	});
	test('generated details survive session reload before runner starts', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'context-goal-'));
		const previous = process.env.BOBONYO_DATA_DIR;
		process.env.BOBONYO_DATA_DIR = dir;
		const objective =
			'Outcome: fix redemption.\nEvidence: server/vouchers.ts missing atomic update.\nVerify concurrent retries; do not merge without approval.';
		try {
			await createContextGoal({
				history: [{role: 'assistant', content: 'Investigation findings'}],
				focus: '',
				cwd: '/project',
				isCurrent: () => true,
				request: async () => JSON.stringify({objective}),
				save: goal =>
					saveSession({
						id: 'goal-this-test',
						name: 'Goal',
						firstMessage: 'Investigate',
						cwd: '/project',
						createdAt: 1,
						updatedAt: 1,
						messages: [{role: 'user', content: 'Investigate'}],
						context: [],
						goal,
					}),
				start: () => {
					expect(loadSession('goal-this-test')?.goal?.objective).toContain(
						objective,
					);
				},
			});
		} finally {
			if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
			else process.env.BOBONYO_DATA_DIR = previous;
			rmSync(dir, {recursive: true, force: true});
		}
	});
	test('storage failure never starts autonomous work', async () => {
		let started = false;
		await expect(
			createContextGoal({
				history: [{role: 'user', content: 'Findings'}],
				focus: '',
				cwd: '/',
				isCurrent: () => true,
				request: async () => '{"objective":"Fix findings"}',
				save: () => {
					throw new Error('disk unavailable');
				},
				start: () => {
					started = true;
				},
			}),
		).rejects.toThrow('disk unavailable');
		expect(started).toBe(false);
	});
	test('uses findings and focus, persists objective before starting', async () => {
		const actions: string[] = [];
		const history = [
			{role: 'user' as const, content: 'Investigate voucher retries.'},
			{
				role: 'assistant' as const,
				content:
					'Atomic redemption missing in server/vouchers.ts; concurrent retries can double count.',
			},
		];
		const result = await createContextGoal({
			history,
			focus: 'Fix only redemption',
			cwd: '/project',
			isCurrent: () => true,
			request: async messages => {
				expect(messages.slice(0, 2)).toEqual(history);
				expect(messages.at(-1)?.content).toContain('Fix only redemption');
				expect(messages.at(-1)?.content).toContain(
					'Do not repeat completed investigation',
				);
				expect(messages.at(-1)?.content).toContain(
					'/goal:this is a new execution request',
				);
				expect(messages.at(-1)?.content).toContain(
					'Do not authorize deployment',
				);
				return JSON.stringify({
					objective:
						'Implement atomic redemption with retry and concurrency tests.',
				});
			},
			save: goal => {
				expect(goal.status).toBe('active');
				expect(goal.graphId).toContain('goal:');
				actions.push('save');
			},
			start: () => {
				actions.push('start');
			},
		});
		expect(actions).toEqual(['save', 'start']);
		expect('objective' in result && result.objective).toContain(
			'Implement atomic redemption with retry and concurrency tests.',
		);
	});

	test.each([
		'invalid',
		'{}',
		'{"objective":""}',
		JSON.stringify({objective: 'x'.repeat(16001)}),
	])('invalid generation never saves or starts', async output => {
		const actions: string[] = [];
		await expect(
			createContextGoal({
				history: [{role: 'user', content: 'Investigate'}],
				focus: '',
				cwd: '/project',
				isCurrent: () => true,
				request: async () => output,
				save: () => {
					actions.push('save');
				},
				start: () => {
					actions.push('start');
				},
			}),
		).rejects.toThrow();
		expect(actions).toEqual([]);
	});
	test('changed session or cancelled generation never overwrites goal', async () => {
		let saved = false;
		await expect(
			createContextGoal({
				history: [{role: 'user', content: 'Investigate'}],
				focus: '',
				cwd: '/',
				isCurrent: () => false,
				request: async () => '{"objective":"Fix it"}',
				save: () => {
					saved = true;
				},
				start: () => {
					throw new Error('must not start');
				},
			}),
		).rejects.toThrow('conversation changed');
		expect(saved).toBe(false);
	});
	test('ambiguous context asks clarification rather than inventing scope', async () => {
		const result = await createContextGoal({
			history: [{role: 'user', content: 'Two unrelated findings'}],
			focus: '',
			cwd: '/',
			isCurrent: () => true,
			request: async () =>
				'{"question":"Which finding should become the goal?"}',
			save: () => {
				throw new Error('must not save');
			},
			start: () => {
				throw new Error('must not start');
			},
		});
		expect(result).toHaveProperty('question');
	});
	test('empty history does not contact model', async () => {
		await expect(
			createContextGoal({
				history: [],
				focus: '',
				cwd: '/',
				isCurrent: () => true,
				request: async () => {
					throw new Error('must not request');
				},
				save: () => {},
				start: () => {},
			}),
		).rejects.toThrow('No conversation context');
	});
	test('accepts fenced JSON but rejects conflicting answer shapes', () => {
		expect(
			parseContextGoal('```json\n{"objective":"Fix retries"}\n```'),
		).toEqual({objective: 'Fix retries'});
		expect(() =>
			parseContextGoal('{"objective":"Fix", "question":"Which?"}'),
		).toThrow();
	});
});
