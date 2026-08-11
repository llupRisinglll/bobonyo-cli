/** @jsxImportSource @opentui/solid */
import {createMemo} from 'solid-js';
import {useTerminalDimensions} from '@opentui/solid';
import {
	activeEndpoint,
	activeAgents,
	mode,
	toolProfile,
} from '../state';
import {bgTasks} from '../bash';
import {createTextAttributes} from '@opentui/core';
import {resolveProfile} from '../tools';
import {colors} from '../theme';
import {statusPathLabel} from '../status-path';

/**
 * Mode line, parity flavor of nanocoder's footer: mode · model · ctx.
 */
export function Status() {
	const terminalDimensions = useTerminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const bg = createMemo(() => {
		const count = bgTasks().filter(task => task.running).length;
		return count > 0 ? ` · bg: ${count}` : '';
	});
	const agents = createMemo(() => {
		const count = activeAgents();
		return count > 0 ? ` · agents: ${count}` : '';
	});
	const modeLabel = createMemo(() => {
		const current = mode();
		return current === 'yolo' ? 'yolo mode on' : `${current} mode`;
	});
	// Parity: the tune label shows the RESOLVED profile, and flags its auto
	// origin with `(auto)` on wide terminals (narrow ones drop the suffix).
	const tuneLabel = createMemo(() => {
		const chosen = toolProfile();
		const resolved = resolveProfile(chosen, activeEndpoint().model);
		const wide = (terminalDimensions().width ?? 80) >= 100;
		return chosen === 'auto' && wide ? `tune: ${resolved} (auto)` : `tune: ${resolved}`;
	});
	const cwdLabel = createMemo(() => {
		const cwd = process.cwd();
		const user = process.env.USER ?? 'user';
		// Keep the footer on ONE row (a wrapped status line would paint over
		// the input box's bottom border on narrow panes): size the path to the
		// remaining width after the FULL left segment (mode/tune/model/ctx/
		// agents/bg, forgetting any part makes the line overflow and OpenTUI
		// clips `~N%`/`bg: N` digits out of the middle nodes).
		const width = Math.max(24, (terminalDimensions().width ?? 80) - 2);
		const left =
			`⏵⏵⏵ ${modeLabel()} · tune: ` +
			`${tuneLabel().replace(/^tune:\s*/, '')}` +
			// agents/bg counts appear mid-line, budget them too or a narrow
			// pane clips the `bg: 1` digit at the status-line edge.
			agents() +
			bg();
		return statusPathLabel({left, user, cwd, width});
	});
	return (
		<box flexDirection="row" height={1}>
			<text fg={colors().error} attributes={bold()}>⏵⏵⏵ {modeLabel()}</text>
			{/* Leading spaces live in the FOLLOWING node, OpenTUI trims
			    trailing whitespace from a text node, which ate the space
			    between `tune:` and the value. */}
			<text fg={colors().secondary}> · tune:</text>
			<text fg={colors().primary}> {tuneLabel().replace(/^tune:\s*/, '')}</text>
			<text fg={colors().secondary}>{agents()}</text>
			<text fg={colors().secondary}>{bg()}</text>
			<box flexGrow={1} />
			<text fg={colors().secondary}>{cwdLabel()}</text>
		</box>
	);
}
