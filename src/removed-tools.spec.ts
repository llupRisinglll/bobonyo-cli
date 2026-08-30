import {describe, expect, test} from 'bun:test';
import {toolCatalog} from './tools';

const REMOVED_TOOLS = [
	'list_directory',
	'git_status',
	'git_log',
	'git_diff',
	'git_add',
	'git_push',
	'git_pull',
	'git_branch',
	'git_commit',
	'git_stash',
	'git_reset',
	'git_pr',
];

describe('removed redundant shell-wrapper tools', () => {
	test('catalog exposes none of them', () => {
		const names = toolCatalog().map(tool => tool.name);
		for (const name of REMOVED_TOOLS) expect(names).not.toContain(name);
		expect(names).toContain('execute_bash');
		expect(names).toContain('glob');
		expect(names).toContain('grep');
	});
});
