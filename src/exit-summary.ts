import {writeFileSync} from 'node:fs';

let pendingExitSummary = '';

export function buildExitSummary(options: {
	banner: string;
	hasConversation: boolean;
	sessionName: string;
	createdAt: number;
	sessionId: string;
}): string {
	if (!options.hasConversation) return `\n${options.banner}\n`;
	const created = new Date(options.createdAt).toISOString();
	return (
		`\n${options.banner}\n` +
		`  Session   ${options.sessionName} - ${created}\n` +
		`  Continue  bobonyo --resume ${options.sessionId}\n`
	);
}

export function queueExitSummary(summary: string): void {
	pendingExitSummary = summary;
}

export function takeExitSummary(): string {
	const summary = pendingExitSummary;
	pendingExitSummary = '';
	return summary;
}

export function flushExitSummary(
	write: (text: string) => unknown = text => process.stdout.write(text),
): void {
	const summary = takeExitSummary();
	if (!summary) return;
	write(summary);
}

export function rendererExitSummaryOptions(): {
	clearOnShutdown: false;
	onDestroy: () => void;
} {
	return {
		clearOnShutdown: false,
		onDestroy: () => {
			markRendererFinished();
			flushExitSummary();
		},
	};
}

/** Called only after native teardown, never from a process exit/signal hook. */
export function markRendererFinished(
	path = process.env.BOBONYO_RENDERER_FINISHED_FILE,
): void {
	if (!path) return;
	try {
		// Exclusive creation refuses existing files/symlinks. The launcher owns
		// the private directory and removes this constant-only marker on exit.
		writeFileSync(path, 'renderer-finished-v1\n', {mode: 0o600, flag: 'wx'});
	} catch {
		// Failed handshakes retain full supervisor crash-recovery cleanup.
	}
}
