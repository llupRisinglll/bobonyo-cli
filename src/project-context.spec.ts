import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeProjectContext} from './project-context';
import {buildSystemPrompt} from './client';

test('launch ownership and fresh rules survive navigation and prompt reconstruction', () => {
	const original = process.cwd();
	const root = mkdtempSync(join(tmpdir(), 'launch-context-'));
	try {
		const child = join(root, 'worktree');
		mkdirSync(child);
		writeFileSync(join(root, 'AGENTS.md'), 'Launch rule: preserve ownership.');
		writeFileSync(join(child, 'AGENTS.md'), 'Child rules.');
		initializeProjectContext(root);
		process.chdir(child);
		expect(buildSystemPrompt()).toContain('Launch rule: preserve ownership.');
		writeFileSync(
			join(root, 'AGENTS.md'),
			'Launch rule: fresh after compaction.',
		);
		const rebuilt = buildSystemPrompt(undefined, {disableCaveman: true});
		expect(rebuilt).toContain('Launch rule: fresh after compaction.');
		expect(rebuilt).toContain(`Project configuration root: ${root}`);
		expect(rebuilt).toContain(join(root, '.bobonyo'));
		expect(rebuilt).not.toContain('Launch rule: preserve ownership.');
	} finally {
		process.chdir(original);
		initializeProjectContext(original);
		rmSync(root, {recursive: true, force: true});
	}
});
