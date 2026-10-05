/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, usePaste, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {loadPreferences} from '../config';
import {ModalHeader, modalWheel} from './modal-header';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {isDeleteKey} from '../input-keys';
import {SUBAGENT_TYPES} from '../tools';
import {
	deleteSubagent,
	loadSubagents,
	saveSubagentModel,
	subagentModel,
	type Subagent,
} from '../subagents';
import {DetailsModal} from './details-modal';
import {ModelModal, type ModelProvider} from './model-modal';

interface AgentEntry {
	name: string;
	label: string;
	description: string;
	model?: string;
	source: Subagent['source'] | 'built-in';
	systemPrompt?: string;
	deletable: boolean;
}

/** Agent manager shared by `/agents` and Settings → Capabilities → Agents. */
export function AgentsModal(props: {
	onClose: () => void;
	providers: ModelProvider[];
	currentProvider: string;
	currentModel: string;
	onConnectProvider: () => void;
	onChanged?: (message: string) => void;
}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const [query, setQuery] = createSignal('');
	const [version, setVersion] = createSignal(0);
	const [index, setIndex] = createSignal(0);
	const [detail, setDetail] = createSignal<AgentEntry | null>(null);
	const [modelAgent, setModelAgent] = createSignal<AgentEntry | null>(null);
	const [confirmingDelete, setConfirmingDelete] =
		createSignal<AgentEntry | null>(null);
	usePaste((event: {bytes: Uint8Array}) => {
		if (!modelAgent() && !confirmingDelete()) {
			setQuery(prev => prev + new TextDecoder().decode(event.bytes));
		}
	});
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;
	const cardWidth = () => Math.min(84, Math.max(1, dims().width - 2));
	const cardHeight = () =>
		Math.min(24, Math.max(1, dims().height - (dims().height >= 9 ? 2 : 0)));
	const cardY = () =>
		Math.max(0, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);
	const entries = createMemo<AgentEntry[]>(() => {
		version();
		const builtIn: AgentEntry[] = Object.entries(SUBAGENT_TYPES).map(
			([name, agent]) => ({
				name,
				label: agent.label,
				description: agent.instruction,
				model: subagentModel(name),
				source: 'built-in',
				deletable: false,
			}),
		);
		const discovered: AgentEntry[] = loadSubagents().map(agent => ({
			name: agent.name,
			label: agent.title ?? agent.name,
			description: agent.description,
			model: subagentModel(agent.name),
			source: agent.source,
			systemPrompt: agent.systemPrompt,
			deletable: true,
		}));
		const merged = new Map<string, AgentEntry>();
		for (const entry of [...builtIn, ...discovered]) {
			merged.set(entry.name.toLowerCase(), entry);
		}
		const q = query().trim().toLowerCase();
		return [...merged.values()]
			.filter(
				entry =>
					!q ||
					entry.name.toLowerCase().includes(q) ||
					entry.label.toLowerCase().includes(q) ||
					entry.description.toLowerCase().includes(q),
			)
			.sort((a, b) => a.name.localeCompare(b.name));
	});
	const selectedProvider = (): string => {
		const entry = modelAgent();
		return entry
			? (loadPreferences().agentProviders?.[entry.name.toLowerCase()] ??
					props.currentProvider)
			: props.currentProvider;
	};
	const selectedModel = (): string => modelAgent()?.model ?? props.currentModel;
	// Mount next event-loop turn. OpenTUI broadcasts one key event to all
	// listeners; mounting sooner lets opening Enter replay through model and
	// effort steps, selecting and closing without user input.
	const openModelSelector = (entry: AgentEntry): void => {
		queueMicrotask(() => setModelAgent(entry));
	};

	const handleKey: Parameters<typeof useKeyboard>[0] = event => {
		if (detail() || modelAgent()) return;
		if (confirmingDelete()) {
			if (event.name.toLowerCase() === 'y') {
				const entry = confirmingDelete()!;
				if (deleteSubagent(entry.name)) {
					props.onChanged?.(`Agent '${entry.name}' deleted`);
					setVersion(prev => prev + 1);
					setIndex(prev => Math.max(0, Math.min(prev, entries().length - 1)));
				}
				setConfirmingDelete(null);
			} else if (event.name.toLowerCase() === 'n' || event.name === 'escape') {
				setConfirmingDelete(null);
			}
			return;
		}
		if (event.name === 'escape') {
			props.onClose();
			return;
		}
		if (event.name === 'up' || event.name === 'down') {
			const count = entries().length;
			setIndex(prev =>
				event.name === 'down'
					? Math.min(count - 1, prev + 1)
					: Math.max(0, prev - 1),
			);
			return;
		}
		const entry = entries()[index()];
		if (event.name === 'return' && entry) {
			openModelSelector(entry);
			return;
		}
		if (
			event.shift &&
			event.name.toLowerCase() === 'v' &&
			entry?.systemPrompt
		) {
			setDetail(entry);
			return;
		}
		if (event.shift && event.name.toLowerCase() === 'd' && entry?.deletable) {
			setConfirmingDelete(entry);
			return;
		}
		if (isDeleteKey(event)) {
			setQuery(prev => prev.slice(0, -1));
			setIndex(0);
			return;
		}
		if (event.name === 'space' && !event.ctrl && !event.meta) {
			setQuery(prev => prev + ' ');
			setIndex(0);
			return;
		}
		const char = event.name;
		if (char && char.length === 1 && !event.ctrl && !event.meta) {
			setQuery(prev => prev + char);
			setIndex(0);
		}
	};
	useKeyboard(handleKey);
	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();

	return (
		<Show
			when={!detail()}
			fallback={
				<DetailsModal
					title={detail()!.label}
					content={detail()!.systemPrompt ?? ''}
					onClose={() => setDetail(null)}
				/>
			}
		>
			<Show
				when={!modelAgent()}
				fallback={
					<ModelModal
						title={`Select model for ${modelAgent()!.label}`}
						providers={props.providers}
						currentProvider={selectedProvider()}
						currentModel={selectedModel()}
						onSelect={(providerId, model) => {
							const entry = modelAgent();
							if (!entry) return;
							saveSubagentModel(entry.name, model, providerId);
							props.onChanged?.(
								`${entry.label} model: ${model} · ${providerId}`,
							);
							setTimeout(() => setModelAgent(null), 0);
							setVersion(prev => prev + 1);
						}}
						onConnectProvider={props.onConnectProvider}
						onClose={() => setModelAgent(null)}
						hasMessages={false}
						nestedReturnGuardMs={150}
						inheritLabel="Inherit main agent model"
						onInherit={() => {
							const entry = modelAgent();
							if (!entry) return;
							saveSubagentModel(entry.name);
							props.onChanged?.(`${entry.label} model: inherit`);
							setTimeout(() => setModelAgent(null), 0);
							setVersion(prev => prev + 1);
						}}
					/>
				}
			>
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
							)
								props.onClose();
						},
					} as any)}
				>
					<box
						width={cardWidth()}
						height={cardHeight()}
						backgroundColor={colors().base}
						overflow="hidden"
					>
						<ModalHeader
							width={cardWidth()}
							title={confirmingDelete() ? 'Delete agent' : 'Agents'}
							hint={`⌕ ${query() || 'search…'}`}
							caps={dims().height >= 9}
						/>
						<box
							flexDirection="column"
							flexGrow={1}
							minHeight={0}
							overflow="hidden"
							paddingX={Math.min(1, Math.floor(cardWidth() / 3))}
							paddingY={dims().height >= 9 ? 1 : 0}
						>
							<Show
								when={!confirmingDelete()}
								fallback={
									<box flexDirection="column">
										<text fg={colors().text}>
											Delete "{confirmingDelete()?.label}"? This removes its
											markdown file and cannot be undone.
										</text>
										<box height={1} />
										<text fg={colors().secondary} attributes={dim()}>
											(y) delete · (n) cancel
										</text>
									</box>
								}
							>
								<box height={1} />
								<For
									each={entries()
										.slice(
											Math.max(0, index() - Math.max(1, cardHeight() - 9) + 1),
											Math.max(0, index() - Math.max(1, cardHeight() - 9) + 1) +
												Math.max(1, cardHeight() - 9),
										)
										.map(entry => ({
											entry,
											active: entries().indexOf(entry) === index(),
										}))}
								>
									{({entry, active}) => (
										<box
											flexDirection="row"
											height={1}
											backgroundColor={active ? activeRow().bg : undefined}
											{...({
												onMouseMove: () => setIndex(entries().indexOf(entry)),
												onMouseUp: () => setModelAgent(entry),
											} as any)}
										>
											<text
												fg={active ? activeRow().fg : colors().text}
												attributes={bold()}
											>
												{active ? '❯ ' : '  '}
												{entry.label}
											</text>
											<text fg={active ? activeRow().fg : colors().secondary}>
												{' '}
												· {entry.model ?? 'inherit'}
											</text>
											<box flexGrow={1} />
											<text fg={colors().secondary} attributes={dim()}>
												{entry.source}
											</text>
										</box>
									)}
								</For>
								<Show when={entries().length === 0}>
									<text fg={colors().secondary} attributes={dim()}>
										No agents match.
									</text>
								</Show>
								<box height={1} />
								<text fg={colors().secondary} attributes={dim()}>
									↑/↓ select · Enter model · V view prompt · D delete custom ·
									Esc close
								</text>
							</Show>
						</box>
					</box>
				</box>
			</Show>
		</Show>
	);
}
