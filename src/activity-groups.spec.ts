import {describe, expect, test} from 'bun:test';
import {
	activityCallLabel,
	activityGroupForTool,
	formatActivityTree,
	formatActivityMessages,
	mcpServerTitle,
	isExplorationCommand,
} from './activity-groups';

describe('Codex-style activity groups', () => {
	test('classifies literal search commands and search-only chains', () => {
		for (const command of [
			"find src -maxdepth 2 -type f -name '*.tsx'",
			'grep -rn "hello world" src',
			"rg -n 'foo|bar' src",
			"find src -type f | grep '\\.tsx'",
			'rg --files src && grep -n needle src/a.ts',
			'find src -print; rg --hidden needle src',
			'grep "a > b" src/a.ts',
			'gr"ep" needle src/a.ts',
		]) {
			expect(isExplorationCommand(command)).toBe(true);
			expect(activityGroupForTool('execute_bash', {command})?.key).toBe(
				'explore',
			);
		}
	});
	test('rejects mutations, execution hooks, expansions and uncertain syntax', () => {
		for (const command of [
			'',
			'find . -delete',
			'find . -exec rm {} \\;',
			'find . -execdir echo {} +',
			'find . -ok echo {} \\;',
			'find . -fprint result',
			'find . -fprint0 result',
			'find . -fprintf result "%p"',
			'find . -fls result',
			'grep needle src > result',
			'grep needle src 2>/dev/null',
			'grep needle < src/a.ts',
			'grep "$(touch result)" src',
			'grep `touch result` src',
			'grep $PATTERN src',
			'find . | tee result',
			'find . && rm result',
			'find .; touch result',
			'find . || echo missing',
			'find . &',
			'find .\nrm result',
			'rg --pre=script needle src',
			'rg --pre script needle src',
			'rg --hostname-bin script needle src',
			'rg --pre-glob "*" needle src',
			'grep "unfinished',
			'find . |',
			'sudo find .',
			'/usr/bin/find .',
			'find *',
			'grep needle src/*',
			'find . --unknown',
		])
			expect(isExplorationCommand(command)).toBe(false);
		expect(isExplorationCommand(undefined)).toBe(false);
		expect(isExplorationCommand(42)).toBe(false);
	});
	test('uses full command for classification and label, never truncated detail', () => {
		const command = `find src -name '${'a'.repeat(100)}' -delete`;
		expect(activityGroupForTool('execute_bash', {command})).toBeNull();
		expect(
			activityCallLabel({
				name: 'execute_bash',
				detail: 'find…',
				args: {command: 'find src -type f'},
			}),
		).toBe('Search find src -type f');
	});
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

	test('formats skill calls as a connected Skills triggered tree', () => {
		expect(activityGroupForTool('skill')).toEqual({
			key: 'skills',
			title: 'Skills triggered',
		});
		expect(
			formatActivityMessages(activityGroupForTool('skill')!, [
				{tool: {name: 'skill', detail: 'impeccable — Polish the interface'}},
			]),
		).toBe('✦ Skills triggered\n  └ impeccable — Polish the interface');
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
		expect(text).toMatch(/\n  ├ Read a very long/);
		expect(text).toMatch(/\n  │   /);
		expect(text).toMatch(/\n  └ Search needle$/);
	});

	test('hard-wraps long paths without losing tree indentation', () => {
		const text = formatActivityTree(
			activityGroupForTool('read_file')!,
			[
				{
					name: 'read_file',
					detail: '.bobonyo/worktrees/very-long-path/server/routes.ts',
				},
			],
			30,
		);
		expect(text.split('\n')).toEqual([
			'✦ Explored',
			'  └ Read',
			'  │   .bobonyo/worktrees/v',
			'  │   ery-long-path/server',
			'  │   /routes.ts',
		]);
	});

	test('wraps path continuation at renderer width, not an undersized width', () => {
		const text = formatActivityTree(
			activityGroupForTool('read_file')!,
			[
				{
					name: 'read_file',
					detail:
						'/mnt/data/KSProjects/Hilinga/.bobonyo/worktrees/improving-subscription/hilinga-e2e-qa/tests/repos/kplugin_subscriptions/subscriptions.spec.ts',
				},
			],
			80,
		);
		const lines = text.split('\n');
		expect(lines.slice(1).every(line => line.length <= 80)).toBe(true);
		expect(lines[2]).toStartWith('  │   ');
	});
});
