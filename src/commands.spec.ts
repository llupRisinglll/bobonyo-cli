import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {
	BASE_COMMAND_NAMES,
	COMMAND_ARGUMENT_HINTS,
	commandNames,
	MOCK_COMMAND_NAMES,
	runCommand,
	type CommandContext,
} from './commands';
import {isPreviewTui} from './preview';
import {join} from 'node:path';

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
		expect(names).toEqual(
			process.env.HERDR_ENV === '1'
				? [...BASE_COMMAND_NAMES, 'herdr:fork']
				: [...BASE_COMMAND_NAMES],
		);
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

describe('runCommand routing', () => {
	test('/compact forwards optional preservation instructions', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get:
				(_target, prop: string) =>
				(...args: unknown[]) =>
					calls.push([prop, args]),
		});
		expect(
			runCommand('/compact preserve database migration details', ctx),
		).toBe(true);
		expect(calls).toEqual([
			['compact', ['preserve database migration details']],
		]);
		expect(COMMAND_ARGUMENT_HINTS.compact).toContain('preserve');
		expect(COMMAND_ARGUMENT_HINTS['herdr:fork']).toContain('vertical');
	});
	test('/debug:agent-trajectory writes interview export', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get:
				(_target, prop: string) =>
				(...args: unknown[]) =>
					calls.push([prop, args]),
		});
		expect(runCommand('/debug:agent-trajectory', ctx)).toBe(true);
		expect(calls).toEqual([['exportAgentTrajectory', []]]);
	});

	test('/goal and /loop route inline specs', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get:
				(_target, prop: string) =>
				(...args: unknown[]) =>
					calls.push([prop, args]),
		});
		expect(runCommand('/goal improve benchmark --tokens 50000', ctx)).toBe(
			true,
		);
		expect(calls).toEqual([['goal', ['improve benchmark --tokens 50000']]]);
		calls.length = 0;
		expect(runCommand('/loop @every 5m check deployment', ctx)).toBe(true);
		expect(calls).toEqual([['loop', ['@every 5m check deployment']]]);
	});
	test('/effort routes to the effort switcher with its argument', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get:
				(_target, prop: string) =>
				(...args: unknown[]) => {
					calls.push([prop, args]);
				},
		});
		expect(runCommand('/effort high', ctx)).toBe(true);
		expect(calls).toEqual([['setEffort', ['high']]]);
		calls.length = 0;
		expect(runCommand('/effort default', ctx)).toBe(true);
		expect(calls).toEqual([['setEffort', ['default']]]);
	});

	test('a skill runs directly through the shared slash namespace', () => {
		const root = `/tmp/bobonyo-command-skill-${Math.random().toString(36).slice(2)}`;
		mkdirSync(join(root, 'skills'), {recursive: true});
		writeFileSync(
			join(root, 'skills', 'verify.md'),
			'---\nname: verify\ndescription: Verify project\n---\nRun verification.',
		);
		const previous = process.env.BOBONYO_CONFIG_DIR;
		process.env.BOBONYO_CONFIG_DIR = root;
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get:
				(_target, prop: string) =>
				(...args: unknown[]) =>
					calls.push([prop, args]),
		});
		try {
			expect(runCommand('/verify', ctx)).toBe(true);
			expect(calls).toEqual([
				[
					'submitPrompt',
					[
						'Run verification.',
						{
							kind: 'skill',
							name: 'verify',
							original: '/verify',
							body: 'Run verification.',
						},
					],
				],
			]);
		} finally {
			if (previous === undefined) delete process.env.BOBONYO_CONFIG_DIR;
			else process.env.BOBONYO_CONFIG_DIR = previous;
		}
	});
});
