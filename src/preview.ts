/**
 * Preview-mode detection, `bobonyo preview tui` (or `bun run dev --preview
 * tui`). The `/mock:*` scenario catalog is ONLY available in this mode: in a
 * normal run those commands must not appear in autocomplete nor execute.
 */
export function isPreviewTui(): boolean {
	const cliArgs = process.argv.slice(2);
	return (
		(cliArgs.includes('--preview') &&
			cliArgs[cliArgs.indexOf('--preview') + 1] === 'tui') ||
		(cliArgs[0] === 'preview' && cliArgs[1] === 'tui')
	);
}
