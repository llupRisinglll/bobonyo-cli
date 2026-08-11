/** @jsxImportSource @opentui/solid */
import {createTextAttributes} from '@opentui/core';
import {For} from 'solid-js';
import {colors} from '../theme';
import {glyphBlinkOn, spinnerFrame} from '../state';

/**
 * FOOLPROOF live streaming rows. Streaming content rendered through OpenTUI's
 * `<markdown>` re-parses the whole node on every update, which repaints the
 * block and reads as flicker ("christmas lights"). This util renders each
 * line as a PLAIN `<text>` element, so OpenTUI only repaints the cells that
 * actually changed, never the whole block. Use it for ANY live/streaming
 * content (thinking, running tool rows, background tails).
 */
export function LiveStreamRows(props: {
	rows: Array<{
		/** Leading status glyph (`✦`/`⚙`), rendered SECONDARY (never primary). */
		glyph?: string;
		/** Blink the glyph on the 500ms cadence (running rows, parity ToolGlyph). */
		glyphBlink?: boolean;
		glyphFg?: string;
		/** Tool name, primary bold (parity: settled `✦ Name(detail)`). */
		name?: string;
		/** Detail, secondary, rendered inside parens like settled rows. */
		detail?: string;
		/** Fallback full header when `name` is absent (primary bold). */
		header?: string;
		headerFg?: string;
		lines?: string[];
		lineFg?: string;
	}>;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	return (
		<For each={props.rows}>
			{(row) => (
				<box flexDirection="column">
					<box flexDirection="row">
						{row.glyph ? (
							// The glyph cell ALWAYS renders (a space when the
							// blink is off) so the row width never shifts.
							<text
								fg={row.glyphFg ?? colors().secondary}
								attributes={dim()}
							>
								{row.glyphBlink === false ||
								glyphBlinkOn(spinnerFrame())
									? row.glyph
									: ' '}{' '}
							</text>
						) : null}
						{row.name ? (
							<>
								<text fg={colors().primary} attributes={bold()}>
									{row.name}
								</text>
								<text fg={colors().secondary}>
									{row.detail ? `(${row.detail})` : ''}
								</text>
							</>
						) : (
							<text
								fg={row.headerFg ?? colors().primary}
								attributes={bold()}
							>
								{row.header}
							</text>
						)}
					</box>
					<For each={row.lines ?? []}>
						{(line) => (
							<text
								fg={row.lineFg ?? colors().secondary}
								attributes={dim()}
							>
								{line}
							</text>
						)}
					</For>
				</box>
			)}
		</For>
	);
}
