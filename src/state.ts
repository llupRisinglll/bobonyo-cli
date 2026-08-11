import {createSignal} from 'solid-js';
import type {ChatMessageLike} from './client';
import type {Mode, ToolProfile} from './settings';

export interface ChatMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	running?: boolean;
	error?: string;
	/** Reasoning text that preceded this assistant message (Thought UI). */
	reasoning?: string;
	/** Wall-clock seconds the thinking phase took (settled Thought header). */
	durationSec?: number;
	/** Info/notice rows (empty-turn retries, system notes) render dim. */
	kind?: 'info';
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
/** Most recent provider usage snapshot (token accounting footer). */
export const [lastUsage, setLastUsage] = createSignal<
	{prompt_tokens?: number; completion_tokens?: number; total_tokens?: number} | undefined
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
export const [pendingQueue, setPendingQueue] = createSignal<
	Array<{value: string; attachments?: Record<string, string>}>
>([]);
/** Per-turn usage snapshots for `/usage`. */
export const [usageHistory, setUsageHistory] = createSignal<
	Array<{
		provider: string;
		model: string;
		ts: number;
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	}>
>([]);
/** B21/C12: issue count from the last auto-diagnostics run (status line). */
export const [diagnosticsCount, setDiagnosticsCount] = createSignal(0);
/** A7/C9: task list from `write_tasks`, with live progress flags. */
export const [tasks, setTasks] = createSignal<
	Array<{title: string; done?: boolean; running?: boolean}>
>([]);
/** C12: in-flight subagent count (status line `agents: N`). */
export const [activeAgents, setActiveAgents] = createSignal(0);
/** C12: seconds since the current turn started (Working indicator). */
export const [turnElapsed, setTurnElapsed] = createSignal(0);
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
export const gearGlyph = (frame: number): string =>
	frame % 8 < 4 ? '⚙' : '✦';
/** `Working` dots animate 1→2→3. */
export const workingDots = (frame: number): string =>
	'.'.repeat(((frame >> 2) % 3) + 1);
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
/** C13: transcript row under the mouse cursor (-1 = none) for hover. */
export const [hoverRow, setHoverRow] = createSignal(-1);
/** GAP-19: interactive settings panel state (open / tab / selected row). */
export const [settingsOpen, setSettingsOpen] = createSignal(false);
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
export const [settingsTab, setSettingsTab] = createSignal(0);
export const [settingsIndex, setSettingsIndex] = createSignal(0);
/** Live output for running tool rows, keyed by tool-call id. */
export const [liveOutputs, setLiveOutputs] = createSignal<Record<string, string>>(
	{},
);
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
	providerOptions?: Record<string, unknown>;
	promptCacheKey?: boolean;
	alwaysAllow?: string[];
}
export const [activeEndpoint, setActiveEndpoint] = createSignal<ActiveEndpoint>({
	id: 'mock',
	name: 'Mock',
	baseUrl: process.env.MOCK_URL ?? 'http://127.0.0.1:4010',
	apiKey: process.env.MOCK_API_KEY ?? '',
	model: process.env.MOCK_MODEL ?? 'mock-model-1',
	models: [process.env.MOCK_MODEL ?? 'mock-model-1'],
	contextWindow: 128_000,
});
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
	resolve: (value: string) => void;
	/** Called when the user presses Esc, prompts may require an explicit
	 *  cancellation (e.g. the trust gate must NOT continue untrusted). */
	onCancel?: () => void;
} | null>(null);
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
 * Transient top-of-screen TOAST (parity: the reference "copied to clipboard"
 * toast). Used for setting changes (model/fallback/mode switches) so they
 * NEVER pollute the chat history, the toast auto-dismisses after ~2.5s.
 */
export const [toast, setToast] = createSignal('');
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(message: string): void {
	setToast(message);
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => setToast(''), 2500);
}
/**
 * Post-open lazy-load indicator (parity: codex loads MCP/LSP/skills after
 * the app paints). Non-empty while background init is still running; the
 * input area renders it with the spinner so the user sees what's loading.
 */
export const [startupLoading, setStartupLoading] = createSignal('');
/** MCP servers that finished connecting (for /status + indicators). */
export const [mcpServers, setMcpServers] = createSignal<string[]>([]);
/** Status-line footer visibility (Settings → Appearance → Status Line). */
export const [statusLineEnabled, setStatusLineEnabled] = createSignal(true);
/** Welcome-banner shapes (Settings → Appearance). */
export const [titleShape, setTitleShape] = createSignal('powerline-angled');
/** Snapshot taken when the last user prompt was submitted (`/retry`). */
export const [retrySnapshot, setRetrySnapshot] = createSignal<{
	messages: ChatMessage[];
	context: ChatMessageLike[];
	prompt: string;
} | null>(null);

export function appendMessage(message: ChatMessage): void {
	setMessages(prev => [...prev, message]);
}

export function appendAssistantMessage(
	content: string,
	extra: Partial<ChatMessage> = {},
): void {
	appendMessage({role: 'assistant', content, ...extra});
}

export function appendInfo(content: string): void {
	appendMessage({role: 'assistant', content, kind: 'info'});
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
	setRunning(false);
	setBusy(false);
	setLastUsage(undefined);
	setThoughtExpanded(false);
	setToolsExpanded(false);
	setExpandedBlocks({});
	setPrs([]);
	setRetrySnapshot(null);
	setPendingQueue([]);
	setUsageHistory([]);
	setHistoryIndex(-1);
	setLiveOutputs({});
	setPendingApproval(null);
	setPendingPrompt(null);
	setContextPercent(0);
	setCancelling(false);
}
