import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executeLspOperation} from './lsp-tool';

let root = '';
afterEach(() => {
	if (root) rmSync(root, {recursive: true, force: true});
	root = '';
});

describe('model-facing LSP fallback', () => {
	test('finds symbol definitions and references with line locations', async () => {
		root = mkdtempSync(join(tmpdir(), 'bobonyo-lsp-'));
		writeFileSync(
			join(root, 'sample.ts'),
			'export function answer() { return 42 }\nconsole.log(answer())\n',
		);
		const symbols = await executeLspOperation(root, {
			operation: 'symbols',
			query: 'answer',
			path: 'sample.ts',
		});
		expect(symbols).toContain('sample.ts:1:1');
		const refs = await executeLspOperation(root, {
			operation: 'references',
			query: 'answer',
			path: 'sample.ts',
		});
		expect(refs).toContain('sample.ts:1:17');
		expect(refs).toContain('sample.ts:2:13');
	});
});
