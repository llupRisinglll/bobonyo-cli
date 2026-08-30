import {expect, test} from 'bun:test';
import {lspServerForPath} from './lsp-client';

test('LSP server selection is extension-aware and installed-binary gated', () => {
	const selected = lspServerForPath('sample.ts');
	if (Bun.which('typescript-language-server')) {
		expect(selected?.name).toBe('typescript-language-server');
	} else {
		expect(selected).toBeNull();
	}
	expect(lspServerForPath('README.md')).toBeNull();
});
