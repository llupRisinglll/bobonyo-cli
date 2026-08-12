/** @jsxImportSource @opentui/solid */
import {createTextAttributes} from '@opentui/core';
import {For, Show} from 'solid-js';
import type {LiveRowSegments} from '../live-tool-row';
import {colors} from '../theme';
import {glyphBlinkOn, spinnerFrame} from '../state';

/**
 * FOOLPROOF live tool-row renderer — the ONLY way running tool rows render.
 *
 * Every row is tokenized ONCE per throttled update by `liveRowSegments` with
 * the SAME tokenizers the settled rows use, then rendered here as PLAIN
 * text cells (never `<markdown>`): OpenTUI repaints only the cells that
 * changed. The old markdown path re-parsed the whole node per update, which
 * was the flicker. The glyph is a separate blinking cell so blink frames
 * never re-tokenize anything.
 *
 * Spacing parity: each row renders a leading BREAKLINE (blank row), exactly
 * like the settled transcript's blank rows between blocks, so the live
 * layout is identical while running and when done.
 *
 * This component deliberately imports NO markdown element. A developer who
 * needs a different live row must change THIS file, and the regression
 * guards in `regression-guards.spec.ts` fail the build if it ever does.
 */
export function LiveToolRows(props: {rows: LiveRowSegments[]}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	return (
		<For each={props.rows}>
			{(row) => (
				<box flexDirection="column">
					{/* Leading breakline: parity with the settled blank rows
					    between blocks (user msg → blank → tool row). */}
					<box height={1} />
					<box flexDirection="row">
						{/* Blinking secondary glyph, width-stable (the hidden
						    frame keeps a space). */}
						<text
							fg={colors().secondary}
							attributes={dim()}
						>
							{glyphBlinkOn(spinnerFrame()) ? '✦' : ' '}{' '}
						</text>
						<For each={row.header}>
							{(c) => (
								<text
									fg={c.fg as never}
									attributes={c.attributes}
								>
									{c.text}
								</text>
							)}
						</For>
					</box>
					<For each={row.body}>
						{(line) => (
							<box flexDirection="row">
								<For each={line}>
									{(c) => (
										<text
											fg={c.fg as never}
											attributes={c.attributes}
										>
											{c.text}
										</text>
									)}
								</For>
							</box>
						)}
					</For>
				</box>
			)}
		</For>
	);
}
