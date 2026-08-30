import {describe, expect, test} from 'bun:test';
import {
	activityCallLabel,
	activityGroupForTool,
	formatActivityTree,
	formatActivityMessages,
	mcpServerTitle,
} from './activity-groups';

describe('Codex-style activity groups', () => {
	test('groups only exploration, web, and MCP tools', () => {
		expect(activityGroupForTool('read_file')).toEqual({
			key: 'explore',
			title: 'Explored',
		});
		expect(activityGroupForTool('web_search')?.title).toBe('Navigated Web');
		expect(activityGroupForTool('mcp__playwright__browser_click')).toEqual({
			key: 'mcp:playwright',
			title: 'Playwright MCP',
		});
		expect(
			activityGroupForTool('mcp__codebase_memory_mcp__search_code'),
		).toEqual({
			key: 'mcp:codebase_memory_mcp',
			title: 'Codebase Memory MCP',
		});
		expect(activityGroupForTool('execute_bash')).toBeNull();
		expect(activityGroupForTool('write_file')).toBeNull();
	});

	test('normalizes arbitrary MCP server ids without duplicating MCP', () => {
		expect(mcpServerTitle('codebase_memory_mcp')).toBe('Codebase Memory MCP');
		expect(mcpServerTitle('playwright')).toBe('Playwright MCP');
		expect(mcpServerTitle('github_server')).toBe('Github Server MCP');
	});

	test('message adapter preserves call order without deduping repeated tools', () => {
		expect(
			formatActivityMessages(activityGroupForTool('read_file')!, [
				{tool: {name: 'read_file', detail: 'a.ts'}},
				{tool: {name: 'read_file', detail: 'b.ts'}},
				{tool: {name: 'grep', detail: 'needle'}},
			]),
		).toBe(
			'✦ Explored\n' +
				'  ├ Read a.ts\n' +
				'  ├ Read b.ts\n' +
				'  └ Search needle',
		);
	});

	test('formats chronological calls with connected branches', () => {
		const group = activityGroupForTool('read_file')!;
		expect(
			formatActivityTree(group, [
				{name: 'read_file', detail: 'src/a.ts'},
				{name: 'grep', detail: 'renderToolRun'},
				{name: 'glob', detail: 'src/**/*.tsx'},
			]),
		).toBe(
			'✦ Explored\n' +
				'  ├ Read src/a.ts\n' +
				'  ├ Search renderToolRun\n' +
				'  └ Glob src/**/*.tsx',
		);
	});

	test('quotes web searches and formats MCP calls compactly', () => {
		expect(activityCallLabel({name: 'web_search', detail: 'asdasd'})).toBe(
			'WebSearch "asdasd"',
		);
		expect(
			activityCallLabel({
				name: 'mcp__playwright__browser_click',
				detail: 'details',
			}),
		).toBe('click(details)');
	});

	test('wrapped intermediate calls retain a vertical connector', () => {
		const text = formatActivityTree(
			activityGroupForTool('read_file')!,
			[
				{
					name: 'read_file',
					detail: 'a very long path with several words that wraps',
				},
				{name: 'grep', detail: 'needle'},
			],
			30,
		);
		expect(text).toMatch(/\n  ├ Read a very long path/);
		expect(text).toMatch(/\n  │   /);
		expect(text).toMatch(/\n  └ Search needle$/);
	});
});
