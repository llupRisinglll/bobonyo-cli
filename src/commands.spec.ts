import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {
	BASE_COMMAND_NAMES,
	COMMAND_ARGUMENT_HINTS,
	COMMAND_DESCRIPTIONS,
	commandNames,
	HELP_TEXT,
	MOCK_COMMAND_NAMES,
	parseCommandLine,
	runCommand,
	type CommandContext,
} from './commands';
import {isPreviewTui} from './preview';
import {context, messages, setMessages} from './state';
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
	test('/goal:this is discoverable with optional focus syntax', () => {
		process.argv = ['bun', 'src/index.tsx'];
		expect(BASE_COMMAND_NAMES).toContain('goal:this');
		expect(commandNames()).toContain('goal:this');
		expect(COMMAND_DESCRIPTIONS['goal:this']).toBe(
			'Convert conversation findings into an actionable implementation and verification goal, then start it',
		);
		expect(COMMAND_ARGUMENT_HINTS['goal:this']).toBe('[focus]');
		expect(HELP_TEXT).toContain(
			'/goal:this [focus], convert conversation findings into an actionable implementation and verification goal, then start it; do not repeat completed investigation',
		);
	});
	test('includes plugin command', () => {
		process.argv = ['bun', 'src/index.tsx'];
		expect(commandNames()).toContain('plugin');
	});
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
	test('built-ins record exact submitted command once before handler execution', () => {
		for (const input of [
			'/goal:this finish uncovered cases',
			'/status',
			'/compact preserve tests',
			'/clear',
			'/undo',
		]) {
			const events: string[] = [];
			const ctx = new Proxy({} as CommandContext, {
				get: (_target, key) =>
					key === 'onBuiltinCommand'
						? (text: string) => events.push(text)
						: () => events.push('handler'),
			});
			runCommand(input, ctx);
			expect(events).toEqual([input, 'handler']);
		}
	});
	test('/goal:this parses independently from /goal with optional focus', () => {
		expect(parseCommandLine('/goal:this')).toEqual({
			name: 'goal:this',
			args: '',
		});
		expect(parseCommandLine('  /goal:this\t focus on test coverage  ')).toEqual(
			{
				name: 'goal:this',
				args: 'focus on test coverage',
			},
		);
	});
	test('/goal:this routes only to the conversation-derived goal callback', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get: (_target, prop: string) =>
				prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => calls.push([prop, args]),
		});
		expect(runCommand('/goal:this', ctx)).toBe(true);
		expect(runCommand('/goal:this focus on test coverage', ctx)).toBe(true);
		expect(calls).toEqual([
			['goalFromContext', ['']],
			['goalFromContext', ['focus on test coverage']],
		]);
	});
	test('/goal:this reports unavailable without falling back to /goal', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get: (_target, prop: string) =>
				prop === 'goalFromContext' || prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => calls.push([prop, args]),
		});
		const previousMessages = messages();
		const previousContext = context();
		try {
			expect(runCommand('/goal:this focus on test coverage', ctx)).toBe(true);
			expect(calls).toEqual([]);
			expect(messages().at(-1)).toEqual({
				role: 'assistant',
				kind: 'info',
				content: '/goal:this is unavailable in this context.',
			});
			expect(context()).toEqual(previousContext);
		} finally {
			setMessages(previousMessages);
		}
	});
	test('/compact forwards optional preservation instructions', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get: (_target, prop: string) =>
				prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => calls.push([prop, args]),
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
			get: (_target, prop: string) =>
				prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => calls.push([prop, args]),
		});
		expect(runCommand('/debug:agent-trajectory', ctx)).toBe(true);
		expect(calls).toEqual([['exportAgentTrajectory', []]]);
	});

	test('/goal and /loop route inline specs', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get: (_target, prop: string) =>
				prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => calls.push([prop, args]),
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
			get: (_target, prop: string) =>
				prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => {
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
			get: (_target, prop: string) =>
				prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => calls.push([prop, args]),
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

	test('unknown slash-input returns false (no error, falls through to message)', () => {
		const calls: Array<[string, unknown[]]> = [];
		const ctx = new Proxy({} as CommandContext, {
			get: (_target, prop: string) =>
				prop === 'onBuiltinCommand'
					? undefined
					: (...args: unknown[]) => calls.push([prop, args]),
		});
		// File paths, natural language, anything unrecognized → false.
		expect(runCommand('/home/user/file.txt', ctx)).toBe(false);
		expect(runCommand('/this is a question about code', ctx)).toBe(false);
		expect(runCommand('/skill:nonexistent', ctx)).toBe(false);
		// No error was shown — calls list is empty.
		expect(calls).toEqual([]);
	});
});
