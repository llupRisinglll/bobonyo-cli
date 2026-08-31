import {describe, expect, test} from 'bun:test';
import {readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {logSubagentEvent, subagentLogPath} from './subagent-logs';

describe('subagent diagnostics logs', () => {
	test('writes session-addressable JSONL and redacts secret-shaped values', () => {
		const root = join(tmpdir(), `bobonyo-subagent-log-${process.pid}`);
		const previous = process.env.BOBONYO_DATA_DIR;
		process.env.BOBONYO_DATA_DIR = root;
		try {
			const path = logSubagentEvent({
				event: 'tool_finished',
				sessionId: 'sess:/debug',
				agentId: 'agent:explore:1',
				detail: 'token=do-not-write',
				data: {result: 'Bearer do-not-write'},
			});
			expect(path).toBe(subagentLogPath('sess:/debug'));
			const line = readFileSync(path!, 'utf8');
			expect(line).toContain('tool_finished');
			expect(line).not.toContain('do-not-write');
		} finally {
			if (previous === undefined) delete process.env.BOBONYO_DATA_DIR;
			else process.env.BOBONYO_DATA_DIR = previous;
			rmSync(root, {recursive: true, force: true});
		}
	});
});
