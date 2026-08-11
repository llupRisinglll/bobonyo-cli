import {describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveRulesFile} from './rules-file';

function tempTree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'bobonyo-rules-'));
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(join(path, '..'), {recursive: true});
		writeFileSync(path, content);
	}
	return root;
}

describe('resolveRulesFile', () => {
	test('returns the cwd AGENTS.md when present', () => {
		const root = tempTree({'a/b/AGENTS.md': '# rules'});
		try {
			expect(resolveRulesFile(join(root, 'a/b'))).toBe(
				join(root, 'a/b/AGENTS.md'),
			);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('walks UP to the nearest ancestor AGENTS.md', () => {
		const root = tempTree({'a/AGENTS.md': '# parent rules'});
		try {
			expect(resolveRulesFile(join(root, 'a/b/c'))).toBe(
				join(root, 'a/AGENTS.md'),
			);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('cwd wins over an ancestor rules file', () => {
		const root = tempTree({
			'AGENTS.md': '# root',
			'a/AGENTS.md': '# project',
		});
		try {
			expect(resolveRulesFile(join(root, 'a'))).toBe(
				join(root, 'a/AGENTS.md'),
			);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});

	test('returns null when no AGENTS.md exists up to the root', () => {
		const root = tempTree({'a/b/file.txt': 'x'});
		try {
			expect(resolveRulesFile(join(root, 'a/b'))).toBeNull();
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});
});
