import {describe, expect, test} from 'bun:test';
import {
	looksLikeToolCallText,
	openAIToolBlocks,
	parseToolCalls,
	parseXmlToolCalls,
} from './client';

describe('parseXmlToolCalls', () => {
	test('parses the plain <tool_calls>/<invoke> dialect with named params', () => {
		const parsed = parseXmlToolCalls(
			'Sure, here you go.\n<tool_calls>\n<invoke name="WebSearch">\n<parameter name="query">who is Ada Lovelace</parameter>\n</invoke>\n</tool_calls>',
		);
		expect(parsed).not.toBeNull();
		expect(parsed!.calls.length).toBe(1);
		expect(parsed!.calls[0]!.name).toBe('WebSearch');
		expect(JSON.parse(parsed!.calls[0]!.arguments)).toEqual({
			query: 'who is Ada Lovelace',
		});
		expect(parsed!.cleanText).toBe('Sure, here you go.');
	});

	test('parses POSITIONAL <parameter string="N"> args via the arg order', () => {
		const parsed = parseXmlToolCalls(
			'<tool_calls>\n<invoke name="Bash">\n<parameter string="0">sleep 5 && echo "hello world"</parameter>\n</invoke>\n</tool_calls>',
		);
		expect(parsed).not.toBeNull();
		expect(parsed!.calls[0]!.name).toBe('Bash');
		expect(JSON.parse(parsed!.calls[0]!.arguments)).toEqual({
			command: 'sleep 5 && echo "hello world"',
		});
	});

	test('still parses the antml dialect', () => {
		const parsed = parseXmlToolCalls(
			'<antml:function_calls><antml:invoke name="Read"><antml:parameter name="path">README.md</antml:parameter></antml:invoke></antml:function_calls>',
		);
		expect(parsed).not.toBeNull();
		expect(parsed!.calls[0]!.name).toBe('Read');
		expect(JSON.parse(parsed!.calls[0]!.arguments)).toEqual({
			path: 'README.md',
		});
	});

	test('returns null when no tool-call block exists', () => {
		expect(parseXmlToolCalls('just a normal reply')).toBeNull();
	});
});

describe('harness parity, tools in the OpenAI request', () => {
	test('openAIToolBlocks builds the standard function catalog', () => {
		const blocks = openAIToolBlocks([
			{name: 'execute_bash', description: 'Run a shell command'},
			{name: 'read_file'},
		]);
		expect(blocks).toEqual([
			{
				type: 'function',
				function: {
					name: 'execute_bash',
					description: 'Run a shell command',
					parameters: {type: 'object', properties: {}},
				},
			},
			{
				type: 'function',
				function: {
					name: 'read_file',
					description: '',
					parameters: {type: 'object', properties: {}},
				},
			},
		]);
	});
});

describe('parseToolCalls (recovery parser)', () => {
	test('recovers Llama <function=name>{json}</function> calls', () => {
		const parsed = parseToolCalls(
			'Let me check.\n<function=web_search>{"query":"ink TUI"}</function>',
		);
		expect(parsed.success).toBe(true);
		expect(parsed.toolCalls.length).toBe(1);
		expect(parsed.toolCalls[0]!.name).toBe('web_search');
		expect(JSON.parse(parsed.toolCalls[0]!.arguments)).toEqual({
			query: 'ink TUI',
		});
		expect(parsed.cleanText).toBe('Let me check.');
	});

	test('recovers JSON-shaped tool calls (fenced)', () => {
		const parsed = parseToolCalls(
			'```json\n{"name":"read_file","arguments":{"path":"README.md"}}\n```',
		);
		expect(parsed.success).toBe(true);
		expect(parsed.toolCalls[0]!.name).toBe('read_file');
		expect(JSON.parse(parsed.toolCalls[0]!.arguments)).toEqual({
			path: 'README.md',
		});
	});

	test('flags malformed XML with error + format guidance', () => {
		const parsed = parseToolCalls(
			'<tool_calls><invoke name="Bash"><parameter name="command">ls',
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Malformed tool call');
		expect(parsed.examples).toContain('<tool_calls>');
	});

	test('flags malformed JSON ("arguments" as a string)', () => {
		const parsed = parseToolCalls(
			'{"name":"Bash","arguments":"ls -la"}',
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('must be an object');
	});

	test('plain prose parses as a clean text-only turn', () => {
		const parsed = parseToolCalls('Just a normal reply.');
		expect(parsed.success).toBe(true);
		expect(parsed.toolCalls.length).toBe(0);
		expect(parsed.cleanText).toBe('Just a normal reply.');
	});

	test('looksLikeToolCallText guards the recovery trigger', () => {
		expect(looksLikeToolCallText('Use <tool_calls> now')).toBe(true);
		expect(looksLikeToolCallText('{"name":"Bash","arguments":{}}')).toBe(
			true,
		);
		expect(looksLikeToolCallText('Just prose here')).toBe(false);
	});
});
