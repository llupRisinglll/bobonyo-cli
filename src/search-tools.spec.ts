import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {globWorkspace, grepWorkspace} from './search-tools';

const root = '/tmp/bobonyo-search-tools';
afterEach(() => rmSync(root, {recursive: true, force: true}));

describe('workspace search tools', () => {
	test('glob is recursive, bounded, and hides dotfiles by default', () => {
		mkdirSync(join(root, 'src/nested'), {recursive: true});
		writeFileSync(join(root, 'src/a.ts'), 'alpha');
		writeFileSync(join(root, 'src/nested/b.ts'), 'beta');
		writeFileSync(join(root, '.secret.ts'), 'hidden');
		expect(globWorkspace({cwd: root, pattern: '**/*.ts'})).toContain(
			'src/a.ts',
		);
		expect(globWorkspace({cwd: root, pattern: '**/*.ts'})).toContain(
			'src/nested/b.ts',
		);
		expect(globWorkspace({cwd: root, pattern: '**/*.ts'})).not.toContain(
			'.secret',
		);
		expect(globWorkspace({cwd: root, pattern: '**/*.ts', limit: 1})).toContain(
			'more matches',
		);
	});

	test('grep supports regex, file filters, context, and binary skipping', () => {
		mkdirSync(join(root, 'src'), {recursive: true});
		writeFileSync(join(root, 'src/a.ts'), 'before\nAlpha 42\nafter\n');
		writeFileSync(join(root, 'src/a.md'), 'Alpha 99\n');
		writeFileSync(
			join(root, 'src/b.bin'),
			Buffer.from([0, 65, 108, 112, 104, 97]),
		);
		const result = grepWorkspace({
			cwd: root,
			pattern: 'alpha\\s+\\d+',
			filePattern: '*.ts',
			context: 1,
		});
		expect(result).toContain('src/a.ts:2:Alpha 42');
		expect(result).toContain('src/a.ts:1:-before');
		expect(result).not.toContain('a.md');
		expect(result).not.toContain('b.bin');
	});

	test('symlinks and paths outside workspace are rejected', () => {
		mkdirSync(root, {recursive: true});
		symlinkSync('/etc', join(root, 'escape'));
		expect(globWorkspace({cwd: root, pattern: '**/*'})).not.toContain('escape');
		expect(() =>
			globWorkspace({cwd: root, path: '..', pattern: '**/*'}),
		).toThrow(/outside workspace/);
	});
});
