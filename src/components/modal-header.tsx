/** @jsxImportSource @opentui/solid */
import {
	createTextAttributes,
	type KeyEvent,
	type MouseEvent,
} from '@opentui/core';
import {Show} from 'solid-js';
import {colors} from '../theme';

/** Shared half-cell title bar. The parent owns viewport and body geometry. */
export function ModalHeader(props: {
	title: string;
	width: number;
	hint?: string;
	caps?: boolean;
	color?: string;
}) {
	const inset = () => Math.min(1, Math.floor(props.width / 3));
	const available = () => Math.max(1, props.width - inset() * 2);
	const hint = () =>
		props.hint && available() >= props.title.length + props.hint.length + 1
			? props.hint
			: '';
	const color = () => props.color ?? colors().primary;
	return (
		<box flexDirection="column" flexShrink={0}>
			<Show when={props.caps !== false}>
				<text
					height={1}
					flexShrink={0}
					fg={color()}
					bg={colors().base}
					wrapMode="none"
				>
					{'▄'.repeat(props.width)}
				</text>
			</Show>
			<box
				height={1}
				flexShrink={0}
				flexDirection="row"
				backgroundColor={color()}
				overflow="hidden"
			>
				<box width={inset()} />
				<text
					fg={colors().base}
					attributes={createTextAttributes({bold: true})}
					width={Math.max(1, available() - hint().length - (hint() ? 1 : 0))}
					wrapMode="none"
				>
					{props.title}
				</text>
				<Show when={hint()}>
					<box width={1} />
					<text fg={colors().base} flexShrink={0} wrapMode="none">
						{hint()}
					</text>
				</Show>
				<box width={inset()} />
			</box>
			<Show when={props.caps !== false}>
				<text
					height={1}
					flexShrink={0}
					fg={color()}
					bg={colors().base}
					wrapMode="none"
				>
					{'▀'.repeat(props.width)}
				</text>
			</Show>
		</box>
	);
}

/** Wheel and arrows share navigation, including each picker's focus rules. */
export function modalWheel(handleKey: (event: KeyEvent) => unknown) {
	return (event: MouseEvent) => {
		event.stopPropagation();
		const name = event.scroll?.direction;
		if (name !== 'up' && name !== 'down') return;
		handleKey({
			name,
			ctrl: false,
			meta: false,
			shift: false,
			preventDefault() {},
			stopPropagation() {},
		} as KeyEvent);
	};
}
