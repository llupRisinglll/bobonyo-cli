import {describe, expect, test} from 'bun:test';
import {convertNanocoderSession} from './session';

describe('convertNanocoderSession', () => {
	test('maps title/messages into bobonyo SessionData', () => {
		const session = convertNanocoderSession({
			id: 'nc-1',
			title: 'Old chat',
			createdAt: '2026-08-10T08:57:02.703Z',
			lastAccessedAt: '2026-08-10T09:00:00.000Z',
			messages: [
				{role: 'user', content: 'hello'},
				{role: 'assistant', content: 'hi there'},
			],
		});
		expect(session).not.toBeNull();
		expect(session!.name).toBe('Old chat');
		expect(session!.messages.map(m => m.role)).toEqual(['user', 'assistant']);
		expect(session!.context.length).toBe(2);
	});

	test('converts assistant tool_calls + tool results into tool rows', () => {
		const session = convertNanocoderSession({
			id: 'nc-2',
			messages: [
				{role: 'user', content: 'run it'},
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'call_1',
							function: {
								name: 'execute_bash',
								arguments: '{"command":"echo hi"}',
							},
						},
					],
				},
				{role: 'tool', content: 'hi\n', tool_call_id: 'call_1', name: 'execute_bash'},
				{role: 'assistant', content: 'Done.'},
			],
		});
		expect(session).not.toBeNull();
		const toolRow = session!.messages[1]!;
		expect(toolRow.role).toBe('tool');
		expect(toolRow.tool?.name).toBe('execute_bash');
		expect(toolRow.tool?.output).toBe('hi\n');
		expect(toolRow.tool?.args).toEqual({command: 'echo hi'});
		expect(session!.messages[2]!.role).toBe('assistant');
	});

	test('returns null for a missing id', () => {
		expect(convertNanocoderSession({} as never)).toBeNull();
	});
});
