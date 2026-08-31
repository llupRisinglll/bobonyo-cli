import {runHooks} from './hooks';
import {createMemo, createSignal} from 'solid-js';
import type {ChatMessageLike} from './client';
import type {PendingWorkItem} from './background-notification';
import type {Mode, ResumeCwdMode, ThinkingMode, ToolProfile} from './settings';

export interface ChatMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	/**
	 * REAL attachment paths (image/text) that produced the `[Image #N]` /
	 * `[Text #N]` tokens in this user message. The history tokenizer only
	 * highlights tokens that are ACTUALLY in this map, so a manually typed
	 * `[Image #1]` never gets colored.
	 */
	attachments?: Record<string, string>;
	running?: boolean;
	error?: string;
	/** Reasoning text that preceded this assistant message (Thought UI). */
	reasoning?: string;
	/** Wall-clock seconds the thinking phase took (settled Thought header). */
	durationSec?: number;
	/** Info/notice rows (empty-turn retries, system notes) render dim. */
	kind?: 'info' | 'warning';
	/**
	 * Structured tool-call metadata so the history renderer can group
	 * same-family calls into compact blocks (and expand them per-call).
	 */
	tool?: {
		name: string;
		detail: string;
		output: string;
		/** Raw call arguments (file previews diff old/new from these). */
		args?: Record<string, unknown>;
	};
	/** Per-call stats for the agent/tool stats footer (looks parity). */
	toolStats?: {durationSec?: number; toolCalls?: number};
	/** Tool-call id for live output updates (running rows). */
	toolId?: string;
	/**
	 * The model's pre-tool BRIEF ("I'll check X") attached to the FIRST tool
	 * message of a batch. Rendered once, integrated with the tool entry
	 * (above the bash box), never repeated for concurrent calls.
	 */
	brief?: string;
	/**
	 * A triggered command/skill body sent to the LLM (custom commands,
	 * skills, subscribe auto-triggers). The transcript renders it as a
	 * tool-style `✦ Triggered a Command(name)` block instead of echoing the
	 * injected body as a plain user message (parity: nanocoder's
	 * `[Executing custom command: …]` marker + UserMessage collapse).
	 */
	command?: {
		kind: 'command' | 'skill';
		name: string;
		/** The command as the user TYPED it (e.g. `/worktree purpose: x`). */
		original?: string;
		body: string;
	};
}

// Messages only ever APPEND (rows mount once with their final content). The
// live stream lives in its own signal, component-body signal reads are the
// only updates the OpenTUI 0.4.5 solid reconciler re-renders.
export const [messages, setMessages] = createSignal<ChatMessage[]>([]);
/**
 * The conversation context sent to the provider. Stays in sync with
 * `messages` except for nudges/retry messages, which the provider must see
 * but the transcript must not render as user rows.
 */
export const [context, setContext] = createSignal<ChatMessageLike[]>([]);
export const [input, setInput] = createSignal('');
export const [busy, setBusy] = createSignal(false);
export const [streaming, setStreaming] = createSignal('');
export const [running, setRunning] = createSignal(false);
export const [reasoning, setReasoning] = createSignal('');
/**
 * True while the model is in the THINKING phase of the current round
 * (reasoning deltas are streaming, no reply text yet). The hide-thinking
 * indicator reads this, NOT the cumulative `reasoning()` buffer — the
 * buffer stays populated while the reply renders.
 */
export const [thinkingActive, setThinkingActive] = createSignal(false);
/** Most recent provider usage snapshot (token accounting footer). */
export const [lastUsage, setLastUsage] = createSignal<
	| {
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
			/** DeepSeek prompt-cache fields (kv_cache guide). */
			promptCacheHitTokens?: number;
			promptCacheMissTokens?: number;
	  }
	| undefined
>();
/** Ctrl+R: expand/collapse the settled Thought preview. */
export const [thoughtExpanded, setThoughtExpanded] = createSignal(false);
/** Ctrl+O: expand/collapse the compacted tool blocks. */
export const [toolsExpanded, setToolsExpanded] = createSignal(false);
/** Per-block expansion overrides (mouse clicks are local, C16). */
export const [expandedBlocks, setExpandedBlocks] = createSignal<
	Record<string, boolean>
>({});
/** Session-scoped PR capture (`/tool:open-prs` reads this). */
export const [prs, setPrs] = createSignal<string[]>([]);
/** Current session identity (persisted by the session manager). */
export const [sessionId, setSessionId] = createSignal('sess_new');
export const [sessionName, setSessionName] = createSignal('New conversation');
/** Prompt history for ↑/↓ navigation. */
export const [promptHistory, setPromptHistory] = createSignal<string[]>([]);
export const [historyIndex, setHistoryIndex] = createSignal(-1);
/**
 * Messages queued while a turn is streaming (submitted when it settles).
 * Each entry keeps its ATTACHMENTS so `[Image #N]` vision analysis still
 * works for queued prompts (the image paths would otherwise be lost).
 */
export const [pendingQueue, setPendingQueue] = createSignal<PendingWorkItem[]>(
	[],
);
/** Per-turn usage snapshots for `/usage`. */
export const [usageHistory, setUsageHistory] = createSignal<
	Array<{
		provider: string;
		model: string;
		ts: number;
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		promptCacheHitTokens?: number;
		promptCacheMissTokens?: number;
	}>
>([]);
/**
 * DeepSeek live balance for the status line (`Cred: $n`). Refreshed on app
 * start, on `/status`/`/model` opens, and on a 5-minute interval, all
 * through the TTL'd disk cache so concurrent instances never flood the API.
 */
export const [deepSeekBalance, setDeepSeekBalance] = createSignal<
	{currency: string; total: number; isAvailable?: boolean} | undefined
>();
/**
 * Current month's accumulated provider usage (token-plan providers like
 * Xiaomi MiMo whose quota is NOT reachable with an API key). Updated from
 * every turn's `usage` block and read by the status line (`used N.NM`),
 * the `/status` modal and `/usage`.
 */
export const [providerUsage, setProviderUsage] = createSignal<
	| {
			month: string;
			promptTokens: number;
			completionTokens: number;
			cachedTokens: number;
			totalTokens: number;
			at: number;
	  }
	| undefined
>();
/**
 * Live-discovered model catalogs (`GET /models` for DeepSeek and the MiMo
 * token-plan gateway), keyed by provider id. The model modal + model
 * validation read the merged catalog (fresh discovery wins over the static
 * config list).
 */
export const [discoveredModels, setDiscoveredModels] = createSignal<
	Record<string, string[]>
>({});
/**
 * Per-model context windows resolved from models.dev (provider id → model
 * id → window). Auto-discovered catalogs (DeepSeek / MiMo) are bare ids, so
 * the model modal shows the size from this map; a config-declared
 * `contextWindow` stays the provider-level fallback.
 */
export const [modelWindows, setModelWindows] = createSignal<
	Record<string, Record<string, number>>
>({});
/** B21/C12: issue count from the last auto-diagnostics run (status line). */
export const [diagnosticsCount, setDiagnosticsCount] = createSignal(0);
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export interface SessionTask {
	id: string;
	title: string;
	activeForm?: string;
	status: TaskStatus;
	dependsOn?: string[];
	owner?: string;
}
/** A7/C9: explicit task list from `write_tasks`. */
export const [tasks, setTasks] = createSignal<SessionTask[]>([]);
/** C12: in-flight subagent count (status line `agents: N`). */
export const [activeAgents, setActiveAgents] = createSignal(0);
/** Live delegated-agent rows, including review lenses. */
export interface ActiveAgentRun {
	id: string;
	name: string;
	description: string;
	/** Live compact tail shown under the running agent row. */
	output: string;
	/** Human-readable sidechain events for compact live tails. */
	transcript: string[];
	/** Current assistant text delta, rendered by embedded History. */
	streaming: string;
	/** Provider-format child history, persisted with parent session. */
	history: ChatMessageLike[];
	status: 'running' | 'completed' | 'incomplete' | 'error' | 'cancelled';
	/** False until parent observes a background agent's settled result. */
	retrieved?: boolean;
}
export const [activeAgentRuns, setActiveAgentRuns] = createSignal<
	ActiveAgentRun[]
>([]);
/** C12: seconds since the current turn started (Working indicator). */
export const [turnElapsed, setTurnElapsed] = createSignal(0);
/**
 * Seconds the CURRENT THINKING phase has been running. Starts when
 * reasoning first streams (NOT at message send), so the `⚙ Thinking`
 * header shows the real thinking time — the same value the settled
 * `⚙ Thought (Ns)` header reports.
 */
export const [thinkingElapsed, setThinkingElapsed] = createSignal(0);
/** Animation frame counter for spinners/gears (advanced by the app ticker). */
export const [spinnerFrame, setSpinnerFrame] = createSignal(0);
/** Braille spinner frames (parity: nanocoder's busy spinner). */
export const SPINNER_FRAMES = [
	'⠋',
	'⠙',
	'⠹',
	'⠸',
	'⠼',
	'⠴',
	'⠦',
	'⠧',
	'⠇',
	'⠏',
];
/** Working/Thinking gear alternates ⚙ ↔ ✦ (parity: nanocoder's live region). */
export const gearGlyph = (frame: number): string => (frame % 8 < 4 ? '⚙' : '✦');
/**
 * 500ms glyph blink cadence (parity: nanocoder's ToolGlyph toggles ✦ vs a
 * space). Running tool/reply glyphs render secondary and blink on this
 * cadence; the hidden frame keeps a space so the row width never shifts.
 */
export const glyphBlinkOn = (frame: number): boolean => (frame >> 2) % 2 === 0;
/** `Working` dots animate 1→2→3. */
export const workingDots = (frame: number): string =>
	'.'.repeat(((frame >> 2) % 3) + 1);
/** Lazy-load dots animate 1→2→3 (every 200ms on the 100ms ticker). */
export const loadingDots = (frame: number): string =>
	'.'.repeat(((frame >> 1) % 3) + 1);
/**
 * Compacting indicator label: the base text plus ANIMATED dots (1→2→3 on
 * the loading cadence). Pure so the dot math is unit-testable.
 */
export const compactingLabel = (frame: number): string =>
	`Compacting context (LLM summary)${loadingDots(frame)}`;
/**
 * Real-time elapsed timer (parity: the Working/Thinking headers): renders
 * `52s`, `1m 2s`, `1h 2m 3s`, never a bare seconds count past 60.
 */
export function formatElapsed(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const parts: string[] = [];
	if (h > 0) parts.push(`${h}h`);
	if (m > 0 || h > 0) parts.push(`${m}m`);
	parts.push(`${sec}s`);
	return parts.join(' ');
}

/**
 * Fractional seconds since a thinking phase started — the value the settled
 * `⚙ Thought (Ns)` header shows (sub-second thoughts render as `200ms`).
 * Pure, unit-tested.
 */
export function thinkingSeconds(startedAt: number, now: number): number {
	return Math.max(0, (now - startedAt) / 1000);
}
/** C13: transcript row under the mouse cursor (-1 = none) for hover. */
export const [hoverRow, setHoverRow] = createSignal(-1);
/** GAP-19: interactive settings panel state (open / tab / selected row). */
export const [settingsOpen, setSettingsOpen] = createSignal(false);
/** `/commands` / `/help` catalog modal (2-column, grouped). */
export const [commandsOpen, setCommandsOpen] = createSignal(false);
/** `/status` opens as a modal (parity: settings modal surface). */
export const [statusOpen, setStatusOpen] = createSignal(false);
/** `/model` opens as a modal (parity: nanocoder's model selector). */
export const [modelOpen, setModelOpen] = createSignal(false);
/** The model modal was opened from SETTINGS (shows an "Inherit" row). */
export const [modelModalInherit, setModelModalInherit] = createSignal(false);
/**
 * Which FALLBACK the settings model modal is configuring ('web' | 'vision' |
 * null = the main model). Selecting in the modal saves the fallback pref
 * instead of switching the main endpoint.
 */
export const [fallbackTarget, setFallbackTarget] = createSignal<
	'web' | 'vision' | null
>(null);
/** Built-in AGENTS modal (Settings → Capabilities → Agents). */
export const [agentsOpen, setAgentsOpen] = createSignal(false);
/**
 * Compact-block DETAILS modal: clicking an expandable compact tally opens a
 * scrollable modal with the individual call entries (the user reads the
 * content without the in-place toggle confusing them).
 */
export const [detailsOpen, setDetailsOpen] = createSignal(false);
export const [detailsTitle, setDetailsTitle] = createSignal('');
export const [detailsContent, setDetailsContent] = createSignal('');
/** `/resume` opens as a modal (parity: the reference session picker). */
export const [resumeOpen, setResumeOpen] = createSignal(false);
/**
 * Background-jobs modal (`/ps` or the floating `background jobs: n`
 * notification): live list of running background bash tasks with tailed
 * realtime output (the modal reads bgTasks() reactively).
 */
export const [psOpen, setPsOpen] = createSignal(false);
export const [settingsTab, setSettingsTab] = createSignal(0);
export const [settingsIndex, setSettingsIndex] = createSignal(0);
/** Live output for running tool rows, keyed by tool-call id. */
export const [liveOutputs, setLiveOutputs] = createSignal<
	Record<string, string>
>({});
/** Active provider endpoint (docs 05 E2): base URL, key, model, catalog. */
export interface ActiveEndpoint {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	models: string[];
	/** Per-model effort lookup (the badge is per MODEL, not per provider). */
	modelEfforts?: Record<string, string>;
	contextWindow: number;
	/** Effort badge of the ACTIVE model (`model[effort]`), derived from the
	 *  model's catalog entry, never an environment variable. */
	effort?: string;
	sdkProvider?: string;
	/** Responses wire against the ChatGPT Codex backend (codex login). */
	codexAccount?: boolean;
	providerOptions?: Record<string, unknown>;
	promptCacheKey?: boolean;
	alwaysAllow?: string[];
}
export const [activeEndpoint, setActiveEndpoint] = createSignal<ActiveEndpoint>(
	{
		id: 'mock',
		name: 'Mock',
		baseUrl: process.env.MOCK_URL ?? 'http://127.0.0.1:4010',
		apiKey: process.env.MOCK_API_KEY ?? '',
		model: process.env.MOCK_MODEL ?? 'mock-model-1',
		models: [process.env.MOCK_MODEL ?? 'mock-model-1'],
		contextWindow: 128_000,
	},
);
/** Runtime settings (approval mode, tool profile, message cap). */
export const [mode, setMode] = createSignal<Mode>('yolo');
export const [toolProfile, setToolProfile] = createSignal<ToolProfile>('full');
export const [maxMessages, setMaxMessages] = createSignal(1000);
/**
 * Pending tool-approval prompt (B16): when set, the input row asks y/n and
 * resolves the promise with `true` (approve) or `false` (decline).
 */
export const [pendingApproval, setPendingApproval] = createSignal<{
	name: string;
	detail: string;
	resolve: (approved: boolean) => void;
} | null>(null);
/**
 * Free-text input prompt (wizards): when set, the input row shows the
 * question and Enter resolves with the typed value.
 */
export const [pendingPrompt, setPendingPrompt] = createSignal<{
	question: string;
	options?: string[];
	resolve: (value: string) => void;
	/** Called when the user presses Esc, prompts may require an explicit
	 *  cancellation (e.g. the trust gate must NOT continue untrusted). */
	onCancel?: () => void;
} | null>(null);
/** Structured model-facing question modal. */
export const [pendingQuestion, setPendingQuestion] = createSignal<{
	header?: string;
	question: string;
	options: Array<{label: string; description?: string}>;
	multiple?: boolean;
	resolve: (value: string) => void;
} | null>(null);
/**
 * First-run TRUST dialog (codex-style): a dedicated modal with explicit
 * Yes/No options, NEVER the free-text prompt row (that read like the chat
 * input was ready). `resolve(true)` trusts the directory, `false` declines
 * (the app must not run against an untrusted directory).
 */
export const [pendingTrust, setPendingTrust] = createSignal<{
	directory: string;
	resolve: (trust: boolean) => void;
} | null>(null);
/**
 * Provider-connect MODAL (opencode-style): `/connect`, `/codex`, the model
 * modal's C shortcut and the settings provider rows open it — NEVER the
 * chat input row. `provider` preselects Codex/Custom, `editId` prefills
 * the custom form for an existing provider.
 */
export const [connectOpen, setConnectOpen] = createSignal<{
	provider?: 'codex' | 'custom';
	editId?: string;
} | null>(null);
/**
 * Standalone EFFORT picker (bare `/effort`): choose Default or a reasoning
 * tier for the ACTIVE model — never the chat input row.
 */
export const [effortOpen, setEffortOpen] = createSignal(false);

/**
 * TRUE when ANY modal surface is open (settings, commands, status, model,
 * agents, details, resume, connect, effort, trust). Everything BEHIND the
 * modal must be inert: the chat input box must not receive keys or paste,
 * and the history must not scroll or hover. Pure read of the signals.
 */
export const anyModalOpen = createMemo(
	() =>
		settingsOpen() ||
		commandsOpen() ||
		statusOpen() ||
		modelOpen() ||
		agentsOpen() ||
		detailsOpen() ||
		resumeOpen() ||
		psOpen() ||
		Boolean(connectOpen()) ||
		effortOpen() ||
		Boolean(pendingTrust()) ||
		Boolean(pendingQuestion()),
);

/** Estimated context usage % (E7): tokens / provider context window. */
export const [contextPercent, setContextPercent] = createSignal(0);
/** Non-zero while the provider call is retrying (429/stall backoff). */
export const [retryingAttempt, setRetryingAttempt] = createSignal(0);
/** True while the dynamic "Working…" tip row is showing. */
export const [workingTipVisible, setWorkingTipVisible] = createSignal(false);
/** A7: set while an abort is unwinding (Esc interrupt, watchdog). */
export const [cancelling, setCancelling] = createSignal(false);
/**
 * modal-style exit confirmation: the first Ctrl+C / Esc with an EMPTY
 * input shows "Press Ctrl+C again to exit" (+ the resume command) instead of
 * quitting; the second press exits. Typing clears the confirmation.
 */
export const [exitConfirm, setExitConfirm] = createSignal(false);
/** Static completion line above the input (`✦ Worked for a snappy 16s. …`). */
export const [completionMessage, setCompletionMessage] = createSignal('');
/**
 * Completion-line tone: the resume notice renders SUCCESS-green with a
 * leading breakline; the "Worked for …" line stays secondary.
 */
export const [completionTone, setCompletionTone] = createSignal<
	'default' | 'success'
>('default');
/**
 * COMPLETED attention modal: a centered success card shown AFTER a task
 * finishes while the user is idle (no mouse movement for the idle window).
 * Any mouse move / click / key dismisses it. The controller lives in
 * completion-popup.ts (unit-tested); this signal drives the render.
 */
export const [completionPopup, setCompletionPopup] = createSignal(false);
/**
 * True while an LLM context compaction is running (a separate summarization
 * request that may take a while). Renders a TRANSIENT centered row at the
 * bottom of the transcript (breakline above, animated dots, secondary), so
 * the compaction never pollutes the chat history with a permanent row; the
 * row disappears the moment the compaction settles.
 */
export const [compacting, setCompacting] = createSignal(false);
/**
 * Transient top-of-screen TOAST (parity: the reference "copied to clipboard"
 * toast). Used for setting changes (model/fallback/mode switches) so they
 * NEVER pollute the chat history, the toast auto-dismisses after ~2.5s.
 */
export const [toast, setToast] = createSignal('');
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(message: string): void {
	void runHooks({event: 'Notification', message});
	setToast(message);
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => setToast(''), 2500);
}
/**
 * One background lazy-load item (parity: codex loads MCP/LSP/skills after
 * the app paints). Each item animates and clears INDEPENDENTLY, because the
 * scans finish at different times (skills are file reads, MCP is a stdio
 * handshake, LSP is a sync binary scan).
 */
export interface StartupLoad {
	id: string;
	label: string;
}
/** Post-open lazy-load indicator rows, one per still-loading service. */
export const [startupLoading, setStartupLoading] = createSignal<StartupLoad[]>(
	[],
);
/** MCP servers that finished connecting (for /status + indicators). */
export const [mcpServers, setMcpServers] = createSignal<string[]>([]);
/** Status-line footer visibility (Settings → Appearance → Status Line). */
export const [statusLineEnabled, setStatusLineEnabled] = createSignal(true);
/**
 * Thinking display mode (settings.json `thinkingMode`): `hidden` skips the
 * live Thinking + settled Thought blocks (the Working indicator reads
 * "Thinking…"), `show` renders the full block + settled Thoughts, `line`
 * renders the header + a single scrolling one-liner.
 */
export const [thinkingMode, setThinkingMode] =
	createSignal<ThinkingMode>('hidden');
/**
 * Built-in caveman communication mode: when ON, the bundled caveman skill
 * body is injected into the stable system prompt (settings.json
 * `cavemanMode`). Defaults ON; the Settings → Behavior toggle turns it off.
 */
export const [cavemanMode, setCavemanMode] = createSignal(true);
/**
 * Resume working-directory mode (codex `ResumeCwdMode` parity, settings.json
 * `resumeCwd`): `session` restores the session's recorded cwd (keeps the
 * provider cache head byte-identical), `current` keeps the launch directory,
 * `ask` prompts when the two differ. Defaults `session`.
 */
export const [resumeCwdMode, setResumeCwdMode] =
	createSignal<ResumeCwdMode>('session');
/** Welcome-banner shapes (Settings → Appearance). */
export const [titleShape, setTitleShape] = createSignal('powerline-angled');
/** Snapshot taken when the last user prompt was submitted (`/retry`). */
export const [retrySnapshot, setRetrySnapshot] = createSignal<{
	messages: ChatMessage[];
	context: ChatMessageLike[];
	prompt: string;
} | null>(null);

export function appendMessage(message: ChatMessage): void {
	setMessages(prev => capDisplayMessages([...prev, message]));
}
/**
 * Hard cap on the DISPLAY transcript (the "lazy buffer"): the UI only ever
 * holds/renders a bounded window of messages, so a very long conversation
 * cannot make the app heavy. Older messages beyond the cap are trimmed and
 * replaced by a dim marker (compaction is the mechanism that preserves the
 * gist as a summary). Pure, unit-tested.
 */
export const DISPLAY_MESSAGE_CAP = 300;
/**
 * Trim the transcript to the bounded display window. Never splits a tool
 * result from its leading assistant call: a leading `tool` row is skipped
 * (it would render orphaned). Returns the original array when under the
 * cap. Pure, unit-tested.
 */
export function capDisplayMessages(messages: ChatMessage[]): ChatMessage[] {
	if (messages.length <= DISPLAY_MESSAGE_CAP) return messages;
	const sliced = messages.slice(-DISPLAY_MESSAGE_CAP);
	let start = 0;
	while (start < sliced.length && sliced[start]?.role === 'tool') start++;
	const dropped = messages.length - sliced.length + start;
	return [
		{
			role: 'assistant',
			kind: 'info',
			content: `… ${dropped} earlier message${dropped === 1 ? '' : 's'} trimmed (run /compact to summarize)`,
		},
		...sliced.slice(start),
	];
}

export function appendAssistantMessage(
	content: string,
	extra: Partial<ChatMessage> = {},
): void {
	appendMessage({role: 'assistant', content, ...extra});
}

/**
 * Settle every still-`running` tool message: a turn can end with a tool row
 * left `running:true` (Esc interrupt / watchdog / provider error mid-tool —
 * runBash keeps streaming output into liveOutputs after the turn dies).
 * Left alone it becomes a GHOST: invisible while idle (the settled memo
 * skips running rows and the live region is empty), then it RESURFACES in
 * the live region during the NEXT turn — stacked next to the new turn's
 * identical command, the "same bash printed twice while running" artifact.
 * Each ghost is settled with whatever output streamed so the transcript is
 * honest and nothing resurfaces. Pure, unit-tested.
 */
export function settleRunningToolRows(
	messages: ChatMessage[],
	liveOutputs: Record<string, string>,
): ChatMessage[] {
	return messages.map(message => {
		if (!message.running) return message;
		if (!message.tool) return {...message, running: false};
		const streamed = message.toolId ? liveOutputs[message.toolId] : undefined;
		return {
			...message,
			running: false,
			tool: {
				...message.tool,
				output: streamed !== undefined ? streamed : message.tool.output,
			},
		};
	});
}

export function appendInfo(content: string): void {
	appendMessage({role: 'assistant', content, kind: 'info'});
}

/** Warning rows render in the theme's WARNING (yellow) color. */
export function appendWarning(content: string): void {
	appendMessage({role: 'assistant', content, kind: 'warning'});
}

export function appendError(content: string): void {
	appendMessage({role: 'assistant', content, error: content});
}

export function addPR(url: string): void {
	setPrs(prev => (prev.includes(url) ? prev : [...prev, url]));
}

export function toggleToolBlock(key: string): void {
	setExpandedBlocks(prev => ({
		...prev,
		[key]: !(prev[key] ?? toolsExpanded()),
	}));
}

export function clearMessages(): void {
	setMessages([]);
	setContext([]);
	setStreaming('');
	setReasoning('');
	setThinkingElapsed(0);
	setRunning(false);
	setBusy(false);
	setLastUsage(undefined);
	setThoughtExpanded(false);
	setToolsExpanded(false);
	setExpandedBlocks({});
	setPrs([]);
	setRetrySnapshot(null);
	setPendingQueue([]);
	setActiveAgentRuns([]);
	setUsageHistory([]);
	setHistoryIndex(-1);
	setLiveOutputs({});
	setPendingApproval(null);
	setPendingPrompt(null);
	setContextPercent(0);
	setCancelling(false);
}
