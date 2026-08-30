import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildMentionContext,
	extractMentionReferences,
	insertMention,
	listProjectFiles,
	mentionSearchToken,
	parseMentionReference,
} from './mentions';

let root = '';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-mentions-'));
	mkdirSync(join(root, 'src', 'nested'), {recursive: true});
	writeFileSync(join(root, 'src', 'alpha.php'), 'one\ntwo\nthree\nfour\n');
	writeFileSync(join(root, 'src', 'nested', 'beta.ts'), 'export {};\n');
});

afterEach(() => rmSync(root, {recursive: true, force: true}));

describe('mention suggestions', () => {
	test('includes directories as selectable entries before their contents', () => {
		const paths = listProjectFiles(root);
		expect(paths).toContain(join(root, 'src'));
		expect(paths).toContain(join(root, 'src', 'alpha.php'));
		expect(paths.indexOf(join(root, 'src'))).toBeLessThan(
			paths.indexOf(join(root, 'src', 'alpha.php')),
		);
	});
});

describe('mention references', () => {
	test('parses one line and inclusive line ranges', () => {
		expect(parseMentionReference('src/alpha.php#L2')).toEqual({
			path: 'src/alpha.php',
			lineStart: 2,
			lineEnd: 2,
		});
		expect(parseMentionReference('src/alpha.php#L2-4')).toEqual({
			path: 'src/alpha.php',
			lineStart: 2,
			lineEnd: 4,
		});
	});

	test('injects only requested file lines with absolute line numbers', () => {
		const context = buildMentionContext(
			'Inspect @src/alpha.php#L2-3 please',
			root,
		);
		expect(context).toContain('<file path="src/alpha.php" lines="2-3">');
		expect(context).toContain('2: two');
		expect(context).toContain('3: three');
		expect(context).not.toContain('1: one');
		expect(context).not.toContain('4: four');
	});

	test('directory mentions list direct children instead of reading child files', () => {
		const context = buildMentionContext('Inspect @src/', root);
		expect(context).toContain('<directory path="src">');
		expect(context).toContain('alpha.php');
		expect(context).toContain('nested/');
		expect(context).not.toContain('export {};');
		expect(context).not.toContain('one\ntwo');
	});

	test('supports quoted paths with spaces and line ranges', () => {
		mkdirSync(join(root, 'my folder'), {recursive: true});
		writeFileSync(join(root, 'my folder', 'file name.php'), 'a\nb\nc\n');
		expect(
			extractMentionReferences('Inspect @"my folder/file name.php"#L2-3'),
		).toEqual([{path: 'my folder/file name.php', lineStart: 2, lineEnd: 3}]);
		const context = buildMentionContext(
			'Inspect @"my folder/file name.php"#L2-3',
			root,
		);
		expect(context).toContain('2: b');
		expect(context).toContain('3: c');
	});

	test('keeps a typed line suffix when completing a path', () => {
		expect(mentionSearchToken('src/al#L7-9')).toBe('src/al');
		expect(
			insertMention('See @src/al#L7-9', 'src/alpha.php', 'src/al#L7-9'),
		).toBe('See @src/alpha.php#L7-9 ');
		expect(insertMention('See @my', 'my folder/file.php', 'my')).toBe(
			'See @"my folder/file.php" ',
		);
	});

	test('rejects traversal outside the workspace', () => {
		expect(buildMentionContext('Inspect @../secret.txt', root)).toBe('');
	});
});
