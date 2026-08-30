export type AgentLifecycleState = 'idle' | 'working' | 'blocked' | 'unknown';

const HERDR_SOURCE = 'bobonyo';
let herdrSeq = 0;
function nextHerdrSeq(): string {
	herdrSeq += 1;
	return String(herdrSeq);
}

function hasCommand(command: string): boolean {
	return Bun.which(command) !== null;
}

function spawnDetached(argv: string[]): boolean {
	try {
		const process = Bun.spawn(argv, {
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
			detached: true,
		});
		process.unref?.();
		return true;
	} catch {
		return false;
	}
}

function herdrPaneId(): string | undefined {
	return process.env.HERDR_ENV === '1' && process.env.HERDR_PANE_ID
		? process.env.HERDR_PANE_ID
		: undefined;
}

/**
 * Report Bobonyo directly to Herdr. No external integration is required:
 * lifecycle authority makes the current pane a first-class Herdr agent even
 * though Bobonyo is not one of Herdr's bundled detection kinds.
 */
export function reportHerdrAgent(
	state: AgentLifecycleState,
	options: {message?: string; sessionId?: string; cwd?: string} = {},
): boolean {
	const pane = herdrPaneId();
	if (!pane || !hasCommand('herdr')) return false;
	const argv = [
		'herdr',
		'pane',
		'report-agent',
		pane,
		'--source',
		HERDR_SOURCE,
		'--agent',
		'bobonyo',
		'--state',
		state,
		'--seq',
		nextHerdrSeq(),
	];
	if (options.message) argv.push('--message', options.message.slice(0, 240));
	if (options.sessionId) argv.push('--agent-session-id', options.sessionId);
	return spawnDetached(argv);
}

export function reportHerdrSession(sessionId: string, cwd: string): boolean {
	const pane = herdrPaneId();
	if (!pane || !hasCommand('herdr')) return false;
	const reported = spawnDetached([
		'herdr',
		'pane',
		'report-agent-session',
		pane,
		'--source',
		HERDR_SOURCE,
		'--agent',
		'bobonyo',
		'--agent-session-id',
		sessionId,
		'--seq',
		nextHerdrSeq(),
	]);
	spawnDetached([
		'herdr',
		'pane',
		'report-metadata',
		pane,
		'--source',
		HERDR_SOURCE,
		'--agent',
		'bobonyo',
		'--display-agent',
		'BoboNyo',
		'--state-label',
		'idle=ready',
		'--state-label',
		'working=working',
		'--state-label',
		'blocked=needs input',
		'--token',
		`cwd=${cwd}`,
		'--seq',
		nextHerdrSeq(),
	]);
	return reported;
}

export function releaseHerdrAgent(): boolean {
	const pane = herdrPaneId();
	if (!pane || !hasCommand('herdr')) return false;
	return spawnDetached([
		'herdr',
		'pane',
		'release-agent',
		pane,
		'--source',
		HERDR_SOURCE,
		'--agent',
		'bobonyo',
		'--seq',
		nextHerdrSeq(),
	]);
}

export type NotificationBackend =
	'herdr' | 'notify-send' | 'osascript' | 'powershell' | 'bell';

export function notificationBackends(
	options: {
		platform?: NodeJS.Platform;
		herdr?: boolean;
		hasNotifySend?: boolean;
	} = {},
): NotificationBackend[] {
	const platform = options.platform ?? process.platform;
	const herdr = options.herdr ?? Boolean(herdrPaneId() && hasCommand('herdr'));
	const desktop: NotificationBackend =
		platform === 'darwin'
			? 'osascript'
			: platform === 'win32'
				? 'powershell'
				: (options.hasNotifySend ?? hasCommand('notify-send'))
					? 'notify-send'
					: 'bell';
	// Herdr notification is an in-app toast. It is NOT a desktop notification.
	// Deliver both so users see completion while another app is focused.
	return herdr ? ['herdr', desktop] : [desktop];
}

export function notificationBackend(
	options: Parameters<typeof notificationBackends>[0] = {},
): NotificationBackend {
	return notificationBackends(options)[0] ?? 'bell';
}

export function shouldNotifyTurnComplete(options: {
	interrupted: boolean;
}): boolean {
	// Desktop notifications report completed turns, not only fully idle
	// sessions. Queued/goal continuation may keep Herdr `working`, but user
	// still deserves notification that this turn finished.
	return !options.interrupted;
}

/** Show completion outside terminal focus; Herdr is preferred when present. */
export function notifyTaskComplete(options: {
	title?: string;
	body: string;
}): NotificationBackend {
	const title = options.title?.trim() || 'BoboNyo';
	const body = options.body.trim().slice(0, 500) || 'Task complete';
	const backends = notificationBackends();
	for (const backend of backends) {
		if (backend === 'herdr') {
			spawnDetached([
				'herdr',
				'notification',
				'show',
				title,
				'--body',
				body,
				'--sound',
				'done',
			]);
		} else if (backend === 'notify-send') {
			spawnDetached([
				'notify-send',
				'--app-name=BoboNyo',
				'--urgency=normal',
				'--expire-time=10000',
				title,
				body,
			]);
		} else if (backend === 'osascript') {
			const escapedTitle = title.replace(/["\\]/g, '\\$&');
			const escapedBody = body.replace(/["\\]/g, '\\$&');
			spawnDetached([
				'osascript',
				'-e',
				`display notification "${escapedBody}" with title "${escapedTitle}" sound name "Glass"`,
			]);
		} else if (backend === 'powershell') {
			spawnDetached([
				'powershell',
				'-NoProfile',
				'-Command',
				`[console]::beep(880,250); Write-Host '${body.replace(/'/g, "''")}'`,
			]);
		} else {
			try {
				process.stdout.write('\u0007');
			} catch {}
		}
	}
	return backends[0] ?? 'bell';
}
