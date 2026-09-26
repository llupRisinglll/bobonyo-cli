export const CONSOLE_TITLE = 'Console · Esc hide · F12 toggle';

/** Consume dismissal before terminal widgets or global cancellation see it. */
export function handleConsoleInput(
	raw: string,
	console: {visible: boolean; hide: () => void; toggle: () => void},
): boolean {
	if (raw === '\x1b[24~' || raw === '\x1b[57387u') {
		console.toggle();
		return true;
	}
	if (raw === '\x1b' && console.visible) {
		console.hide();
		return true;
	}
	return false;
}
