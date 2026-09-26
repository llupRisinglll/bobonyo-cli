import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync} from 'node:fs';
import {dirname, relative, resolve} from 'node:path';
import {bobonyoDataDir} from './bobonyo-paths';
import {buildSandboxCommand} from './sandbox';
import {commandSandboxSettings, loadSettings} from './settings';

export type ManagedServiceRestart = 'always' | 'on-failure' | 'no';

export interface ManagedServiceOptions {
	name: string;
	command: string;
	cwd: string;
	workspaceRoot: string;
	restart?: ManagedServiceRestart;
}

export interface ManagedServiceIdentity {
	name: string;
	unit: string;
	workspaceRoot: string;
	logPath: string;
	description: string;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type ManagedServiceRunner = (argv: string[]) => CommandResult;

export interface UserManagerTransport {
	systemctl: string[];
	systemdRun: string[];
	description: 'local user manager' | 'host user manager bridge';
}

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function defaultRunner(argv: string[]): CommandResult {
	try {
		const result = Bun.spawnSync(argv, {
			stdout: 'pipe',
			stderr: 'pipe',
			env: process.env,
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (error) {
		return {
			exitCode: 1,
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

function username(runner: ManagedServiceRunner): string | null {
	const envName = process.env.USER?.trim();
	if (envName && /^[A-Za-z0-9_.-]+$/.test(envName)) return envName;
	const result = runner(['id', '-un']);
	const value = result.stdout.trim();
	return result.exitCode === 0 && /^[A-Za-z0-9_.-]+$/.test(value)
		? value
		: null;
}

/**
 * Resolve user-manager transport. Bubblewrap PID namespaces make the direct
 * systemd private socket unusable because its peer PID is outside the
 * namespace. systemd's explicit `.host` machine transport crosses that
 * boundary without detaching a child from the tool sandbox.
 */
export function resolveUserManagerTransport(
	runner: ManagedServiceRunner = defaultRunner,
): UserManagerTransport | null {
	const direct = ['systemctl', '--user'];
	if (runner([...direct, 'show-environment']).exitCode === 0) {
		return {
			systemctl: direct,
			systemdRun: ['systemd-run', '--user'],
			description: 'local user manager',
		};
	}
	const user = username(runner);
	if (!user) return null;
	const machine = `${user}@.host`;
	const bridged = ['systemctl', '--user', `--machine=${machine}`];
	if (runner([...bridged, 'show-environment']).exitCode !== 0) return null;
	return {
		systemctl: bridged,
		systemdRun: ['systemd-run', '--user', `--machine=${machine}`],
		description: 'host user manager bridge',
	};
}

export function managedServiceIdentity(
	name: string,
	workspaceRoot: string,
): ManagedServiceIdentity {
	if (!SERVICE_NAME.test(name)) {
		throw new Error(
			'Invalid service name. Use 1-64 letters, numbers, underscores, or hyphens.',
		);
	}
	const root = resolve(workspaceRoot);
	const rootId = createHash('sha256').update(root).digest('hex').slice(0, 16);
	const unit = `bobonyo-${rootId}-${name}.service`;
	const logPath = resolve(
		bobonyoDataDir(),
		'managed-services',
		rootId,
		`${name}.log`,
	);
	return {
		name,
		unit,
		workspaceRoot: root,
		logPath,
		description: `BoboNyo managed service ${name} [${root}]`,
	};
}

function fail(action: string, result: CommandResult): never {
	const detail = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim();
	throw new Error(`${action} failed${detail ? `: ${detail}` : ''}`);
}

function manager(runner: ManagedServiceRunner): UserManagerTransport {
	const transport = resolveUserManagerTransport(runner);
	if (!transport) {
		throw new Error(
			'Persistent supervisor unavailable: no accessible systemd user manager or host bridge.',
		);
	}
	return transport;
}

function show(
	identity: ManagedServiceIdentity,
	transport: UserManagerTransport,
	runner: ManagedServiceRunner,
): CommandResult {
	return runner([
		...transport.systemctl,
		'show',
		identity.unit,
		'--no-pager',
		'--property=LoadState,ActiveState,SubState,MainPID,ControlGroup,InvocationID,Description,Environment',
	]);
}

function assertOwned(
	identity: ManagedServiceIdentity,
	result: CommandResult,
): void {
	if (result.exitCode !== 0 || /LoadState=not-found/.test(result.stdout))
		return;
	if (
		!result.stdout.includes(`Description=${identity.description}`) ||
		!result.stdout.includes(
			`BOBONYO_WORKSPACE_ROOT=${identity.workspaceRoot}`,
		) ||
		!result.stdout.includes(`BOBONYO_SERVICE_NAME=${identity.name}`)
	) {
		throw new Error(
			`Refusing foreign systemd unit collision: ${identity.unit}.`,
		);
	}
}

export function checkManagedServiceSupervisor(
	runner: ManagedServiceRunner = defaultRunner,
): string {
	const transport = manager(runner);
	return `Persistent supervisor ready via ${transport.description}.`;
}

export function startManagedService(
	options: ManagedServiceOptions,
	runner: ManagedServiceRunner = defaultRunner,
): string {
	const identity = managedServiceIdentity(options.name, options.workspaceRoot);
	const cwd = resolve(options.cwd);
	const cwdRelative = relative(identity.workspaceRoot, cwd);
	if (cwdRelative === '..' || cwdRelative.startsWith('../')) {
		throw new Error(
			'Service working directory must stay inside workspace root.',
		);
	}
	if (!options.command.trim()) throw new Error('Service command is required.');
	const settings = loadSettings();
	const sandboxSettings = commandSandboxSettings(settings);
	const sandbox = buildSandboxCommand(
		options.command,
		cwd,
		{
			...sandboxSettings,
			mode: settings.mode === 'yolo' ? 'off' : 'workspace-write',
		},
		undefined,
		identity.workspaceRoot,
	);
	if (
		(!sandbox.active && settings.mode !== 'yolo') ||
		sandbox.argv.length === 0
	) {
		throw new Error(
			`Managed services require an active workspace sandbox: ${sandbox.reason ?? 'bubblewrap unavailable'}.`,
		);
	}
	const transport = manager(runner);
	const existing = show(identity, transport, runner);
	assertOwned(identity, existing);
	if (existing.exitCode === 0 && !/LoadState=not-found/.test(existing.stdout)) {
		const stopped = runner([...transport.systemctl, 'stop', identity.unit]);
		if (stopped.exitCode !== 0)
			fail('Stopping previous service instance', stopped);
	}
	mkdirSync(dirname(identity.logPath), {recursive: true});
	const restart = options.restart ?? 'on-failure';
	const started = runner([
		...transport.systemdRun,
		`--unit=${identity.unit.replace(/\.service$/, '')}`,
		`--description=${identity.description}`,
		`--working-directory=${cwd}`,
		'--property=Type=simple',
		`--property=Restart=${restart}`,
		'--property=RestartSec=1s',
		'--property=KillMode=control-group',
		'--property=TimeoutStopSec=10s',
		`--property=StandardOutput=append:${identity.logPath}`,
		`--property=StandardError=append:${identity.logPath}`,
		`--setenv=BOBONYO_WORKSPACE_ROOT=${identity.workspaceRoot}`,
		`--setenv=BOBONYO_SERVICE_NAME=${identity.name}`,
		'--',
		...sandbox.argv,
	]);
	if (started.exitCode !== 0) fail('Starting managed service', started);
	const status = show(identity, transport, runner);
	assertOwned(identity, status);
	if (
		status.exitCode !== 0 ||
		!/ActiveState=(active|activating)/.test(status.stdout)
	) {
		fail('Managed service did not become active', status);
	}
	return `${identity.unit} started via ${transport.description}.\n${formatStatus(status.stdout)}\nLog: ${identity.logPath}`;
}

export function restartManagedService(
	name: string,
	workspaceRoot: string,
	runner: ManagedServiceRunner = defaultRunner,
): string {
	const identity = managedServiceIdentity(name, workspaceRoot);
	const transport = manager(runner);
	const before = show(identity, transport, runner);
	assertOwned(identity, before);
	if (before.exitCode !== 0 || /LoadState=not-found/.test(before.stdout)) {
		throw new Error(`Managed service not found: ${identity.unit}.`);
	}
	const result = runner([...transport.systemctl, 'restart', identity.unit]);
	if (result.exitCode !== 0) fail('Restarting managed service', result);
	return managedServiceStatus(name, workspaceRoot, runner);
}

export function stopManagedService(
	name: string,
	workspaceRoot: string,
	runner: ManagedServiceRunner = defaultRunner,
): string {
	const identity = managedServiceIdentity(name, workspaceRoot);
	const transport = manager(runner);
	const before = show(identity, transport, runner);
	assertOwned(identity, before);
	if (before.exitCode !== 0 || /LoadState=not-found/.test(before.stdout)) {
		return `${identity.unit} is not loaded.`;
	}
	const result = runner([...transport.systemctl, 'stop', identity.unit]);
	if (result.exitCode !== 0) fail('Stopping managed service', result);
	const after = show(identity, transport, runner);
	if (
		after.exitCode === 0 &&
		!/LoadState=not-found|ActiveState=inactive/.test(after.stdout)
	) {
		fail('Managed service process tree did not stop', after);
	}
	return `${identity.unit} stopped; control group removed.`;
}

function formatStatus(output: string): string {
	const values = new Map(
		output
			.trim()
			.split('\n')
			.map(line => {
				const index = line.indexOf('=');
				return index < 0
					? [line, '']
					: [line.slice(0, index), line.slice(index + 1)];
			}),
	);
	return [
		`state: ${values.get('ActiveState') ?? 'unknown'}/${values.get('SubState') ?? 'unknown'}`,
		`pid: ${values.get('MainPID') ?? '0'}`,
		`invocation: ${values.get('InvocationID') ?? 'unknown'}`,
		`cgroup: ${values.get('ControlGroup') ?? 'unknown'}`,
	].join('\n');
}

export function managedServiceStatus(
	name: string,
	workspaceRoot: string,
	runner: ManagedServiceRunner = defaultRunner,
): string {
	const identity = managedServiceIdentity(name, workspaceRoot);
	const transport = manager(runner);
	const result = show(identity, transport, runner);
	assertOwned(identity, result);
	if (result.exitCode !== 0 || /LoadState=not-found/.test(result.stdout)) {
		return `${identity.unit} is not loaded.\nLog: ${identity.logPath}`;
	}
	return `${identity.unit}\n${formatStatus(result.stdout)}\nLog: ${identity.logPath}`;
}

export function managedServiceLogs(
	name: string,
	workspaceRoot: string,
	lines = 100,
): string {
	const identity = managedServiceIdentity(name, workspaceRoot);
	const limit = Math.max(1, Math.min(1000, Math.floor(lines)));
	try {
		const rows = readFileSync(identity.logPath, 'utf8').split('\n');
		return (
			rows
				.slice(-limit - 1)
				.join('\n')
				.trimEnd() || '(log empty)'
		);
	} catch {
		return `(log unavailable: ${identity.logPath})`;
	}
}
