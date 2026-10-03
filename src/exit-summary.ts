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
		onDestroy: flushExitSummary,
	};
}
