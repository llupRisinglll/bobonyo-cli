import {realpathSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {projectRoot} from './project-paths';

export type SandboxMode = 'auto' | 'workspace-write' | 'read-only' | 'off';

export interface SandboxSettings {
	mode: SandboxMode;
	/** Allow network access inside the sandbox. */
	network: boolean;
	/** Extra absolute paths allowed for writes in workspace-write mode. */
	writablePaths: string[];
}

export interface SandboxCommand {
	argv: string[];
	active: boolean;
	backend: 'bubblewrap' | 'none';
	reason?: string;
}

let bubblewrapProbe: boolean | undefined;

/** Check that bubblewrap exists and user namespaces work, not merely PATH. */
export function bubblewrapAvailable(): boolean {
	if (bubblewrapProbe !== undefined) return bubblewrapProbe;
	if (process.platform !== 'linux' || !Bun.which('bwrap')) {
		bubblewrapProbe = false;
		return false;
	}
	try {
		const probe = Bun.spawnSync([
			'bwrap',
			'--die-with-parent',
			'--ro-bind',
			'/',
			'/',
			'--',
			'true',
		]);
		bubblewrapProbe = probe.exitCode === 0;
	} catch {
		bubblewrapProbe = false;
	}
	return bubblewrapProbe;
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function gitCommonDir(cwd: string): string | undefined {
	try {
		const result = Bun.spawnSync(
			['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
			{
				cwd,
			},
		);
		if (result.exitCode !== 0) return undefined;
		const path = result.stdout.toString().trim();
		return path ? canonical(path) : undefined;
	} catch {
		return undefined;
	}
}

/** Build Linux bubblewrap argv. No shell interpolation touches paths. */
export function buildSandboxCommand(
	command: string,
	cwd: string,
	settings: SandboxSettings,
	available = bubblewrapAvailable(),
	workspaceRoot = projectRoot(cwd),
): SandboxCommand {
	if (settings.mode === 'off') {
		return {argv: ['bash', '-c', command], active: false, backend: 'none'};
	}
	if (!available) {
		if (settings.mode === 'auto') {
			return {
				argv: ['bash', '-c', command],
				active: false,
				backend: 'none',
				reason: 'bubblewrap unavailable; auto mode ran without sandbox',
			};
		}
		return {
			argv: [],
			active: false,
			backend: 'none',
			reason: 'sandbox required but bubblewrap is unavailable or unusable',
		};
	}

	const root = canonical(workspaceRoot);
	const workingDirectory = canonical(cwd);
	const writable = new Set<string>();
	if (settings.mode !== 'read-only') {
		writable.add(root);
		const commonDir = gitCommonDir(cwd);
		if (commonDir) writable.add(commonDir);
		for (const path of settings.writablePaths) {
			if (isAbsolute(path)) writable.add(canonical(path));
		}
	}
	const argv = [
		'bwrap',
		'--die-with-parent',
		'--new-session',
		'--unshare-pid',
		'--unshare-uts',
		'--unshare-ipc',
		'--unshare-cgroup-try',
		'--ro-bind',
		'/',
		'/',
		'--dev-bind',
		'/dev',
		'/dev',
		'--proc',
		'/proc',
		'--tmpfs',
		'/tmp',
		'--tmpfs',
		'/var/tmp',
	];
	// Some hosts ship systemd-managed SSH snippets as symlinks owned by a
	// container/runtime user. OpenSSH rejects that config before it ever reads
	// ~/.ssh/config (`Bad owner or permissions`). The root filesystem remains
	// read-only, but hiding this optional snippet directory lets SSH use the
	// user's config and keys normally inside the sandbox.
	if (settings.network) argv.push('--tmpfs', '/etc/ssh/ssh_config.d');
	if (!settings.network) argv.push('--unshare-net');
	for (const path of [...writable].sort(
		(left, right) => left.length - right.length,
	)) {
		argv.push('--bind', path, path);
	}
	argv.push('--chdir', workingDirectory, '--', 'bash', '-c', command);
	return {argv, active: true, backend: 'bubblewrap'};
}
