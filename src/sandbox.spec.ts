import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSandboxCommand, bubblewrapAvailable} from './sandbox';
import {runBash, sandboxedCwd} from './bash';

let root = '';
let config = '';
const originalConfig = process.env.NANOCODER_CONFIG_DIR;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-sandbox-'));
	config = join(root, 'config');
	mkdirSync(join(root, '.git'), {recursive: true});
	mkdirSync(config, {recursive: true});
	process.env.NANOCODER_CONFIG_DIR = config;
});

afterEach(() => {
	if (originalConfig === undefined) delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = originalConfig;
	rmSync(root, {recursive: true, force: true});
});

describe('sandbox command', () => {
	test('workspace-write binds workspace but keeps host root read-only', () => {
		const built = buildSandboxCommand(
			'true',
			root,
			{mode: 'workspace-write', network: true, writablePaths: []},
			true,
		);
		expect(built.active).toBe(true);
		expect(built.argv.slice(0, 2)).toEqual(['bwrap', '--die-with-parent']);
		expect(built.argv).toContain('--ro-bind');
		expect(built.argv).toContain(root);
	});

	test('read-only mode never adds writable binds', () => {
		const built = buildSandboxCommand(
			'true',
			root,
			{mode: 'read-only', network: false, writablePaths: []},
			true,
		);
		expect(built.argv).toContain('--unshare-net');
		expect(built.argv).not.toContain('--bind');
	});

	test('required mode refuses when backend is unavailable', () => {
		const built = buildSandboxCommand(
			'true',
			root,
			{mode: 'workspace-write', network: true, writablePaths: []},
			false,
		);
		expect(built.argv).toEqual([]);
		expect(built.reason).toContain('required');
	});

	test('sandboxed cwd stays inside the project', () => {
		const child = join(root, 'src');
		mkdirSync(child);
		expect(sandboxedCwd(child, root, true)).toBe(child);
		expect(sandboxedCwd('/tmp', root, true)).toBeUndefined();
		expect(sandboxedCwd('/tmp', root, false)).toBe('/tmp');
	});

	test('nested checkout keeps launch workspace writable', () => {
		const nested = join(root, 'packages', 'nested-checkout');
		mkdirSync(join(nested, '.git'), {recursive: true});
		const built = buildSandboxCommand(
			'true',
			nested,
			{mode: 'workspace-write', network: true, writablePaths: []},
			true,
			root,
		);
		const binds = built.argv
			.map((arg, index) =>
				arg === '--bind' ? built.argv[index + 1] : undefined,
			)
			.filter(Boolean);
		expect(binds).toContain(root);
		expect(sandboxedCwd(root, nested, true, root)).toBe(root);
	});
});

describe('bubblewrap execution', () => {
	test.skipIf(!bubblewrapAvailable())(
		'writes workspace and blocks writes elsewhere',
		async () => {
			writeFileSync(
				join(config, 'settings.json'),
				JSON.stringify({
					mode: 'yolo',
					toolProfile: 'full',
					maxMessages: 1000,
					autoCompact: {enabled: true, threshold: 80},
					sandbox: {mode: 'workspace-write', network: true, writablePaths: []},
				}),
			);
			const result = await runBash(
				'touch inside.txt; touch /etc/bobonyo-must-not-write 2>/dev/null; test -f inside.txt',
				undefined,
				undefined,
				root,
			);
			expect(result.content).toContain('EXIT_CODE: 0');
			expect(Bun.file(join(root, 'inside.txt')).size).toBe(0);
			expect(await Bun.file('/etc/bobonyo-must-not-write').exists()).toBe(
				false,
			);
		},
	);

	test.skipIf(!bubblewrapAvailable())(
		'nested cwd can still write elsewhere in launch workspace',
		async () => {
			const nested = join(root, 'packages', 'nested-checkout');
			const sibling = join(root, 'finance');
			mkdirSync(join(nested, '.git'), {recursive: true});
			mkdirSync(sibling, {recursive: true});
			writeFileSync(
				join(config, 'settings.json'),
				JSON.stringify({
					mode: 'yolo',
					toolProfile: 'full',
					maxMessages: 1000,
					autoCompact: {enabled: true, threshold: 80},
					sandbox: {mode: 'workspace-write', network: true, writablePaths: []},
				}),
			);
			const result = await runBash(
				`touch ${join(sibling, 'inside.txt')}`,
				undefined,
				undefined,
				nested,
				undefined,
				'user',
				root,
			);
			expect(result.content).toContain('EXIT_CODE: 0');
			expect(await Bun.file(join(sibling, 'inside.txt')).exists()).toBe(true);
		},
	);
});
