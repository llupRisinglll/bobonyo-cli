/** @jsxImportSource @opentui/solid */
import {createTextAttributes, RGBA} from '@opentui/core';
import {useKeyboard, useTerminalDimensions} from '@opentui/solid';
import {createMemo, createSignal, For, Show} from 'solid-js';
import {colors} from '../theme';
import {activeRowPalette} from '../row-highlight';
import {SUBAGENT_TYPES} from '../tools';
import {loadSubagents, type Subagent} from '../subagents';
import {DetailsModal} from './details-modal';

interface AgentEntry {
	name: string;
	label: string;
	description: string;
	model?: string;
	source: Subagent['source'] | 'built-in';
	systemPrompt?: string;
}

/**
 * AGENTS modal (parity: nanocoder's `/agents` + subagent-loader): lists every
 * discoverable subagent — built-in personalities (General / Explore), user
 * agents (`~/.config/bobonyo/agents/`) and PROJECT agents
 * (`.bobonyo/agents/`, e.g. review-api, hilinga-marketing-integrator…).
 * Searchable with ↑/↓/Enter; Enter opens the full system prompt. The actual
 * spawning stays with the `agent` tool, which resolves the same discovered
 * prompt when the model delegates.
 */
export function AgentsModal(props: {onClose: () => void}) {
	const terminalDimensions = useTerminalDimensions();
	const dims = () => terminalDimensions();
	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	const activeRow = () => activeRowPalette(colors());
	const [query, setQuery] = createSignal('');
	// AUTO-CLOSE GUARD: modals opened by a row click receive the SAME
	// click's mouse-UP on the backdrop, which would close them instantly.
	// Only that opening release is ignored — a time window, NOT a one-shot
	// boolean (the flag got consumed by the opening release and swallowed
	// the user's first real outside click: click-twice-to-close).
	const mountedAt = Date.now();
	const isOpeningRelease = () => Date.now() - mountedAt < 400;

	const [index, setIndex] = createSignal(0);
	const [detail, setDetail] = createSignal<AgentEntry | null>(null);

	const cardWidth = () => Math.min(84, Math.max(60, dims().width - 6));
	const cardHeight = () => {
		const available = Math.max(10, dims().height - 2);
		return Math.min(24, available);
	};
	const cardY = () =>
		Math.max(1, Math.floor((dims().height - cardHeight()) / 2));
	const cardX = () => Math.floor((dims().width - cardWidth()) / 2);

	const entries = createMemo<AgentEntry[]>(() => {
		const builtIn: AgentEntry[] = Object.entries(SUBAGENT_TYPES).map(
			([name, agent]) => ({
				name,
				label: agent.label,
				description: agent.instruction,
				source: 'built-in',
			}),
		);
		const discovered: AgentEntry[] = loadSubagents().map(agent => ({
			name: agent.name,
			label: agent.title ?? agent.name,
			description: agent.description,
			model: agent.model && agent.model !== 'inherit' ? agent.model : undefined,
			source: agent.source,
			systemPrompt: agent.systemPrompt,
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

	useKeyboard(event => {
		if (detail()) {
			// The details modal owns its own keys; Esc closes back.
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
		if (event.name === 'return') {
			const entry = entries()[index()];
			if (entry?.systemPrompt) {
				setDetail(entry);
			}
			return;
		}
		if (event.name === 'backspace') {
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
	});

	const insideCard = (x: number, y: number): boolean =>
		x >= cardX() &&
		x <= cardX() + cardWidth() &&
		y >= cardY() &&
		y <= cardY() + cardHeight();

	return (
		<Show when={!detail()} fallback={<DetailsModal title={detail()!.label} content={detail()!.systemPrompt ?? ''} onClose={() => setDetail(null)} />}>
			<box
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
							props.onClose();
						}
					},
				} as any)}
			>
				<box
					width={cardWidth()}
					backgroundColor={colors().base}
					paddingX={2}
					paddingY={1}
				>
					<box flexDirection="row" height={1}>
						<text fg={colors().primary} attributes={bold()}>
							Agents
						</text>
						<box flexGrow={1} />
						<text fg={colors().secondary} attributes={dim()}>
							⌕ {query() || 'search…'}
						</text>
					</box>
					<box height={1} />
					<For each={entries()}>
						{(entry, i) => (
							<box
								flexDirection="row"
								height={1}
								backgroundColor={
									index() === i()
										? activeRow().bg
										: undefined
								}
								{...({
									onMouseMove: () => setIndex(i()),
									onMouseUp: () => {
										if (entry.systemPrompt) setDetail(entry);
									},
								} as any)}
							>
								<text
									fg={index() === i() ? activeRow().fg : colors().text}
									attributes={bold()}
								>
									{index() === i() ? '❯ ' : '  '}
									{entry.label}
								</text>
								<text fg={colors().secondary}>
									{' · '}
									{entry.model ?? 'inherit'}
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
						↑/↓ select · Enter view prompt · Esc close
					</text>
				</box>
			</box>
		</Show>
	);
}
