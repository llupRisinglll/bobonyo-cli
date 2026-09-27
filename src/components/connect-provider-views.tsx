/** @jsxImportSource @opentui/solid */
import {createTextAttributes} from '@opentui/core';
import {createMemo, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {spinnerFrame} from '../state';

export function PromptField(props: {
	value: () => string;
	error?: () => string | undefined;
	secret?: boolean;
	placeholder?: string;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	// Input-box caret parity: the cell under the cursor blinks (400ms) via
	// the shared spinnerFrame; the caret char is ALWAYS rendered (the last
	// char, or a space on an empty/placeholder line) so the line width never
	// shifts when it blinks.
	const cursorVisible = () => (spinnerFrame() >> 2) % 2 === 0;
	// REACTIVE reads: the parent passes the input SIGNAL accessor, never a
	// plain value — the field sits inside a nested <Show fallback> that only
	// rebuilds on view changes, so a plain `value={input()}` prop would
	// freeze the display (typing worked but stayed invisible). Memos track
	// the accessor and repaint every keystroke/backspace.
	const shown = createMemo(() => {
		const value = props.value();
		return props.secret && value.length > 0
			? '•'.repeat(Math.min(24, value.length))
			: value;
	});
	const filled = createMemo(() => shown().length > 0);
	// Input-box caret parity: an EMPTY field shows the blinking box at the
	// START (before the dimmed placeholder); typing puts the caret at the
	// END over the last char. The caret cell is always rendered so the line
	// width never shifts while it blinks.
	const caretChar = createMemo(() =>
		filled() ? shown()[shown().length - 1]! : ' ',
	);
	const valueText = createMemo(() => (filled() ? shown().slice(0, -1) : ''));
	return (
		<box flexDirection="column">
			<box
				border
				borderStyle="rounded"
				borderColor={colors().secondary}
				paddingX={1}
				height={3}
			>
				{/* Placeholder INSIDE the field (dimmed) when empty — the hint
				    never rides below the input; the caret blinks like the
				    chat input box. */}
				<box flexDirection="row">
					{/* Caret FIRST when empty (the box sits before the
					    placeholder, like an empty chat input). */}
					<Show when={!filled()}>
						<text
							bg={cursorVisible() ? activeRow().bg : undefined}
							fg={cursorVisible() ? activeRow().fg : colors().secondary}
							attributes={dim()}
						>
							{caretChar()}
						</text>
					</Show>
					<text
						fg={filled() ? colors().text : colors().secondary}
						attributes={filled() ? undefined : dim()}
					>
						{valueText()}
						{!filled() ? (props.placeholder ?? '') : ''}
					</text>
					<Show when={filled()}>
						<text
							bg={cursorVisible() ? activeRow().bg : undefined}
							fg={cursorVisible() ? activeRow().fg : colors().text}
						>
							{caretChar()}
						</text>
					</Show>
				</box>
			</box>
			<Show when={props.error?.()}>
				<box height={1} />
				<text fg={colors().warning} attributes={bold()}>
					{props.error?.()}
				</text>
			</Show>
			<box flexGrow={1} />
			<text fg={colors().secondary} attributes={dim()}>
				Enter submit · Esc back
			</text>
		</box>
	);
}

export function MethodList(props: {
	methods: Array<{id: 'account' | 'api'; label: string; detail: string}>;
	index: () => number;
	onMove: (next: number) => void;
	onSelect: (index: number) => void;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	return (
		<box flexDirection="column">
			<For
				each={(() => {
					const sel = props.index();
					return props.methods.map((method, idx) => ({
						method,
						active: idx === sel,
					}));
				})()}
			>
				{({method, active}) => (
					<box
						flexDirection="row"
						height={1}
						backgroundColor={active ? activeRow().bg : undefined}
						{...({
							onMouseMove: () => props.onMove(props.methods.indexOf(method)),
							onMouseUp: () => props.onSelect(props.methods.indexOf(method)),
						} as any)}
					>
						<text
							fg={active ? activeRow().fg : colors().text}
							attributes={bold()}
						>
							{active ? '❯ ' : '  '}
							{method.label}
						</text>
						<box flexGrow={1} />
						<text fg={colors().secondary} attributes={dim()}>
							{method.detail}
						</text>
					</box>
				)}
			</For>
			<box flexGrow={1} />
			<text fg={colors().secondary} attributes={dim()}>
				↑/↓ select · Enter choose · Esc back
			</text>
		</box>
	);
}

export function ManageList(props: {
	presetTitle: string;
	rows: Array<{id: string; baseUrl: string} | null>;
	index: () => number;
	onMove: (next: number) => void;
	onSelect: (index: number) => void;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	return (
		<box flexDirection="column">
			<For
				each={(() => {
					const sel = props.index();
					return props.rows.map((row, idx) => ({
						row,
						active: idx === sel,
					}));
				})()}
			>
				{({row, active}) => (
					<box
						flexDirection="row"
						height={1}
						backgroundColor={active ? activeRow().bg : undefined}
						{...({
							onMouseMove: () => props.onMove(props.rows.indexOf(row)),
							onMouseUp: () => props.onSelect(props.rows.indexOf(row)),
						} as any)}
					>
						<text
							fg={active ? activeRow().fg : colors().text}
							attributes={bold()}
						>
							{active ? '❯ ' : '  '}
							{row ? row.id : `Connect a new ${props.presetTitle}`}
						</text>
						<box flexGrow={1} />
						<text fg={colors().secondary} attributes={dim()}>
							{row ? `${row.baseUrl} · edit` : ''}
						</text>
					</box>
				)}
			</For>
			<box flexGrow={1} />
			<text fg={colors().secondary} attributes={dim()}>
				↑/↓ select · Enter edit · d delete · Esc back
			</text>
		</box>
	);
}

export function ChatgptView(props: {
	authTick: number;
	authSummary: string | null;
	loggedIn: boolean;
	onCheckAgain: () => void;
}) {
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	void props.authTick;
	return (
		<box flexDirection="column">
			<Show
				when={props.loggedIn}
				fallback={
					<box flexDirection="column">
						<text fg={colors().text}>
							Run `codex login` in another terminal, then check again. bobonyo
							uses the credentials it writes to ~/.codex/auth.json.
						</text>
						<box flexGrow={1} />
						<text fg={colors().secondary} attributes={dim()}>
							Enter check again · Esc back
						</text>
					</box>
				}
			>
				<box flexDirection="column">
					<text fg={colors().success} attributes={bold()}>
						✓ {props.authSummary}
					</text>
					<box height={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Uses your ChatGPT account through the Codex backend.
					</text>
					<box flexGrow={1} />
					<text fg={colors().secondary} attributes={dim()}>
						Enter connect · Esc back
					</text>
				</box>
			</Show>
		</box>
	);
}
