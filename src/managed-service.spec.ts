import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	managedServiceIdentity,
	managedServiceLogs,
	managedServiceStatus,
	resolveUserManagerTransport,
	startManagedService,
	stopManagedService,
	type ManagedServiceRunner,
} from './managed-service';
import type {ManagedServiceSandboxBuilder} from './managed-service';

let root = '';
let data = '';
const originalData = process.env.BOBONYO_DATA_DIR;
let originalMode: string | undefined;
const testSandboxBuilder: ManagedServiceSandboxBuilder = (
	command,
	_cwd,
	settings,
) =>
	settings.mode === 'off'
		? {argv: ['bash', '-c', command], active: false, backend: 'none'}
		: {
				argv: ['bwrap', '--', 'bash', '-c', command],
				active: true,
				backend: 'bubblewrap',
			};

beforeEach(() => {
	originalMode = process.env.BOBONYO_MODE;
	root = mkdtempSync(join(tmpdir(), 'bobonyo-managed-service-'));
	data = join(root, 'data');
	mkdirSync(join(root, '.git'), {recursive: true});
	process.env.BOBONYO_DATA_DIR = data;
});

afterEach(() => {
	if (originalMode === undefined) delete process.env.BOBONYO_MODE;
	else process.env.BOBONYO_MODE = originalMode;
	if (originalData === undefined) delete process.env.BOBONYO_DATA_DIR;
	else process.env.BOBONYO_DATA_DIR = originalData;
	rmSync(root, {recursive: true, force: true});
});

describe('managed service identity', () => {
	test('is stable per workspace and does not collide across workspaces', () => {
		const first = managedServiceIdentity('api', root);
		const again = managedServiceIdentity('api', root);
		const other = managedServiceIdentity('api', join(root, 'other'));
		expect(first.unit).toBe(again.unit);
		expect(first.unit).not.toBe(other.unit);
		expect(first.description).toContain(root);
		expect(first.logPath).toContain('managed-services');
	});

	test('rejects names that can alter unit or command arguments', () => {
		for (const name of ['', '../api', 'api.service', '--unit=x', 'api name']) {
			expect(() => managedServiceIdentity(name, root)).toThrow(
				'Invalid service name',
			);
		}
	});
});

describe('user manager transport', () => {
	test('prefers direct user manager when available', () => {
		const calls: string[][] = [];
		const runner: ManagedServiceRunner = argv => {
			calls.push(argv);
			return {exitCode: 0, stdout: '', stderr: ''};
		};
		expect(resolveUserManagerTransport(runner)).toEqual({
			systemctl: ['systemctl', '--user'],
			systemdRun: ['systemd-run', '--user'],
			description: 'local user manager',
		});
		expect(calls).toHaveLength(1);
	});

	test('uses explicit host bridge when private user socket is unusable', () => {
		const previous = process.env.USER;
		process.env.USER = 'fixture_user';
		const runner: ManagedServiceRunner = argv => ({
			exitCode:
				argv[0] === 'systemctl' && argv.includes('--machine=fixture_user@.host')
					? 0
					: 1,
			stdout: '',
			stderr: '',
		});
		try {
			expect(resolveUserManagerTransport(runner)).toEqual({
				systemctl: ['systemctl', '--user', '--machine=fixture_user@.host'],
				systemdRun: ['systemd-run', '--user', '--machine=fixture_user@.host'],
				description: 'host user manager bridge',
			});
		} finally {
			if (previous === undefined) delete process.env.USER;
			else process.env.USER = previous;
		}
	});
});

describe('managed service lifecycle command construction', () => {
	test.each(['default', 'yolo'])(
		'uses workspace identity and mode %s for sandbox policy',
		mode => {
			process.env.BOBONYO_MODE = mode;
			const identity = managedServiceIdentity('fixture', root);
			let loaded = false;
			const calls: string[][] = [];
			const runner: ManagedServiceRunner = argv => {
				calls.push(argv);
				if (
					argv.slice(0, 3).join(' ') === 'systemctl --user show-environment'
				) {
					return {exitCode: 0, stdout: '', stderr: ''};
				}
				if (argv[0] === 'systemd-run') {
					loaded = true;
					return {exitCode: 0, stdout: '', stderr: ''};
				}
				if (argv.includes('show')) {
					return loaded
						? {
								exitCode: 0,
								stdout: [
									'LoadState=loaded',
									'ActiveState=active',
									'SubState=running',
									'MainPID=123',
									'ControlGroup=/fixture',
									'InvocationID=abc',
									`Description=${identity.description}`,
									`Environment=BOBONYO_WORKSPACE_ROOT=${root} BOBONYO_SERVICE_NAME=fixture`,
								].join('\n'),
								stderr: '',
							}
						: {exitCode: 0, stdout: 'LoadState=not-found\n', stderr: ''};
				}
				if (argv.includes('stop')) {
					loaded = false;
					return {exitCode: 0, stdout: '', stderr: ''};
				}
				return {exitCode: 0, stdout: '', stderr: ''};
			};

			const started = startManagedService(
				{
					name: 'fixture',
					command: 'bun run dev',
					cwd: root,
					workspaceRoot: root,
					restart: 'always',
				},
				runner,
				testSandboxBuilder,
			);
			expect(started).toContain('invocation: abc');
			const run = calls.find(call => call[0] === 'systemd-run') ?? [];
			expect(run).toContain(
				`--unit=${identity.unit.replace(/\.service$/, '')}`,
			);
			expect(run).toContain('--property=Restart=always');
			expect(run).toContain('--property=KillMode=control-group');
			expect(run).toContain(
				`--property=StandardOutput=append:${identity.logPath}`,
			);
			expect(run).toContain(`--setenv=BOBONYO_WORKSPACE_ROOT=${root}`);
			expect(run).toContain('--setenv=BOBONYO_SERVICE_NAME=fixture');
			if (mode === 'yolo') {
				expect(run).not.toContain('bwrap');
				expect(run.slice(-3)).toEqual(['bash', '-c', 'bun run dev']);
			} else expect(run).toContain('bwrap');

			expect(managedServiceStatus('fixture', root, runner)).toContain(
				'cgroup: /fixture',
			);
			expect(stopManagedService('fixture', root, runner)).toContain(
				'control group removed',
			);
		},
	);

	test('refuses a colliding foreign unit instead of killing it', () => {
		const runner: ManagedServiceRunner = argv => {
			if (argv.includes('show-environment')) {
				return {exitCode: 0, stdout: '', stderr: ''};
			}
			return {
				exitCode: 0,
				stdout:
					'LoadState=loaded\nActiveState=active\nDescription=foreign\nEnvironment=',
				stderr: '',
			};
		};
		expect(() =>
			startManagedService(
				{
					name: 'fixture',
					command: 'sleep infinity',
					cwd: root,
					workspaceRoot: root,
				},
				runner,
				testSandboxBuilder,
			),
		).toThrow('foreign systemd unit collision');
	});

	test('logs are bounded and missing logs are explicit', async () => {
		expect(managedServiceLogs('fixture', root, 2)).toContain('log unavailable');
		const identity = managedServiceIdentity('fixture', root);
		mkdirSync(join(identity.logPath, '..'), {recursive: true});
		await Bun.write(identity.logPath, 'one\ntwo\nthree\n');
		expect(managedServiceLogs('fixture', root, 2)).toBe('two\nthree');
	});
});
