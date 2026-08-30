import {describe, expect, test} from 'bun:test';
import {
	COMPACTION_FAILURE_COOLDOWN_MS,
	COMPACTION_STATE_PREFIX,
	INITIAL_COMPACTION_FAILURE_STATE,
	autoCompactReentryFloor,
	autoCompactTokenLimit,
	buildCompactionStateSnapshot,
	canAttemptAutoCompaction,
	estimateContextTokens,
	microcompactToolResults,
	parseCompactionStateSnapshot,
	recordCompactionFailure,
	recordCompactionSuccess,
	shouldAutoCompactContext,
} from './compaction-state';

describe('deterministic compaction state', () => {
	test('preserves tasks, goal, loops, agents, skills, files, and transcript path', () => {
		const context = [
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'skill-1',
						name: 'skill',
						arguments: '{"name":"prod","arguments":"deploy"}',
					},
					{
						id: 'read-1',
						name: 'read_file',
						arguments: '{"path":"src/app.tsx","offset":10,"limit":20}',
					},
				],
			},
			{role: 'tool', content: 'PROD RULES', tool_call_id: 'skill-1'},
			{role: 'tool', content: 'SOURCE BODY', tool_call_id: 'read-1'},
		];
		const raw = buildCompactionStateSnapshot({
			sessionId: 'sess-1',
			cwd: '/repo',
			workspaceRoot: '/repo',
			transcriptPath: '/data/transcript.json',
			tasks: [
				{id: 't1', title: 'Inspect', status: 'completed'},
				{id: 't2', title: 'Ship', status: 'in_progress'},
			],
			goal: {
				objective: 'Ship it',
				status: 'active',
				tokensUsed: 12,
				iteration: 2,
				maxIterations: 5,
				completionPromise: 'SHIPPED',
				timeUsedSeconds: 3,
				createdAt: 1,
				updatedAt: 2,
			},
			loopJobs: [
				{
					id: 'loop-1',
					cronExpression: '@after-turn',
					prompt: 'verify',
					runOnce: false,
					createdAt: 1,
				},
			],
			queuedPrompts: [{value: 'continue', source: 'goal'}],
			agents: [
				{
					id: 'agent-1',
					name: 'explore',
					description: 'inspect',
					output: 'found it',
					transcript: [],
					streaming: '',
					history: [],
					status: 'completed',
				},
			],
			messages: [],
			context,
			availableSkills: [
				{name: 'prod', source: '/skills/prod.md', body: 'fallback'},
			],
			model: 'test-model',
			budgets: {
				maxSkills: 5,
				maxSkillTokens: 100,
				maxTotalSkillTokens: 500,
				maxFiles: 5,
				maxFileTokens: 100,
				maxTotalFileTokens: 500,
			},
		});
		expect(raw.startsWith(COMPACTION_STATE_PREFIX)).toBe(true);
		const data = parseCompactionStateSnapshot(raw)!;
		expect(data.session.transcriptPath).toBe('/data/transcript.json');
		expect(data.tasks[1]?.status).toBe('in_progress');
		expect(data.goal?.iteration).toBe(2);
		expect(data.loopJobs[0]?.prompt).toBe('verify');
		expect(data.queuedPrompts[0]?.source).toBe('goal');
		expect(data.agents[0]?.id).toBe('agent-1');
		expect(data.invokedSkills[0]).toMatchObject({
			name: 'prod',
			arguments: 'deploy',
			instructions: 'PROD RULES',
		});
		expect(data.recentFiles[0]).toMatchObject({
			absolutePath: '/repo/src/app.tsx',
			offset: 10,
			limit: 20,
			content: 'SOURCE BODY',
		});
	});

	test('merges prior deterministic skills and files across generations', () => {
		const first = buildCompactionStateSnapshot({
			sessionId: 's',
			cwd: '/repo',
			workspaceRoot: '/repo',
			transcriptPath: '/one',
			tasks: [],
			loopJobs: [],
			agents: [],
			messages: [
				{
					role: 'user',
					content: '/prod',
					command: {kind: 'skill', name: 'prod', body: 'RULES'},
				},
			],
			context: [
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{id: 'r', name: 'read_file', arguments: '{"path":"a.ts"}'},
					],
				},
				{role: 'tool', content: 'A', tool_call_id: 'r'},
			],
			availableSkills: [{name: 'prod', source: '/prod', body: 'RULES'}],
			model: 'test-model',
			budgets: {
				maxSkills: 5,
				maxSkillTokens: 100,
				maxTotalSkillTokens: 500,
				maxFiles: 5,
				maxFileTokens: 100,
				maxTotalFileTokens: 500,
			},
		});
		const second = buildCompactionStateSnapshot({
			sessionId: 's',
			cwd: '/repo',
			workspaceRoot: '/repo',
			transcriptPath: '/two',
			tasks: [],
			loopJobs: [],
			agents: [],
			messages: [],
			context: [{role: 'user', content: first}],
			availableSkills: [],
			model: 'test-model',
			budgets: {
				maxSkills: 5,
				maxSkillTokens: 100,
				maxTotalSkillTokens: 500,
				maxFiles: 5,
				maxFileTokens: 100,
				maxTotalFileTokens: 500,
			},
		});
		const restored = parseCompactionStateSnapshot(second)!;
		expect(restored.invokedSkills[0]?.name).toBe('prod');
		expect(restored.recentFiles[0]?.absolutePath).toBe('/repo/a.ts');
	});
});

describe('compaction token policy', () => {
	test('counts tool arguments and reserves fixed headroom', () => {
		const plain = estimateContextTokens(
			[{role: 'assistant', content: ''}],
			'test-model',
		);
		const withArgs = estimateContextTokens(
			[
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'c1',
							name: 'write_file',
							arguments: JSON.stringify({content: 'x'.repeat(8_000)}),
						},
					],
				},
			],
			'test-model',
		);
		expect(withArgs).toBeGreaterThan(plain + 1_000);
		expect(autoCompactTokenLimit(128_000, 95)).toBe(115_000);
		expect(
			shouldAutoCompactContext({
				estimatedTokens: 115_000,
				contextWindow: 128_000,
				thresholdPercent: 95,
				messageCount: 1,
				messageCap: 1000,
				messageMargin: 100,
			}),
		).toBe(true);
	});

	test('circuit breaker pauses after three failures and resets on success', () => {
		let state = {...INITIAL_COMPACTION_FAILURE_STATE};
		state = recordCompactionFailure(state, 100);
		state = recordCompactionFailure(state, 100);
		expect(canAttemptAutoCompaction(state, 100)).toBe(true);
		state = recordCompactionFailure(state, 100);
		expect(canAttemptAutoCompaction(state, 100)).toBe(false);
		expect(
			canAttemptAutoCompaction(state, 100 + COMPACTION_FAILURE_COOLDOWN_MS),
		).toBe(true);
		expect(recordCompactionSuccess()).toEqual(INITIAL_COMPACTION_FAILURE_STATE);
	});

	test('large compacted base requires growth before recompacting', () => {
		expect(autoCompactReentryFloor(90_000, 100_000)).toBe(0);
		expect(autoCompactReentryFloor(100_000, 100_000)).toBe(102_000);
	});

	test('microcompaction shortens large historical tool output only', () => {
		const result = microcompactToolResults(
			[
				{role: 'tool', content: 'x'.repeat(20_000), tool_call_id: 'old'},
				{role: 'assistant', content: 'y'.repeat(20_000)},
			],
			'test-model',
			100,
			40,
		);
		expect(result.compactedCount).toBe(1);
		expect(result.messages[0]!.content).toContain('shortened only for summary');
		expect(result.messages[1]!.content.length).toBe(20_000);
	});
});
