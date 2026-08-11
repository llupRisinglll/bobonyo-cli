/** @jsxImportSource @opentui/solid */
import {createTextAttributes} from '@opentui/core';
import {For} from 'solid-js';
import {colors} from '../theme';

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
		header: string;
		lines?: string[];
		headerFg?: string;
		lineFg?: string;
	}>;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	return (
		<For each={props.rows}>
			{(row) => (
				<box flexDirection="column">
					<text
						fg={row.headerFg ?? colors().primary}
						attributes={bold()}
					>
						{row.header}
					</text>
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
