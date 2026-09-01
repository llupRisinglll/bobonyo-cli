import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	agentTrajectoryDocument,
	writeAgentTrajectory,
} from './agent-trajectory';

test('agent trajectory is readable and includes tool calls without secrets', () => {
	const document = agentTrajectoryDocument({
		sessionId: 'sess_interview',
		cwd: '/repo',
		messages: [
			{role: 'user', content: 'Inspect auth flow.'},
			{
				role: 'tool',
				content: '',
				brief: 'Inspect authentication code.',
				tool: {
					name: 'grep',
					detail: 'auth',
					args: {pattern: 'token=secret-value'},
					output: 'Found auth.ts',
				},
			},
		],
	});
	const text = JSON.stringify(document);
	expect(text).toContain('grep');
	expect(text).toContain('preToolBrief');
	expect(text).not.toContain('secret-value');
});

test('writes deterministic committed-file name in current repository', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bobonyo-trajectory-'));
	try {
		const file = writeAgentTrajectory(dir, 'sess_1', [
			{role: 'assistant', content: 'Done.'},
		]);
		expect(file).toBe(join(dir, 'agent-trajectory.json'));
		const contents = readFileSync(file, 'utf8');
		expect(contents).toContain('"sessionId": "sess_1"');
		expect(contents).not.toContain('"format"');
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test('excludes Herdr fork control-plane notices', () => {
	const document = agentTrajectoryDocument({
		sessionId: 'sess_fork',
		cwd: '/repo',
		messages: [
			{role: 'user', content: 'Implement trajectory export.'},
			{
				role: 'assistant',
				kind: 'info',
				content: 'Forked sess_new into Herdr pane w4:p2.',
			},
			{
				role: 'assistant',
				kind: 'info',
				content: '/herdr:fork is only available inside Herdr.',
			},
		],
	});
	const text = JSON.stringify(document);
	expect(text).toContain('Implement trajectory export.');
	expect(text).not.toContain('Herdr');
	expect(text).not.toContain('sess_new');
});
