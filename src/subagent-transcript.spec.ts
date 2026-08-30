import {describe, expect, test} from 'bun:test';
import {subagentDisplayMessages} from './subagent-transcript';
import {formatSubagentCompactTail, subagentCompactTail} from './subagent-tail';
import type {ActiveAgentRun} from './state';

function run(history: ActiveAgentRun['history']): ActiveAgentRun {
	return {
		id: 'agent:explore:1',
		name: 'explore',
		description: 'inspect routing',
		output: '',
		transcript: [],
		streaming: '',
		history,
		status: 'completed',
	};
}

describe('subagent compact tails', () => {
	test('keeps newest lines, caps width, and aligns continuations', () => {
		expect(subagentCompactTail('one\ntwo\nthree\nfour\nfive', 4, 5)).toEqual([
			'two',
			'three',
			'four',
			'five',
		]);
		expect(formatSubagentCompactTail('first\nsecond', 4, 80)).toBe(
			'  └  first\n     second',
		);
		expect(formatSubagentCompactTail('', 4, 80)).toBe('  └  Working…');
		expect(subagentCompactTail('123456', 4, 5)).toEqual(['1234…']);
	});
});
describe('subagentDisplayMessages', () => {
	test('projects child history into main History message shape', () => {
		const messages = subagentDisplayMessages(
			run([
				{role: 'user', content: 'system prompt\n\nTask: inspect routing'},
				{role: 'assistant', content: 'Checking tools.'},
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'call_1',
							name: 'execute_bash',
							arguments: '{"command":"bun test"}',
						},
					],
				},
				{role: 'tool', content: '20 tests passed', tool_call_id: 'call_1'},
			]),
		);
		expect(messages[0]).toEqual({
			role: 'user',
			content: 'Task: inspect routing',
		});
		expect(messages[1]).toEqual({
			role: 'assistant',
			content: 'Checking tools.',
		});
		expect(messages[2]?.tool).toEqual({
			name: 'execute_bash',
			detail: 'bun test',
			output: '20 tests passed',
			args: {command: 'bun test'},
		});
		expect(messages[2]?.running).toBe(false);
	});
});
