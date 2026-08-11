import {afterEach, describe, expect, test} from 'bun:test';
import {BASE_COMMAND_NAMES, commandNames, MOCK_COMMAND_NAMES} from './commands';
import {isPreviewTui} from './preview';

const ORIGINAL_ARGV = process.argv;

afterEach(() => {
	process.argv = ORIGINAL_ARGV;
});

describe('isPreviewTui', () => {
	test('false for a normal run', () => {
		process.argv = ['bun', 'src/index.tsx'];
		expect(isPreviewTui()).toBe(false);
	});

	test('true for `preview tui`', () => {
		process.argv = ['bun', 'src/index.tsx', 'preview', 'tui'];
		expect(isPreviewTui()).toBe(true);
	});

	test('true for `--preview tui`', () => {
		process.argv = ['bun', 'src/index.tsx', '--preview', 'tui'];
		expect(isPreviewTui()).toBe(true);
	});

	test('false for `--preview` without tui', () => {
		process.argv = ['bun', 'src/index.tsx', '--preview'];
		expect(isPreviewTui()).toBe(false);
	});
});

describe('commandNames', () => {
	test('mock scenarios are absent in a normal run', () => {
		process.argv = ['bun', 'src/index.tsx'];
		const names = commandNames();
		expect(names).toEqual([...BASE_COMMAND_NAMES]);
		expect(names.some(name => name.startsWith('mock:'))).toBe(false);
	});

	test('mock scenarios are present in preview mode', () => {
		process.argv = ['bun', 'src/index.tsx', 'preview', 'tui'];
		const names = commandNames();
		for (const mock of MOCK_COMMAND_NAMES) {
			expect(names).toContain(mock);
		}
	});
});
