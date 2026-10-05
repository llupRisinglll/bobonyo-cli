/** @jsxImportSource @opentui/solid */
import {
	createTextAttributes,
	RGBA,
	type ScrollBoxRenderable,
} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createSignal, For} from 'solid-js';
import {ModalHeader, modalWheel} from './modal-header';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {wrapText} from '../text-wrap';

/**
 * First-run TRUST dialog (codex-inspired). A centered MODAL with explicit
 * Yes/No options — never the free-text prompt row, which read like the chat
 * input was ready. The directory is explained up front (read/write + run
 * commands), the title uses the WARNING color (a caution, not a chat
 * prompt), and Yes is the default like codex's `[Y/n]`. Esc/No declines
 * (the app must not run against an untrusted directory).
 */
export function TrustModal(props: {
	directory: string;
	onTrust: () => void;
	onDecline: () => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const [choice, setChoice] = createSignal<'yes' | 'no'>('yes');
	// AUTO-CLOSE GUARD: ignore the opening click's mouse-UP on the backdrop.
	// Time-window based, NOT a one-shot boolean — the flag got consumed by
	// the opening release and swallowed the first real outside click
	// (click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const cardWidth = () => Math.min(64, Math.max(1, dims().width - 2));
	const bodyInset = () => Math.min(1, Math.floor(cardWidth() / 3));
	const contentWidth = () => Math.max(1, cardWidth() - bodyInset() * 2 - 2);
	const explanation = () =>
		wrapText(
			'bobonyo can read and write files and run commands here:',
			contentWidth(),
		);
	const directory = () => wrapText(props.directory, contentWidth());
	const headerHeight = () => (dims().height >= 9 ? 3 : 1);
	const paddingY = () => (dims().height >= 12 ? 1 : 0);
	const cardHeight = () =>
		Math.min(
			headerHeight() +
				paddingY() * 2 +
				explanation().length +
				directory().length +
				4,
			Math.max(1, dims().height - (dims().height >= 9 ? 2 : 0)),
		);
	const explanationHeight = () =>
		Math.max(1, cardHeight() - headerHeight() - paddingY() * 2 - 3);
	let explanationScroll: ScrollBoxRenderable | undefined;
	const cardY = () =>
		Math.max(0, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();

	const confirm = (value: 'yes' | 'no'): void => {
		if (value === 'yes') props.onTrust();
		else props.onDecline();
	};

	const handleKey: Parameters<typeof useKeyboard>[0] = event => {
		event.preventDefault();
		if (event.name === 'pageup' || event.name === 'pagedown') {
			explanationScroll?.scrollBy(event.name === 'pageup' ? -1 : 1, 'viewport');
			return true;
		}
		if (event.name === 'up' || event.name === 'left') {
			setChoice('yes');
			return true;
		}
		if (event.name === 'down' || event.name === 'right') {
			setChoice('no');
			return true;
		}
		if (event.name === 'return') {
			confirm(choice());
			return true;
		}
		if (event.name === 'y') {
			confirm('yes');
			return true;
		}
		if (event.name === 'n') {
			confirm('no');
			return true;
		}
		if (event.name === 'escape') {
			// Esc = decline: the app must NOT keep running against an
			// untrusted directory.
			props.onDecline();
			return true;
		}
		// Every other key is owned by the dialog, nothing leaks to the chat.
		return true;
	};
	useKeyboard(handleKey);

	const optionRow = (value: 'yes' | 'no', label: string, key: string) => {
		const active = choice() === value;
		return (
			<box
				flexDirection="row"
				height={1}
				flexShrink={0}
				backgroundColor={active ? activeRow().bg : undefined}
				{...({
					onMouseMove: () => setChoice(value),
					onMouseUp: () => confirm(value),
				} as any)}
			>
				<text width={2} fg={active ? activeRow().fg : colors().secondary}>
					{active ? '❯' : ' '}
				</text>
				<text
					fg={active ? activeRow().fg : colors().text}
					attributes={active ? bold() : undefined}
				>
					{label}
				</text>
				<text width={2} />
				<text fg={colors().secondary} attributes={dim()}>
					{key}
				</text>
			</box>
		);
	};

	return (
		<box
			onMouseScroll={modalWheel(handleKey)}
			position="absolute"
			left={0}
			top={0}
			width={dims().width}
			height={dims().height}
			zIndex={3000}
			alignItems="center"
			paddingTop={cardY()}
			backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
			{...({
				onMouseUp: (event: {x?: number; y?: number}) => {
					if (isOpeningRelease()) return;
					if (
						typeof event.x === 'number' &&
						typeof event.y === 'number' &&
						!insideCard(event.x, event.y)
					) {
						props.onDecline();
					}
				},
			} as any)}
		>
			<box
				width={cardWidth()}
				height={cardHeight()}
				backgroundColor={colors().base}
				flexDirection="column"
				overflow="hidden"
			>
				<ModalHeader
					width={cardWidth()}
					title={'⚠ Trust this directory?'}
					hint={'Esc decline'}
					caps={dims().height >= 9}
					color={colors().warning}
				/>
				<box
					flexDirection="column"
					flexGrow={1}
					minHeight={0}
					overflow="hidden"
					paddingX={bodyInset()}
					paddingY={paddingY()}
				>
					<scrollbox
						height={explanationHeight()}
						flexShrink={0}
						paddingRight={2}
						ref={element => {
							explanationScroll = element;
						}}
						onMouseScroll={event => event.stopPropagation()}
					>
						<For each={explanation()}>
							{line => (
								<text
									height={1}
									flexShrink={0}
									wrapMode="none"
									fg={colors().text}
								>
									{line}
								</text>
							)}
						</For>
						<For each={directory()}>
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
					</scrollbox>
					{optionRow('yes', 'Yes, trust this directory', 'y')}
					{optionRow('no', 'No, do not trust', 'n')}
					<text
						height={1}
						flexShrink={0}
						wrapMode="none"
						fg={colors().secondary}
						attributes={dim()}
					>
						PgUp/PgDn read · ↑/↓ select · Esc decline
					</text>
				</box>
			</box>
		</box>
	);
}
