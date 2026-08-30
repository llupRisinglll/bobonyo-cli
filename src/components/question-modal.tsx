/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';

export interface QuestionOption {
	label: string;
	description?: string;
}

export function QuestionModal(props: {
	header?: string;
	question: string;
	options: QuestionOption[];
	multiple?: boolean;
	onAnswer: (answer: string) => void;
	onCancel: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const [index, setIndex] = createSignal(0);
	const [custom, setCustom] = createSignal('');
	const [selected, setSelected] = createSignal<Set<number>>(new Set());
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const active = () => activeRowPalette(colors());
	const options = createMemo(() =>
		props.options.filter(option => option.label.trim()),
	);
	const cardWidth = () => Math.min(82, Math.max(52, dims().width - 8));
	const optionRows = () =>
		options().reduce(
			(total, option) => total + (option.description ? 2 : 1),
			0,
		);
	const cardHeight = () =>
		Math.min(dims().height - 2, Math.max(10, optionRows() + 9));
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const selectedAnswer = () => {
		if (custom().trim()) return custom().trim();
		if (props.multiple) {
			return [...selected()]
				.sort((left, right) => left - right)
				.map(selectedIndex => options()[selectedIndex]?.label)
				.filter(Boolean)
				.join(', ');
		}
		return options()[index()]?.label || '';
	};
	const submit = () => {
		const answer = selectedAnswer();
		if (answer) props.onAnswer(answer);
	};
	const toggleCurrent = () => {
		if (!props.multiple || options().length === 0) return;
		setCustom('');
		setSelected(previous => {
			const next = new Set(previous);
			if (next.has(index())) next.delete(index());
			else next.add(index());
			return next;
		});
	};
	usePaste((event: {bytes: Uint8Array}) => {
		setCustom(value => value + new TextDecoder().decode(event.bytes));
	});
	useKeyboard(event => {
		event.preventDefault();
		if (event.name === 'escape') return props.onCancel();
		if (event.name === 'return') return submit();
		if (event.name === 'up' && options().length > 0) {
			setCustom('');
			setIndex(value => (value - 1 + options().length) % options().length);
			return true;
		}
		if (event.name === 'down' && options().length > 0) {
			setCustom('');
			setIndex(value => (value + 1) % options().length);
			return true;
		}
		if (event.name === 'space' && props.multiple && !custom()) {
			toggleCurrent();
			return true;
		}
		if (isDeleteKey(event)) {
			setCustom(value => value.slice(0, -1));
			return true;
		}
		if (event.name === 'space') {
			setCustom(value => `${value} `);
			return true;
		}
		if (!event.ctrl && !event.meta && event.name.length === 1) {
			setCustom(value => value + event.name);
			return true;
		}
		return true;
	});
	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width={dims().width}
			height={dims().height}
			zIndex={3050}
			alignItems="center"
			paddingTop={cardY()}
			backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
		>
			<box
				width={cardWidth()}
				height={cardHeight()}
				backgroundColor={colors().base}
				border
				borderStyle="rounded"
				borderColor={colors().primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
			>
				<text fg={colors().primary} attributes={bold()}>
					{props.header || 'Question'}
				</text>
				<box height={1} />
				<text fg={colors().text}>{props.question}</text>
				<box height={1} />
				<For each={options()}>
					{(option, optionIndex) => {
						const focused = () => !custom() && optionIndex() === index();
						const checked = () => selected().has(optionIndex());
						return (
							<box
								height={option.description ? 2 : 1}
								flexDirection="column"
								backgroundColor={focused() ? active().bg : undefined}
								{...({
									onMouseMove: () => {
										setCustom('');
										setIndex(optionIndex());
									},
									onMouseUp: () => {
										if (props.multiple) toggleCurrent();
										else props.onAnswer(option.label);
									},
								} as any)}
							>
								<box height={1} flexDirection="row">
									<text
										width={4}
										fg={focused() ? active().fg : colors().secondary}
									>
										{props.multiple
											? checked()
												? '[x]'
												: '[ ]'
											: focused()
												? '❯'
												: ' '}
									</text>
									<text fg={focused() ? active().fg : colors().text}>
										{option.label}
									</text>
								</box>
								<Show when={option.description}>
									<text
										fg={focused() ? active().fg : colors().secondary}
										attributes={dim()}
									>
										{'    ' + option.description}
									</text>
								</Show>
							</box>
						);
					}}
				</For>
				<box height={1} />
				<text fg={custom() ? colors().primary : colors().secondary}>
					Custom: {custom()}▌
				</text>
				<box flexGrow={1} />
				<text fg={colors().secondary} attributes={dim()}>
					{props.multiple
						? '↑/↓ move · Space toggle · Enter answer · type custom · Esc cancel'
						: '↑/↓ select · type custom · Enter answer · Esc cancel'}
				</text>
			</box>
		</box>
	);
}
