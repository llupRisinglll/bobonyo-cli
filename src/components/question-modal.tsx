/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {wrapQuestionText} from './question-modal-wrap';

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
	const [editing, setEditing] = createSignal(false);
	const [selected, setSelected] = createSignal<Set<number>>(new Set());
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const active = () => activeRowPalette(colors());
	const options = createMemo(() =>
		props.options.filter(option => option.label.trim()),
	);
	const cardWidth = () =>
		Math.max(1, Math.min(82, dims().width - (dims().width >= 60 ? 8 : 2)));
	const paddingX = () => (cardWidth() >= 16 ? 2 : 0);
	const paddingY = () => (dims().height >= 12 ? 1 : 0);
	// Both border columns and both horizontal padding insets consume cells.
	const contentWidth = () => Math.max(1, cardWidth() - 2 - paddingX() * 2);
	const questionRows = createMemo(() =>
		wrapQuestionText(props.question, contentWidth()),
	);
	const customRows = createMemo(() =>
		editing()
			? wrapQuestionText(
					`Custom: ${custom() || 'Type your answer…'}▌`,
					contentWidth(),
				)
			: [],
	);
	const footerRows = createMemo(() =>
		wrapQuestionText(
			editing()
				? contentWidth() < 50
					? 'Enter send · Esc back'
					: 'Enter answer · Esc back · type your answer'
				: contentWidth() < 50 || dims().height < 12
					? 'Enter · Esc'
					: props.multiple
						? '↑/↓ move · Space toggle · Enter answer · type custom · Esc cancel'
						: '↑/↓ select · type custom · Enter answer · Esc cancel',
			contentWidth(),
		),
	);
	const optionRows = () =>
		options().reduce(
			(total, option) => total + (option.description ? 2 : 1),
			0,
		);
	const customFocused = () => !editing() && index() === options().length;
	const bodyHeight = () => optionRows() + questionRows().length + 5;
	const cardHeight = () =>
		Math.max(
			1,
			Math.min(
				dims().height - (dims().height >= 12 ? 2 : 0),
				bodyHeight() +
					customRows().length +
					footerRows().length +
					2 +
					paddingY() * 2,
			),
		);
	const availableHeight = () =>
		Math.max(0, cardHeight() - 2 - paddingY() * 2 - footerRows().length);
	const customHeight = () =>
		Math.min(
			customRows().length,
			Math.max(
				1,
				availableHeight() -
					Math.min(bodyHeight(), Math.floor(availableHeight() / 2)),
			),
		);
	const visibleCustomRows = () => customRows().slice(-customHeight());
	const visibleBodyHeight = () =>
		Math.max(0, availableHeight() - customHeight());
	const bodyOffset = createMemo(() => {
		if (editing()) return 0;
		const focusedRow =
			questionRows().length +
			3 +
			options()
				.slice(0, index())
				.reduce((total, option) => total + (option.description ? 2 : 1), 0);
		const focusedHeight = options()[index()]?.description ? 2 : 1;
		// Keep the selected label visible even when its description cannot fit.
		return Math.max(
			0,
			Math.min(focusedRow, focusedRow + focusedHeight - visibleBodyHeight()),
		);
	});
	const cardY = () =>
		Math.max(0, Math.floor((dims().height - cardHeight()) / 2));
	const selectedAnswer = () => {
		if (editing()) return custom().trim();
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
		if (!editing() && index() === options().length) return setEditing(true);
		const answer = selectedAnswer();
		if (answer) props.onAnswer(answer);
	};
	const toggleCurrent = () => {
		if (!props.multiple || options().length === 0) return;
		setSelected(previous => {
			const next = new Set(previous);
			if (next.has(index())) next.delete(index());
			else next.add(index());
			return next;
		});
	};
	usePaste((event: {bytes: Uint8Array}) => {
		setIndex(options().length);
		setEditing(true);
		setCustom(value => value + new TextDecoder().decode(event.bytes));
	});
	useKeyboard(event => {
		event.preventDefault();
		if (event.name === 'escape') {
			if (editing()) return setEditing(false);
			return props.onCancel();
		}
		if (event.name === 'return') return submit();
		if (event.name === 'up' && !editing()) {
			setIndex(value => (value + options().length) % (options().length + 1));
			return true;
		}
		if (event.name === 'down' && !editing()) {
			setIndex(value => (value + 1) % (options().length + 1));
			return true;
		}
		if (
			event.name === 'space' &&
			props.multiple &&
			!editing() &&
			index() < options().length
		) {
			toggleCurrent();
			return true;
		}
		if (isDeleteKey(event)) {
			if (editing()) setCustom(value => value.slice(0, -1));
			return true;
		}
		if (event.name === 'space') {
			setIndex(options().length);
			setEditing(true);
			setCustom(value => `${value} `);
			return true;
		}
		if (!event.ctrl && !event.meta && event.name.length === 1) {
			setIndex(options().length);
			setEditing(true);
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
				paddingX={paddingX()}
				paddingY={paddingY()}
				flexDirection="column"
				flexShrink={0}
				overflow="hidden"
			>
				<box
					height={visibleBodyHeight()}
					flexShrink={0}
					overflow="hidden"
					flexDirection="column"
				>
					<box
						position="absolute"
						top={-bodyOffset()}
						width={contentWidth()}
						height={bodyHeight()}
						flexShrink={0}
						flexDirection="column"
					>
						<text
							height={1}
							wrapMode="none"
							fg={colors().primary}
							attributes={bold()}
						>
							{props.header || 'Question'}
						</text>
						<box height={1} />
						<For each={questionRows()}>
							{line => (
								<text height={1} wrapMode="none" fg={colors().text}>
									{line || ' '}
								</text>
							)}
						</For>
						<box height={1} />
						<For each={options()}>
							{(option, optionIndex) => {
								const focused = () => !editing() && optionIndex() === index();
								const checked = () => selected().has(optionIndex());
								return (
									<box
										height={option.description ? 2 : 1}
										flexDirection="column"
										backgroundColor={focused() ? active().bg : undefined}
										{...({
											onMouseMove: () => {
												if (editing()) return;
												setIndex(optionIndex());
											},
											onMouseUp: () => {
												if (editing()) return;
												setIndex(optionIndex());
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
						<box
							height={1}
							flexDirection="row"
							backgroundColor={customFocused() ? active().bg : undefined}
							onMouseMove={() => {
								if (!editing()) setIndex(options().length);
							}}
							onMouseUp={() => {
								setIndex(options().length);
								setEditing(true);
							}}
						>
							<text
								width={4}
								fg={customFocused() ? active().fg : colors().secondary}
							>
								{customFocused() ? '❯' : ' '}
							</text>
							<text
								wrapMode="none"
								fg={customFocused() ? active().fg : colors().text}
							>
								Custom answer…
							</text>
						</box>
						<box height={1} />
					</box>
				</box>
				<For each={visibleCustomRows()}>
					{line => (
						<text
							height={1}
							flexShrink={0}
							wrapMode="none"
							fg={custom() ? colors().primary : colors().secondary}
						>
							{line || ' '}
						</text>
					)}
				</For>
				<For each={footerRows()}>
					{line => (
						<text
							height={1}
							flexShrink={0}
							wrapMode="none"
							fg={colors().secondary}
							attributes={dim()}
						>
							{line}
						</text>
					)}
				</For>
			</box>
		</box>
	);
}
