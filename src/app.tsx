/** @jsxImportSource @opentui/solid */
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {useKeyboard, useRenderer, useTerminalDimensions} from '@opentui/solid';
import {createTextAttributes} from '@opentui/core';
import {createMemo, createSignal, Show} from 'solid-js';
import {
	looksLikeToolCallText,
	currentDateFragment,
	parseArguments,
	parseToolCalls,
	ProviderError,
	projectProviderMessages,
	setFallbackEndpoints,
	streamChat,
	buildSystemPrompt,
	type ChatMessageLike,
	type MockToolCall,
} from './client';
import {
	SYSTEM_PROMPT_STYLES,
	seedCustomSystemPrompt,
	systemPromptPath,
	type SystemPromptStyle,
} from './system-prompt';
import {
	applyProviderDeletion,
	discoverModels,
	configDir,
	listProviders,
	loadConfig,
	loadPreferences,
	discoverCodexAccountModels,
	effectiveContextWindow,
	resolveApiKey,
	resolveContextWindow,
	resolveProvider,
	saveConfig,
	savePreferences,
	type ProviderConfig,
	type ResolvedProvider,
} from './config';
import {resolveRulesFile} from './rules-file';
import {
	appendMemory,
	clearMemory,
	forgetMemory,
	listMemoryRecords,
	renderPersistentMemory,
} from './memory';
import {imageSourceContext, persistImageAttachments} from './attachments';
import {buildMentionContext} from './mentions';
import {
	beginFileUndoExchange,
	discardFileUndoFrom,
	fileUndoExchanges,
	rewindFileExchangeAt,
	resetFileUndoStack,
} from './file-undo';
import {
	buildCommandInvocationPrompt,
	customToolRegistryName,
	expandCommandPrompt,
	expandCustomTool,
	loadCustomCommands,
	loadCustomTools,
	loadSkills,
} from './custom';
import {
	displayToolName,
	executeTool,
	isReadOnlyTool,
	isParallelSafeTool,
	isSingleToolProfile,
	listTools,
	normalizeTaskList,
	registerTool,
	requiresApproval,
	resolveToolName,
	toolCatalogForModel,
	toolDisplayDetail,
	toolAvailability,
	toolArgsSummary,
	toolResultTail,
} from './tools';
import {
	activeBgCount,
	bgTasks,
	cancelRunningBackgroundTasks,
	normalizeBashCommand,
	runBash,
} from './bash';
import {
	dequeuePendingWork,
	enqueueTaskNotification,
	enqueueUserWork,
	type DetachedCompletion,
} from './background-notification';
import {COMMAND_DESCRIPTIONS, findCustomCommand, runCommand} from './commands';
import {
	loadSettings,
	resumeCwdDecision,
	saveSettings,
	type Mode,
	type ResumeCwdMode,
	type ToolProfile,
} from './settings';
import {estimateTokens} from './tokenize';
import {
	classifyIntent,
	evaluateSteering,
	evaluateToolConstraint,
	formatInnerDaemonRow,
	loadSteeringConfig,
	type SteeringConfig,
} from './steering';
import {
	evaluateRepeatedToolCalls,
	INITIAL_REPEATED_TOOL_STATE,
	type RepeatedToolState,
} from './repeated-tool-guard';
import {
	closeMCPServers,
	loadMCPServerTools,
	loadMCPConfig,
	type MCPTool,
} from './mcp';
import {
	deleteSession,
	firstMessagePreview,
	healResumedContext,
	listCheckpoints,
	loadCheckpoint,
	forkSession,
	listSessions,
	newSessionId,
	resolveSession,
	saveCompactionTranscript,
	saveCheckpoint,
	saveSession,
	type SessionData,
} from './session';
import {History} from './components/history';
import {
	computeInputBoxHeight,
	bashModeIndicatorRows,
	completionMessageRows,
	completionPopupHeight,
	lineTickerVisible,
	mentionPopupHeight,
	InputBox,
} from './components/input-box';
import {
	SETTINGS_TABS,
	SettingsModal,
	settingsRows,
	type SettingsRow,
} from './components/settings-panel';
import {
	SettingsListModal,
	type SettingsListRow,
} from './components/settings-list-modal';
import {CommandsModal} from './components/commands-modal';
import {Status} from './components/status';
import {StatusModal, type StatusRow} from './components/status-modal';
import {ModelModal, type ModelProvider} from './components/model-modal';
import {effortLevelsForModel} from './components/model-modal';
import {projectRoot} from './project-paths';
import {ConnectProviderModal} from './components/connect-provider-modal';
import {BackgroundJobsModal} from './components/background-jobs-modal';
import {ActivityIndicator} from './components/activity-indicator';
import {EffortModal} from './components/effort-modal';
import {ResumeModal, type ResumeSession} from './components/resume-modal';
import {AgentsModal} from './components/agents-modal';
import {DetailsModal} from './components/details-modal';
import {buildStatusRows, providerStatusLabel} from './status-rows';
import {consumeCodexReset, fetchCodexLimits} from './codex-limits';
import {
	analyzeImageWithFallback,
	resolveVisionFallback,
	supportsNativeImageInput,
} from './vision';
import {detectLanguageServers} from './lsp';
import {
	cachedDeepSeekModels,
	cacheStats,
	formatCacheHitLabel,
	isDeepSeek,
	isXiaomiMiMo,
	refreshProviderModels,
	refreshDeepSeekBalance,
	refreshDeepSeekModels,
	shouldAlertCacheMiss,
} from './deepseek';
import {
	currentMonthUsage,
	extractCacheTokens,
	formatTokens,
	formatUsageCalendar,
	recordProviderUsage,
} from './provider-usage';
import {buildBannerBox} from './banner';
import {colors, selectTheme, setThemeName, THEMES} from './theme';
import {TrustModal} from './components/trust-modal';
import {QuestionModal} from './components/question-modal';
import {listHooks, runHooks} from './hooks';
import {forkInHerdrPane, herdrAvailable, type HerdrSplit} from './herdr';
import {
	notifyTaskComplete,
	shouldNotifyTurnComplete,
	releaseHerdrAgent,
	reportHerdrAgent,
	reportHerdrSession,
} from './notifications';
import {
	formatGoal,
	formatLoopJob,
	goalContinuationPrompt,
	goalStatusFromResponse,
	loopIntervalMs,
	newLoopJob,
	parseGoalSpec,
	parseLoopControl,
	parseLoopSpec,
	type LoopJob,
	type SessionGoal,
} from './goal-loop';
import {
	AUTO_COMPACT_SAFETY_BUFFER_TOKENS,
	COMPACTION_FAILURE_COOLDOWN_MS,
	COMPACTION_FAILURE_LIMIT,
	INITIAL_COMPACTION_FAILURE_STATE,
	autoCompactReentryFloor,
	autoCompactTokenLimit,
	buildCompactionStateSnapshot,
	canAttemptAutoCompaction,
	compactionSnapshotBudgets,
	estimateContextTokens,
	isCompactionStateSnapshot,
	microcompactToolResults,
	recordCompactionFailure,
	recordCompactionSuccess,
	shouldAutoCompactContext,
	truncateCompactionText,
	type CompactionFailureState,
} from './compaction-state';
import {
	oneSentencePreToolBrief,
	splitPreToolText,
	toolCallBrief,
} from './pre-tool-brief';
import {shouldPersistTaskCloseoutReply} from './task-closeout';

const VERSION = '0.1.0';
import {CompletionPopup} from './components/completion-popup';
import {
	COMPLETION_POPUP_IDLE_MS,
	createCompletionPopupController,
} from './completion-popup';
import {
	addPR,
	activeAgents,
	activeEndpoint,
	appendAssistantMessage,
	appendError,
	appendInfo,
	appendMessage,
	appendWarning,
	capDisplayMessages,
	showToast,
	toast,
	formatElapsed,
	busy,
	cancelling,
	clearMessages,
	context,
	contextPercent,
	completionMessage,
	completionTone,
	completionPopup,
	setCompletionPopup,
	commandsOpen,
	setCommandsOpen,
	connectOpen,
	setConnectOpen,
	effortOpen,
	setEffortOpen,
	deepSeekBalance,
	diagnosticsCount,
	discoveredModels,
	exitConfirm,
	input,
	lastUsage,
	maxMessages,
	messages,
	mode,
	modelWindows,
	pendingQueue,
	pendingApproval,
	pendingPrompt,
	pendingQuestion,
	setPendingQuestion,
	pendingTrust,
	prs,
	providerUsage,
	reasoning,
	retrySnapshot,
	thinkingActive,
	thinkingMode,
	running,
	settleRunningToolRows,
	setBusy,
	setCancelling,
	setActiveEndpoint,
	activeAgentRuns,
	setActiveAgentRuns,
	setContextPercent,
	setContext,
	setCompletionMessage,
	setDeepSeekBalance,
	setDiscoveredModels,
	setModelWindows,
	setCompletionTone,
	setThinkingMode,
	setCompacting,
	setCavemanMode,
	setResumeCwdMode,
	resumeCwdMode,
	setStartupLoading,
	setMcpServers,
	setDiagnosticsCount,
	setExitConfirm,
	setHistoryIndex,
	setInput,
	setThinkingActive,
	setLastUsage,
	liveOutputs,
	setLiveOutputs,
	setMaxMessages,
	setMessages,
	setMode,
	setPendingQueue,
	setPendingApproval,
	setPendingPrompt,
	setPendingTrust,
	setProviderUsage,
	setPromptHistory,
	setReasoning,
	setRetrySnapshot,
	setRunning,
	setSessionId,
	setSessionName,
	setStreaming,
	setTasks,
	setTurnElapsed,
	setThinkingElapsed,
	setSpinnerFrame,
	tasks,
	streaming,
	startupLoading,
	thinkingSeconds,
	mcpServers,
	settingsOpen,
	setSettingsOpen,
	statusOpen,
	setStatusOpen,
	modelOpen,
	setModelOpen,
	modelModalInherit,
	setModelModalInherit,
	fallbackTarget,
	setFallbackTarget,
	agentsOpen,
	setAgentsOpen,
	detailsOpen,
	setDetailsOpen,
	detailsTitle,
	detailsContent,
	setDetailsTitle,
	setDetailsContent,
	resumeOpen,
	setResumeOpen,
	psOpen,
	setPsOpen,
	settingsTab,
	setSettingsTab,
	settingsIndex,
	setSettingsIndex,
	setStatusLineEnabled,
	setThoughtExpanded,
	setTitleShape,
	setToolProfile,
	setToolsExpanded,
	setUsageHistory,
	sessionId,
	sessionName,
	anyModalOpen,
	statusLineEnabled,
	titleShape,
	toolProfile,
	usageHistory,
	workingTipVisible,
	type ChatMessage,
} from './state';

// The per-turn TOOL LOOP is intentionally UNCAPPED. opencode, openclaude,
// and codex do not limit how many tool calls a turn may chain, and a hard
// round cap killed legitimate long-running tasks (test suites, refactors,
// multi-file changes). Runaway/corruption protection comes from the guards
// below plus the stream stall watchdog — never from a round count.
// TOOL_LOOP_BUDGET is an ADVISORY steering-fact reference only (the
// InnerDaemon audit row shows `budget N/24`); it is not enforced anywhere.
const TOOL_LOOP_BUDGET = 24;
const MAX_EMPTY_TURNS = 2;
const MAX_MALFORMED_RETRIES = 2;
/**
 * Minimum time a tool row stays in its RUNNING state. A fast tool call
 * (MCP stdio round trips can be ~1ms; read/write are similar) settles
 * before OpenTUI paints its next frame (~16ms at 60fps), so the row would
 * appear already green with output and the grey running glyph would never
 * be seen. The floor holds the running state so the glyph is visible
 * (parity: the startup loader's MIN_LOAD_MS floor for the same reason).
 */
export const MIN_TOOL_RUNNING_MS = 400;
/**
 * Milliseconds still needed to keep a tool row in its RUNNING state for at
 * least MIN_TOOL_RUNNING_MS (0 once the floor has elapsed). Pure,
 * unit-tested; the settle path awaits this before flipping the row green.
 */
export function toolRunningRemainingMs(
	startedAt: number,
	now: number,
	floorMs = MIN_TOOL_RUNNING_MS,
): number {
	return Math.max(0, startedAt + floorMs - now);
}
// Codex-style LLM compaction (port of codex-rs/core/src/compact.rs): the old
// context is sent to the model in a SEPARATE summarization request; the
// returned handoff summary REPLACES the history (prefixed + recent user
// prompts kept). The main conversation's provider prefix stays short, so the
// next turn starts a fresh cache head instead of resending the old blob.
export const SUMMARIZATION_PROMPT = `CRITICAL: Respond with text only. Do not call tools. You already have the conversation context needed for this task.

You are performing a CONTEXT CHECKPOINT COMPACTION. Create an authoritative handoff for another coding agent that will resume the task.

The checkpoint must preserve both WHAT is being done and HOW work is performed. Do not reduce a proven workflow to vague prose such as "connect to production" or "upload the image".

Review the conversation chronologically before writing. Resolve conflicts in favor of the user's latest correction and the latest verified successful procedure. Output only the checkpoint, with no preamble or commentary.

Use these sections:
# Current state
- Active objective, completed work, pending work, and immediate next action.
# Operating procedure
- Exact proven sequence of steps. Preserve command templates, tool names, skill names, file paths, scripts, and verification queries needed to repeat the work.
- Prefer the latest successful procedure over earlier failed attempts.
# Environment and access
- Working directory, repository, branch/worktree, hosts/IPs, SSH user, ports, remote paths, env files, service names, database schemas/tables, storage destinations, and relevant IDs.
- Preserve variable names and placeholders, but NEVER copy secret values, passwords, tokens, private keys, or credentials.
# Decisions and constraints
- User preferences, safety rules, approvals, assumptions, and decisions already made.
# Failures and corrections
- Failed approaches, exact useful errors, user corrections, and what must not be repeated.
# Important artifacts and results
- Files changed or created, durable image/file paths, transaction/record IDs, URLs, outputs, and verified facts needed later.
# User requests and corrections
- Preserve every still-relevant explicit user request, preference, correction, rejection, and acceptance. Mark superseded requests as superseded instead of reviving them.
# Next steps
- Concrete ordered continuation steps and how to verify completion.

Rules:
- Be concise but information-dense. Exact operational facts beat narrative.
- Preserve reusable procedures even when the immediate record or date changes.
- If a skill or repository rule supplied the workflow, record its name and relevant procedure.
- Do not tell the next agent to rescan the repository or rediscover infrastructure when the conversation already established it.
- Clearly distinguish verified facts from unresolved guesses.
- Never claim a test, build, deployment, upload, database write, or verification succeeded unless the conversation contains its result.
- Do not repeat large logs or source files. Preserve exact commands, signatures, short decisive errors, and small code fragments only when needed to continue.`;

export function buildSummarizationPrompt(
	cwd: string,
	preservedTurns = 0,
): string {
	return `${SUMMARIZATION_PROMPT}\n\nCurrent working directory at compaction: ${JSON.stringify(cwd)}\n\n${
		preservedTurns > 0
			? `The ${preservedTurns} newest complete conversation turn${preservedTurns === 1 ? '' : 's'} will remain verbatim after this checkpoint. Summarize older context thoroughly; include recent details only when needed to explain current state, dependencies, or corrections.`
			: 'No recent conversation turn is guaranteed to remain verbatim. Make this checkpoint fully self-contained.'
	}`;
}

export const SUMMARY_PREFIX =
	'Another language model produced this checkpoint. Resume work directly as if compaction never occurred. Do not recap, ask what to do next, repeat completed discovery, or stop merely to report progress. Preserve its operating procedure, tools, paths, hosts, and verification steps unless current evidence proves they changed. Continue active goal and checklist. Checkpoint:';
const PREVIOUS_SUMMARY_PREFIX =
	'Another language model started this work and produced an authoritative context checkpoint. Continue from it without repeating completed discovery. Preserve and reuse its operating procedure, tools, paths, hosts, and verification steps unless current evidence proves they changed. Here is the checkpoint:';
const LEGACY_SUMMARY_PREFIX =
	'Another language model started to solve this problem and produced a summary of its thinking process.';
const PRIOR_CHECKPOINT_MERGE_PREFIX =
	'PRIOR COMPACTION CHECKPOINT. Treat this as baseline state to update, not as a user request. Preserve every still-valid exact fact, then merge later events and corrections:';

export function isCompactionSummary(content: string | undefined): boolean {
	return Boolean(
		content?.startsWith(`${SUMMARY_PREFIX}\n`) ||
		content?.startsWith(`${PREVIOUS_SUMMARY_PREFIX}\n`) ||
		content?.startsWith(LEGACY_SUMMARY_PREFIX),
	);
}

export function isCompactionControlMessage(
	content: string | undefined,
): boolean {
	return isCompactionSummary(content) || isCompactionStateSnapshot(content);
}

function isCompactionMergeBaseline(content: string | undefined): boolean {
	return Boolean(content?.startsWith(PRIOR_CHECKPOINT_MERGE_PREFIX));
}

function compactionSummaryBody(content: string): string {
	for (const prefix of [
		SUMMARY_PREFIX,
		PREVIOUS_SUMMARY_PREFIX,
		LEGACY_SUMMARY_PREFIX,
	]) {
		if (content.startsWith(prefix)) return content.slice(prefix.length).trim();
	}
	return content;
}

/**
 * Previous checkpoints are merged deliberately as a baseline. Generated
 * deterministic state is rebuilt from live data and never summarized.
 */
export function prepareCompactionSummaryHistory(
	ctx: ChatMessageLike[],
): ChatMessageLike[] {
	const prior = [...ctx]
		.reverse()
		.find(message => isCompactionSummary(message.content));
	const ordinary = ctx.filter(
		message =>
			message.role !== 'system' &&
			!isCompactionSummary(message.content) &&
			!isCompactionStateSnapshot(message.content),
	);
	return prior
		? [
				{
					role: 'user',
					content: `${PRIOR_CHECKPOINT_MERGE_PREFIX}\n\n${compactionSummaryBody(prior.content ?? '')}`,
				},
				...ordinary,
			]
		: ordinary;
}
/**
 * Cap on USER messages kept verbatim under the compaction summary (parity:
 * codex COMPACT_USER_MESSAGE_MAX_TOKENS). The newest user messages are kept
 * first; an oversized OLDEST message is truncated to fit the remaining
 * budget (codex `build_compacted_history_with_limit`). The summary itself is
 * never part of this budget.
 */
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
/** OpenClaude-style protected recent working set, kept as complete turns. */
const COMPACT_RECENT_TAIL_MAX_TOKENS = 20_000;

export interface CompactionPartition {
	summarize: ChatMessageLike[];
	preserve: ChatMessageLike[];
	preservedTurns: number;
}

/**
 * App shell, routing (A5), the agent turn loop, sessions (A8) and the
 * slash-command surface (F1-F3). Command output is display-only: it goes to
 * the transcript as info rows, never to the provider context, never
 * persisted.
 */
export function App() {
	const renderer = useRenderer();
	// Resume may switch process.cwd() to the saved session directory. Keep
	// launch CWD so `/clear` returns to the directory outside the TUI.
	const launchCwd = process.cwd();
	// Sandbox boundary belongs to launch workspace, not mutable shell cwd.
	// Recomputing it after `cd` into a nested checkout makes parent project
	// files read-only inside bubblewrap.
	const workspaceRoot = projectRoot(launchCwd);
	const [workspaceCwd, setWorkspaceCwd] = createSignal(launchCwd);
	// Keep process.cwd(), tool cwd, system prompt, and status line identical.
	// A signal alone leaves the model believing it is still in launch CWD.
	const updateWorkspaceCwd = (next: string) => {
		try {
			process.chdir(next);
		} catch {
			return;
		}
		setWorkspaceCwd(process.cwd());
	};
	const [statusRows, setStatusRows] = createSignal<StatusRow[]>([]);
	const [settingsList, setSettingsList] = createSignal<{
		title: string;
		rows: SettingsListRow[];
	} | null>(null);
	/** Measured rendered height of the chat history (banner + transcript). */
	const [historyContentHeight, setHistoryContentHeight] = createSignal(0);
	// Filesystem-backed session metadata is not reactive by itself. Bump this
	// after every save so an already-mounted `/resume` modal refreshes when
	// the resumed conversation receives a new message.
	const [sessionListVersion, setSessionListVersion] = createSignal(0);
	/** Open the settings LIST modal (also opens the settings surface). */
	const openSettingsList = (title: string, rows: SettingsListRow[]) => {
		setSettingsList({title, rows});
		setSettingsOpen(true);
	};
	/** Open a scrollable DETAILS modal for pure-info command output. */
	const openInfoModal = (title: string, content: string) => {
		setDetailsTitle(title);
		setDetailsContent(content);
		setDetailsOpen(true);
	};

	// The in-flight turn's abort controller, so `/clear` can cancel a running
	// stream mid-turn (parity: clear starts a NEW conversation).
	let abortRef: AbortController | null = null;
	let exitConfirmTimer: ReturnType<typeof setTimeout> | null = null;
	let resumeNoticeTimer: ReturnType<typeof setTimeout> | null = null;
	// COMPLETED attention modal: a finished task arms an idle window; the
	// popup shows only when the user has NOT moved the mouse (or pressed a
	// key) for the whole window, and the FIRST activity dismisses it.
	// (createCompletionPopupController is pure + unit-tested.)
	const completionPopupController = createCompletionPopupController(
		{setTimeout, clearTimeout},
		COMPLETION_POPUP_IDLE_MS,
		() => setCompletionPopup(true),
		() => setCompletionPopup(false),
	);
	let currentSession: SessionData | null = null;
	let currentGoal: SessionGoal | undefined;
	const [goalRevision, setGoalRevision] = createSignal(0);
	const visibleGoal = () => {
		goalRevision();
		return currentGoal;
	};
	const setCurrentGoal = (next: SessionGoal | undefined) => {
		currentGoal = next;
		setGoalRevision(revision => revision + 1);
	};
	const [psInitialTab, setPsInitialTab] = createSignal<
		'jobs' | 'agents' | 'goal'
	>('jobs');
	let loopJobsRef: LoopJob[] = [];
	const loopTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let autonomousTurnRef = false;
	let loopTurnRef = false;
	let taskTurnRef = false;
	let goalAccountingTurnRef = false;
	let goalContinuationPending = false;
	let interruptedRef = false;
	let foregroundTurnSeq = 0;
	let foregroundTurnOwner = 0;
	let queryActiveRef = false;
	reportHerdrAgent('idle', {message: 'BoboNyo ready'});
	// CACHE HEAD GATE: the tool catalog is part of the request prefix
	// (parity: codex + nanocoder tool-filter). Lazy MCP/custom-tool loading
	// can still be registering tools when the app paints, so the FIRST LLM
	// request must wait for loading to finish — otherwise the tool array
	// grows between turn 1 and turn 2 and busts the whole prefix cache.
	let startupReadyRef = false;
	let watchdogRef = false;
	/**
	 * Compact when the conversation gets within this many messages of the
	 * message cap. The cap trims the OLDEST message once exceeded, which
	 * changes byte 0 of the request and busts the provider's whole prefix
	 * cache — compacting FIRST turns the head change into a deliberate,
	 * one-time summary instead of a per-turn miss.
	 */
	const AUTO_COMPACT_MESSAGE_MARGIN = 100;
	const autoCompactRef: {enabled: boolean; threshold: number} = {
		enabled: false,
		threshold: 80,
	};
	let compactionFailureRef: CompactionFailureState = {
		...INITIAL_COMPACTION_FAILURE_STATE,
	};
	let autoCompactReentryFloorRef = 0;
	let steeringRef: SteeringConfig = {enabled: false, rules: []};
	let watchdogMsRef = 0;
	let streamGuardRef: {maxOutputChars?: number; maxDurationMs?: number} = {};
	let scrubberRef: ReturnType<typeof createScrubber> = createScrubber([]);
	// Anchored when reasoning FIRST streams (not at message send), so the
	// `⚙ Thinking` timer and the settled `⚙ Thought (Ns)` show the real
	// thinking time, never the pre-thinking provider latency.
	let thinkingStartedAt = 0;
	const mcpToolsRef: MCPTool[] = [];
	// Animation ticker: advances the spinner/gear frame counter so the busy
	// spinner, Working dots and gear glyph animate like nanocoder's.
	setInterval(() => setSpinnerFrame(prev => prev + 1), 100);
	// DeepSeek balance/model refresh cadence (5 min, mirroring the balance
	// TTL). The refresh itself reads the disk cache first, so this interval
	// and the event-triggered refreshes share one request when fresh.
	setInterval(
		() => {
			const endpoint = activeEndpoint();
			if (!isDeepSeek(endpoint)) return;
			void refreshDeepSeekBalance(endpoint).then(balance => {
				if (balance) {
					setDeepSeekBalance({
						currency: balance.currency,
						total: balance.total,
						isAvailable: balance.isAvailable,
					});
				}
			});
		},
		5 * 60 * 1000,
	);

	// Provider init (E2): resolve the requested/first provider and publish the
	// active endpoint; the client reads it for every request.
	{
		void (async () => {
			try {
				const provider = resolveProvider();
				// DeepSeek + Xiaomi MiMo catalogs are fetched live from
				// `/models` (the MiMo token-plan gateway auto-gets a
				// `modelDiscoveryUrl` from the config normalizer). Seed the
				// initial catalog from the DISK cache so the first model is a
				// REAL model; when there is no static list AND no warm cache
				// (the config normalizer would otherwise fall back to
				// mock-model-1), wait for the fetch before picking a model.
				const miMoModelsUrl = provider.modelDiscoveryUrl;
				let catalog = provider.models;
				if (isDeepSeek(provider)) {
					catalog = cachedDeepSeekModels(provider) ?? provider.models;
					if (catalog.every(model => model === 'mock-model-1')) {
						catalog = await refreshDeepSeekModels(provider);
					}
				} else if (isXiaomiMiMo(provider) && miMoModelsUrl) {
					catalog = cachedDeepSeekModels(provider) ?? provider.models;
					if (catalog.every(model => model === 'mock-model-1')) {
						catalog = await refreshProviderModels(provider, miMoModelsUrl);
					}
				}
				const prefs = loadPreferences();
				const preferredModel =
					prefs.lastModel && catalog.includes(prefs.lastModel)
						? prefs.lastModel
						: (catalog[0] ?? 'mock-model-1');
				setActiveEndpoint({
					id: provider.id,
					name: provider.name ?? provider.id,
					baseUrl: provider.baseUrl,
					apiKey: provider.apiKeyResolved,
					model: preferredModel,
					models: catalog,
					modelEfforts: provider.modelEfforts,
					contextWindow: provider.contextWindow ?? 128_000,
					sdkProvider: provider.sdkProvider,
					codexAccount: provider.codexAccount,
					providerOptions: provider.providerOptions,
					// EFFORT IS PER MODEL: the badge comes from the SELECTED
					// model's catalog entry, never an env var.
					effort: (provider.modelEfforts ?? {})[preferredModel],
					promptCacheKey: provider.promptCacheKey,
					alwaysAllow: provider.alwaysAllow,
				});
				savePreferences({lastProvider: provider.id, lastModel: preferredModel});
				// Per-model context windows for the modal (models.dev, cached):
				// resolve the seeded catalog NOW, then again when the live
				// discovery lands with the real ids.
				void refreshModelWindows(provider, catalog);
				// Seed the monthly usage indicator from the DISK ledger so
				// the status line shows `used N.NM` / the cache rate
				// immediately on a warm ledger (even before the first turn
				// of this session).
				setProviderUsage(currentMonthUsage(provider.baseUrl));
				// E6: no declared context window → resolve from models.dev
				// (cached, async; the ctx% indicator updates when it lands).
				if (!provider.contextWindow) {
					void resolveContextWindow(
						preferredModel,
						undefined,
						provider.id,
					).then(window => {
						if (window && window > 0) {
							setActiveEndpoint(prev => ({...prev, contextWindow: window}));
						}
					});
				}
				if (provider.modelDiscoveryUrl) {
					void discoverModels(provider).then(models => {
						if (models.length > 0) {
							setActiveEndpoint(prev => ({...prev, models}));
							void refreshModelWindows(provider, models);
						}
					});
				}
				// DeepSeek live integration: balance on the status line + the
				// fetched model catalog (both TTL-cached on disk, atomic
				// writes, shared in-flight, stale-safe — see src/deepseek.ts).
				if (isDeepSeek(provider)) {
					void refreshDeepSeekBalance(provider).then(balance => {
						if (balance) {
							setDeepSeekBalance({
								currency: balance.currency,
								total: balance.total,
								isAvailable: balance.isAvailable,
							});
						}
					});
					// Deduped: if the init already awaited a fetch above, this
					// returns the same result; on a warm cache it is instant.
					void refreshDeepSeekModels(provider).then(models => {
						if (models.length > 0) {
							setDiscoveredModels(prev => ({...prev, [provider.id]: models}));
							setActiveEndpoint(prev => ({...prev, models}));
							void refreshModelWindows(provider, models);
						}
					});
				}
			} catch (error) {
				appendInfo(
					`Provider error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			// E2: fallback chain, every OTHER provider, in order, tried when
			// the active one fails.
			setFallbackEndpoints(
				loadSettings().modelFallback
					? listProviders()
							.filter(provider => provider.id !== activeEndpoint().id)
							.map(provider => ({
								id: provider.id,
								baseUrl: provider.baseUrl,
								apiKey: provider.apiKeyResolved,
								model: provider.models[0] ?? 'mock-model-1',
								sdkProvider: provider.sdkProvider,
								codexAccount: provider.codexAccount,
								providerOptions: provider.providerOptions,
								promptCacheKey: provider.promptCacheKey,
							}))
					: [],
			);
		})();
	}
	// Runtime settings (mode/profile/message cap).
	{
		const settings = loadSettings();
		setMode(settings.mode);
		setToolProfile(settings.toolProfile);
		setMaxMessages(settings.maxMessages);
		if (settings.theme && THEMES[settings.theme]) {
			setThemeName(settings.theme);
		}
		setTitleShape(settings.titleShape ?? 'powerline-angled');
		setStatusLineEnabled(settings.statusLine !== false);
		setThinkingMode(settings.thinkingMode ?? 'hidden');
		setCavemanMode(settings.cavemanMode === true);
		setResumeCwdMode(settings.resumeCwd ?? 'session');
		autoCompactRef.enabled = settings.autoCompact.enabled;
		autoCompactRef.threshold = settings.autoCompact.threshold;
		watchdogMsRef = settings.watchdogMs ?? 0;
		streamGuardRef = settings.streamGuard ?? {};
		scrubberRef = createScrubber(settings.privacy?.patterns ?? []);
		steeringRef = loadSteeringConfig();
	}
	// A2: first-run trust gate. Only prompts when using the DEFAULT config dir
	//, isolated configs (parity runs, tests) are implicitly trusted.
	if (!process.env.BOBONYO_CONFIG_DIR && !process.env.NANOCODER_CONFIG_DIR) {
		const cwd = process.cwd();
		const trusted = (loadSettings().trustedDirs ?? []).includes(cwd);
		if (!trusted) {
			// Codex-style TRUST DIALOG (modal with explicit Yes/No), never
			// the free-text prompt row — that read like the chat input was
			// ready. Esc / No declines and EXITS: the app must not keep
			// running against an untrusted directory.
			setPendingTrust({
				directory: cwd,
				resolve: trust => {
					if (trust) {
						saveSettings({
							...loadSettings(),
							trustedDirs: [...(loadSettings().trustedDirs ?? []), cwd],
						});
					} else {
						exit();
					}
				},
			});
		}
	}
	// Post-open lazy loading: custom-tool file scans + MCP stdio handshakes
	// run in the background with a spinner indicator (parity: codex).
	const startupInit = async () => {
		// Each service loads on its OWN row and clears INDEPENDENTLY (skills
		// are file reads, MCP is a stdio handshake, LSP a sync binary scan —
		// one can finish long before the others).
		const startedAt = Date.now();
		setStartupLoading([
			{id: 'skills', label: 'Loading skills · tools'},
			{id: 'mcp', label: 'Loading MCP'},
			{id: 'lsp', label: 'Loading LSP'},
		]);
		// MIN_LOAD_MS floor: MCP can connect in one tick and the LSP scan is
		// synchronous, so without a floor the rows would vanish before the
		// glyph/dots could ever be seen animating.
		const MIN_LOAD_MS = 600;
		const finish = (id: string) => {
			const wait = Math.max(0, MIN_LOAD_MS - (Date.now() - startedAt));
			setTimeout(
				() => setStartupLoading(prev => prev.filter(item => item.id !== id)),
				wait,
			);
		};
		try {
			for (const tool of loadCustomTools()) {
				const registeredName = customToolRegistryName(tool.name);
				registerTool(registeredName, {
					source: 'custom',
					readOnly: tool.readOnly,
					approvalRequired: tool.approval || !tool.readOnly,
					description: tool.description,
					parameters: tool.parameters,
					execute: async (args, ctx) => {
						const expanded = expandCustomTool(tool, args);
						if (expanded.command) {
							const result = await runBash(
								expanded.command,
								ctx.onProgress,
								ctx.signal,
								ctx.cwd,
								ctx.onCwdChange,
								ctx.backgroundOwner ?? 'user',
								ctx.workspaceRoot,
							);
							return [result.content, expanded.body].filter(Boolean).join('\n');
						}
						return expanded.body;
					},
				});
			}
			finish('skills');
			for (const server of loadMCPConfig()) {
				try {
					const tools = await loadMCPServerTools(server);
					for (const tool of tools) {
						mcpToolsRef.push(tool);
						const safeServer = server.id
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, '_')
							.replace(/^_+|_+$/g, '');
						const safeTool = tool.name
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, '_')
							.replace(/^_+|_+$/g, '');
						const registeredName = `mcp__${safeServer}__${safeTool}`;
						registerTool(registeredName, {
							source: 'mcp',
							readOnly: tool.readOnly,
							approvalRequired: !tool.readOnly,
							description: tool.description,
							parameters: tool.parameters,
							execute: args => tool.call(args),
						});
					}
					setMcpServers(prev =>
						prev.includes(server.id) ? prev : [...prev, server.id],
					);
					// Do NOT log MCP lifecycle to the chat history (it would
					// hide the welcome banner on an empty conversation); the
					// animated loading indicator above the input + the
					// /status row surface the state instead.
				} catch (error) {
					// Best-effort; failures show via the loading indicator
					// clearing without that server in /status.
				}
			}
			finish('mcp');
			// Pre-warm the LSP discovery cache so `/status` opens instantly;
			// the indicator above the input covers it (parity: codex
			// lazy-loads MCP/LSP/skills after the app paints).
			detectLanguageServers();
			finish('lsp');
		} catch {
			// Best-effort init; never let the loader hang on a failure.
			setStartupLoading([]);
		} finally {
			// The catalog is final (built-ins + custom + MCP + LSP tool) once
			// lazy init settles; allow LLM turns from here on.
			startupReadyRef = true;
			if (currentGoal?.status === 'active') queueGoalContinuation();
			for (const job of loopJobsRef) scheduleLoopTimer(job);
		}
	};
	// F5: register markdown-defined custom tools from the config dirs.
	// Post-open LAZY init (parity: codex loads MCP/LSP/skills AFTER the
	// app paints, with a visible loading indicator). The first frame must not
	// wait on file scans or stdio MCP handshakes, defer them a tick so the
	// welcome banner/input render immediately.
	registerTool('lsp_get_diagnostics', {
		// C12 fixture override lets the parity scenario pin the status-line
		// LSP count; production returns the real "no issues" default.
		execute: () =>
			process.env.NANOCODER_DIAG_FIXTURE ?? 'Diagnostics: no issues found.',
	});
	setTimeout(() => void startupInit(), 0);

	const persist = () => {
		if (!currentSession) return;
		currentSession = {
			...currentSession,
			cwd: workspaceCwd(),
			updatedAt: Date.now(),
			firstMessage: firstMessagePreview(messages()),
			messages: messages().filter(message => message.kind !== 'info'),
			context: context(),
			goal: currentGoal,
			loopJobs: [...loopJobsRef],
			tasks: tasks().map(task => ({...task})),
			subagentRuns: activeAgentRuns().map(run => structuredClone(run)),
			// Record the model this conversation is running on, so a later
			// /resume can restore it instead of the most-recently used one.
			provider: activeEndpoint().id,
			model: activeEndpoint().model,
		};
		saveSession(currentSession);
		setSessionListVersion(version => version + 1);
	};

	const exit = () => {
		persist();
		void closeMCPServers();
		releaseHerdrAgent();
		renderer.destroy();
		// Goodbye screen (parity: the reference exit banner): the mascot banner
		// WITHOUT the box border + the session / continue hints. Written
		// SYNCHRONOUSLY, `process.exit(0)` would kill pending async writes.
		try {
			const box = buildBannerBox({
				titleShape: 'none',
				model: activeEndpoint().model,
				permissions: mode() === 'yolo' ? 'YOLO mode' : `${mode()} mode`,
				cwd: process.cwd(),
			});
			const created = new Date(
				currentSession?.createdAt ?? Date.now(),
			).toISOString();
			const goodbye =
				`\n${box}\n` +
				`  Session   ${sessionName()} - ${created}\n` +
				`  Continue  bobonyo --resume ${sessionId()}\n`;
			process.stdout.write(goodbye);
		} catch {
			// best-effort goodbye
		}
		// The FINAL exit is owned by index.tsx's renderer 'destroy' handler:
		// it drains the terminal's pending capability responses from stdin
		// before handing the TTY back to the shell (a synchronous exit here
		// would kill that drain and leak the responses as shell garbage).
	};

	const clear = () => {
		abortRef?.abort();
		resetFileUndoStack();
		setInput('');
		setCompletionMessage('');
		// /clear starts a fresh conversation: stop the COMPLETED popup.
		completionPopupController.cancel();
		setTasks([]);
		setSettingsOpen(false);
		setStatusOpen(false);
		setModelOpen(false);
		setModelModalInherit(false);
		clearMessages();
		// Resume can chdir into the saved conversation directory. `/clear`
		// starts a fresh conversation from the directory where TUI launched,
		// matching the shell's current working directory outside the TUI.
		try {
			process.chdir(launchCwd);
		} catch {
			// Launch directory may have been removed; keep current CWD.
		}
		updateWorkspaceCwd(process.cwd());
		setCurrentGoal(undefined);
		loopJobsRef = [];
		for (const timer of loopTimers.values()) clearTimeout(timer);
		loopTimers.clear();
		startNewSession();
		persist();
	};

	const startNewSession = (resumeRef?: string) => {
		compactionFailureRef = {...INITIAL_COMPACTION_FAILURE_STATE};
		autoCompactReentryFloorRef = 0;
		resetFileUndoStack();
		void runHooks({
			event: 'SessionStart',
			sessionSource: resumeRef
				? 'resume'
				: messages().length > 0
					? 'clear'
					: 'startup',
		});
		if (resumeRef) {
			const resumed = resolveSession(resumeRef);
			if (!resumed) {
				appendInfo(`No session found for '${resumeRef}'.`);
				// Inline list (listSessionsInfo is a later const, calling it
				// here during init would hit the TDZ).
				const sessions = listSessions();
				appendInfo(
					sessions.length === 0
						? 'No saved sessions yet.'
						: `Saved sessions (${sessions.length}):\n` +
								sessions
									.slice(0, 8)
									.map(
										(session, index) =>
											`  └ ${index} · ${session.id} · ${session.firstMessage}`,
									)
									.join('\n'),
				);
				return;
			}
			// The resume body is async ONLY for the `ask` cwd mode (the user
			// answers the directory prompt before the session fully loads);
			// everything up to the first await runs synchronously, so the
			// transcript/context render immediately.
			void (async () => {
				// LAZY BUFFER: a resumed session with a huge transcript is
				// capped to the bounded display window (older messages are
				// trimmed with a marker) so the render stays light even when
				// a pre-compaction session file survived.
				setMessages(capDisplayMessages(resumed.messages));
				// Heal pre-fix sessions whose provider context lagged the
				// transcript (interrupted turns never committed their user
				// messages) — otherwise a resumed conversation looks empty
				// to the model even though the transcript shows everything.
				// The heal is tail-lag only and capped to the live message
				// budget, so a healthy capped context is reused byte-for-byte
				// and the provider's prefix cache survives the resume.
				setContext(
					healResumedContext(resumed.context, resumed.messages, maxMessages()),
				);
				// CACHE HEAD PARITY: the system prompt's volatile block
				// carries the working directory + that dir's AGENTS.md (it
				// reads process.cwd()). A session resumed from a DIFFERENT
				// directory would rebuild a different head, and every
				// continued turn would miss the provider's byte-anchored
				// prefix cache (DeepSeek / Xiaomi automatic prefix caching)
				// — the cost the user sees. Restore the session's original
				// directory per the configured mode (codex ResumeCwdMode
				// parity): session = always restore (byte-identical head),
				// current = keep the launch dir, ask = prompt when they
				// differ.
				const tryChdir = (): boolean => {
					try {
						const previousCwd = process.cwd();
						process.chdir(resumed.cwd!);
						return process.cwd() !== previousCwd;
					} catch {
						// Original directory vanished/moved — keep the
						// current one (a one-time cold start, not a
						// per-turn cost).
						return false;
					}
				};
				let cwdChanged = false;
				const cwdDecision = resumeCwdDecision(
					resumeCwdMode(),
					process.cwd(),
					resumed.cwd,
				);
				if (cwdDecision === 'session') {
					cwdChanged = tryChdir();
				} else if (cwdDecision === 'ask') {
					const answer = await new Promise<string>(resolve =>
						setPendingPrompt({
							question: `Use the session directory ${resumed.cwd}? (y/N)`,
							resolve,
							onCancel: () => resolve(''),
						}),
					);
					if (/^y(es)?$/i.test(answer.trim())) {
						cwdChanged = tryChdir();
					}
				}
				updateWorkspaceCwd(process.cwd());
				// Arrow-up history parity: rebuild the prompt history from the
				// resumed conversation so ↑/↓ recall the prompts this session
				// actually sent (live sessions build the same list per turn,
				// capped at 100, newest last).
				setPromptHistory(promptHistoryFromMessages(resumed.messages));
				setHistoryIndex(-1);
				setSessionId(resumed.id);
				setSessionName(resumed.name);
				reportHerdrSession(resumed.id, process.cwd());
				reportHerdrAgent('idle', {
					message: `Resumed ${resumed.name}`,
					sessionId: resumed.id,
				});
				setUsageHistory([]);
				currentSession = {...resumed};
				setCurrentGoal(resumed.goal);
				loopJobsRef = [...(resumed.loopJobs ?? [])];
				const restoredTasks =
					resumed.tasks ??
					normalizeTaskList(
						[...resumed.messages]
							.reverse()
							.find(message => message.tool?.name === 'write_tasks')?.tool?.args
							?.tasks,
					);
				setTasks(
					restoredTasks.map((task, index) => ({
						...task,
						id: task.id || `task_${index + 1}`,
					})),
				);
				setActiveAgentRuns(
					(resumed.subagentRuns ?? [])
						.map(run =>
							run.status === 'running'
								? {
										...run,
										status: 'cancelled' as const,
										streaming: '',
										output:
											`${run.output}\nInterrupted by session restart.`.trim(),
									}
								: {...run},
						)
						.slice(-20),
				);
				for (const timer of loopTimers.values()) clearTimeout(timer);
				loopTimers.clear();
				for (const job of loopJobsRef) scheduleLoopTimer(job);
				// Model parity: the conversation keeps the model it ran on, NOT
				// the most-recently used one. If the session's provider/model is
				// no longer configured, fall back to the current model and tell
				// the user instead of silently switching.
				const sessionProvider = resumed.provider;
				const sessionModel = resumed.model;
				if (sessionProvider && sessionModel) {
					const provider = listProviders().find(
						candidate => candidate.id === sessionProvider,
					);
					const catalog =
						provider && (discoveredModels()[provider.id] ?? provider.models);
					if (provider && catalog?.includes(sessionModel)) {
						setActiveEndpoint({
							...activeEndpoint(),
							id: provider.id,
							name: provider.name ?? provider.id,
							baseUrl: provider.baseUrl,
							apiKey: provider.apiKeyResolved,
							model: sessionModel,
							models: discoveredModels()[provider.id] ?? provider.models,
							modelEfforts: provider.modelEfforts,
							contextWindow: effectiveContextWindow(
								provider.contextWindow,
								modelWindows()[provider.id]?.[sessionModel],
							),
							sdkProvider: provider.sdkProvider,
							codexAccount: provider.codexAccount,
							providerOptions: provider.providerOptions,
							effort: provider.modelEfforts[sessionModel],
							promptCacheKey: provider.promptCacheKey,
							alwaysAllow: provider.alwaysAllow,
						});
						savePreferences({
							lastProvider: provider.id,
							lastModel: sessionModel,
						});
						// Deferred: this resume branch can run during App boot,
						// BEFORE the later-defined loadProviderFeatures const is
						// initialized (TDZ). A tick later is fine — the model
						// restore + toast are already applied synchronously.
						setTimeout(() => loadProviderFeatures(provider), 0);
						showToast(`Resumed model: ${sessionModel} · ${provider.id}`);
					} else {
						showToast(
							`Session model ${sessionModel} (${sessionProvider}) is no longer available — continuing with ${activeEndpoint().model}.`,
						);
					}
				}
				// Temporary success-green notice above the input (parity: the
				// completion line) — cleared on the next prompt and after a few
				// seconds, never a persistent history row.
				if (resumeNoticeTimer) clearTimeout(resumeNoticeTimer);
				setCompletionTone('success');
				setCompletionMessage(
					`✔ Resumed session ${resumed.id} (${resumed.name}).` +
						(cwdChanged ? ` Working in ${process.cwd()}.` : ''),
				);
				resumeNoticeTimer = setTimeout(() => {
					setCompletionMessage('');
					setCompletionTone('default');
				}, 6000);
			})();
			return;
		}
		const id = newSessionId();
		setCurrentGoal(undefined);
		loopJobsRef = [];
		for (const timer of loopTimers.values()) clearTimeout(timer);
		loopTimers.clear();
		currentSession = {
			id,
			name: 'New conversation',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			firstMessage: '',
			// Record the folder the conversation was created in so /resume can
			// filter to the current cwd by default.
			cwd: process.cwd(),
			provider: activeEndpoint().id,
			model: activeEndpoint().model,
			messages: [],
			context: [],
			goal: undefined,
			loopJobs: [],
			tasks: [],
			subagentRuns: [],
		};
		setSessionId(id);
		setSessionName('New conversation');
		reportHerdrSession(id, process.cwd());
		reportHerdrAgent('idle', {
			message: 'Ready for input',
			sessionId: id,
		});
		saveSession(currentSession);
	};

	// `--resume [last|N|id]` from the CLI (set by index.tsx).
	if (process.env.NANOCODER_RESUME) {
		startNewSession(process.env.NANOCODER_RESUME);
		delete process.env.NANOCODER_RESUME;
	} else {
		startNewSession();
	}

	// GAP-19: Enter on a settings row opens the value editor (real prompt
	// form); provider rows point at /setup-providers.
	const editSettingRow = (row: SettingsRow) => {
		// Built-in AGENTS surface: open the dedicated modal (General/Explore).
		if (row.key === 'agents') {
			setSettingsOpen(false);
			setAgentsOpen(true);
			return;
		}
		// LIST surfaces: view-only data gets a proper modal list instead of a
		// "set value" prompt (parity: the original's managed setting panels).
		const openSettingsList = (title: string, rows: SettingsListRow[]) => {
			setSettingsList({title, rows});
		};
		switch (row.key) {
			case 'hooks':
				openSettingsList(
					'Hooks',
					listHooks().map(hook => ({
						label: `${hook.event} · ${hook.matcher}`,
						value: `${hook.source} · ${hook.type}${hook.async ? ' · async' : ''} · ${hook.target || '(empty)'}`,
					})),
				);
				return;
			case 'customCommands':
				openSettingsList('Custom commands', [
					...loadCustomCommands().map(command => ({
						label: `/${command.name}`,
						value: command.description,
						insert: `/${command.name} `,
					})),
				]);
				return;
			case 'skills':
				openSettingsList(
					'Skills',
					loadSkills().map(skill => ({
						label: skill.name,
						value: skill.description,
					})),
				);
				return;
			case 'customTools':
				openSettingsList(
					'Custom tools',
					loadCustomTools().map(tool => ({
						label: tool.name,
						value: tool.description,
					})),
				);
				return;
			case 'sessions':
				openSettingsList(
					'Sessions',
					listSessions().map(session => ({
						label: session.firstMessage || session.id,
						value: session.id,
						activateHint: 'resume',
						onActivate: () => {
							setSettingsList(null);
							resumeSession(session.id);
						},
					})),
				);
				return;
			case 'checkpoints':
				openSettingsList(
					'Checkpoints',
					listCheckpoints().map(data => ({
						label: data.name,
						value: `${data.messages.length} messages · ${new Date(
							data.createdAt,
						).toLocaleString()}`,
						activateHint: 'restore',
						onActivate: () => {
							setSettingsList(null);
							restoreCheckpoint(data.name);
						},
					})),
				);
				return;
			case 'steering':
				openSettingsList(
					'Steering (InnerDaemon)',
					steeringRef.rules.map(rule => ({
						label: rule.id,
						value: rule.message ?? rule.action,
					})),
				);
				return;
			case 'mcp':
				openSettingsList(
					'MCP servers',
					loadMCPConfig().map(server => ({
						label: server.id ?? server.command,
						value: `${server.command ?? ''}${
							mcpServers().includes(server.id ?? '')
								? ' · connected'
								: ' · not connected'
						}`,
					})),
				);
				return;
			case 'background':
				openSettingsList(
					'Background tasks',
					bgTasks().map(task => ({
						label: task.id,
						value: task.running ? 'running' : 'done',
					})),
				);
				return;
			case 'connectProvider':
				// Settings → Capabilities → Connect provider opens the same
				// opencode-style modal as /connect. CLOSE the settings modal
				// first: both surfaces register useKeyboard, so a key aimed
				// at the connect modal would also hit the settings behind it.
				setSettingsOpen(false);
				setConnectOpen({});
				return;
		}
		// Defer by a microtask: the SAME Enter keypress that opens the wizard
		// also reaches the InputBox's own key handler (OpenTUI dispatches to
		// every listener for one event). If the wizard existed synchronously,
		// InputBox would treat that Enter as the wizard's submit and close it
		// immediately with an empty value. Close the modal first so the
		// value editor (which lives in the input box) becomes visible.
		setSettingsOpen(false);
		queueMicrotask(() => {
			setPendingPrompt({
				question: `Set ${row.label}`,
				resolve: value => applySetting(row.key, value),
			});
		});
	};

	useKeyboard(event => {
		// COMPLETED popup: ANY key counts as user activity — dismisses a
		// visible popup, or CANCELS an armed one (the user is present, so
		// the attention modal must never appear). Never claims the key (no
		// preventDefault/stopPropagation), so typing the next prompt works
		// immediately.
		completionPopupController.activity();
		// Ctrl+P opens the settings modal from anywhere (parity: the reference
		// command-palette shortcut).
		if (event.ctrl && event.name === 'p') {
			setSettingsTab(0);
			setSettingsIndex(0);
			setSettingsOpen(true);
			return;
		}
		// GAP-19: the interactive settings panel owns the keys while open.
		if (
			settingsOpen() ||
			commandsOpen() ||
			statusOpen() ||
			modelOpen() ||
			agentsOpen() ||
			detailsOpen() ||
			resumeOpen() ||
			psOpen() ||
			connectOpen() ||
			effortOpen()
		) {
			// All modal keys (tabs/rows/search/Enter/Esc) are owned by the
			// modal's own useKeyboard, nothing may leak to the app outside.
			// preventDefault also stops the history scrollbox's native
			// arrow-key scrolling (global listeners run before renderable
			// handlers).
			event.preventDefault();
			return;
		}
		if (event.name === 'escape') {
			// B20: Esc interrupts an in-flight turn (partial committed); when
			// idle with an EMPTY input it asks for confirmation before
			// quitting (modal-style). With text in the input, Esc
			// dismisses/clears via the InputBox instead of quitting.
			if (running()) {
				interruptedRef = true;
				setCancelling(true);
				abortRef?.abort();
			} else if (input().length === 0 && exitConfirm()) {
				exit();
			} else if (input().length === 0) {
				setExitConfirm(true);
				// The confirmation EXPIRES after a few seconds, a stale
				// "press again to exit" must never linger.
				if (exitConfirmTimer) clearTimeout(exitConfirmTimer);
				exitConfirmTimer = setTimeout(() => setExitConfirm(false), 6000);
			}
			return;
		}
		if (event.ctrl && event.name === 'c') {
			// modal-style: Ctrl+C clears the input first; with an empty
			// input it confirms, then exits on the next press.
			if (input().length > 0) {
				setInput('');
				setExitConfirm(false);
			} else if (exitConfirm()) {
				exit();
			} else {
				setExitConfirm(true);
				if (exitConfirmTimer) clearTimeout(exitConfirmTimer);
				exitConfirmTimer = setTimeout(() => setExitConfirm(false), 6000);
			}
			return;
		}
		if (event.ctrl && event.name === 'r') {
			setThoughtExpanded(prev => !prev);
		}
		if (event.ctrl && event.name === 'o') {
			setToolsExpanded(prev => !prev);
		}
		if (event.ctrl && event.name === 't') {
			setToolsExpanded(prev => !prev);
		}
	});

	const processQueue = () => {
		if (queryActiveRef || busy() || pendingQueue().length === 0) return;
		const {item: next, remaining} = dequeuePendingWork(pendingQueue());
		if (!next) return;
		setPendingQueue(remaining);
		autonomousTurnRef =
			next.source === 'goal' ||
			(next.source === 'task' &&
				next.owner === 'goal' &&
				currentGoal?.status === 'active');
		loopTurnRef = next.source === 'loop';
		taskTurnRef = next.source === 'task';
		void submit(next.value, next.attachments);
	};
	function queueDetachedCompletion(
		kind: DetachedCompletion['kind'],
		id: string,
		status: DetachedCompletion['status'],
		output: string,
		owner: DetachedCompletion['owner'],
	): void {
		appendInfo(`Background ${kind} ${id} ${status}.`);
		setPendingQueue(previous =>
			enqueueTaskNotification(previous, {kind, id, status, output, owner}),
		);
		persist();
		queueMicrotask(processQueue);
	}

	function saveGoal(next: SessionGoal | undefined): void {
		setCurrentGoal(next);
		if (currentSession) currentSession.goal = next;
		persist();
	}

	function goalCommand(args: string): void {
		const input = args.trim();
		if (!input) {
			if (currentGoal) openInfoModal('Goal', formatGoal(currentGoal));
			else appendInfo('No goal is currently set. Usage: /goal <objective>');
			return;
		}
		const control = input.toLowerCase();
		if (control === 'edit') {
			if (!currentGoal) {
				appendInfo('No goal is currently set. Usage: /goal <objective>');
				return;
			}
			setPendingPrompt({
				question: 'Edit goal objective',
				resolve: objective => {
					const text = objective.trim();
					if (!text || !currentGoal) return;
					saveGoal({...currentGoal, objective: text, updatedAt: Date.now()});
					showToast('Goal updated');
				},
			});
			return;
		}
		if (control === 'clear') {
			const hadGoal = Boolean(currentGoal);
			saveGoal(undefined);
			cancelRunningBackgroundTasks('goal');
			goalContinuationPending = false;
			showToast(hadGoal ? 'Goal cleared' : 'No goal to clear');
			return;
		}
		if (['pause', 'resume', 'complete', 'blocked'].includes(control)) {
			if (!currentGoal) {
				appendInfo('No goal is currently set. Usage: /goal <objective>');
				return;
			}
			const status =
				control === 'pause'
					? 'paused'
					: control === 'resume'
						? 'active'
						: control === 'blocked'
							? 'blocked'
							: 'complete';
			const next = {
				...currentGoal,
				status,
				updatedAt: Date.now(),
			} as SessionGoal;
			saveGoal(next);
			if (status !== 'active') {
				setPendingQueue(previous =>
					previous.filter(item => item.source !== 'goal'),
				);
				cancelRunningBackgroundTasks('goal');
			}
			showToast(`Goal ${status}`);
			if (status === 'active' && !busy()) queueGoalContinuation();
			return;
		}
		const parsed = parseGoalSpec(input);
		if (!parsed) {
			appendInfo(
				'Usage: /goal <objective> [--tokens N] [--max-iterations N] [--completion-promise "TEXT"]',
			);
			return;
		}
		const now = Date.now();
		const goal: SessionGoal = {
			objective: parsed.objective,
			status: 'active',
			...(parsed.tokenBudget ? {tokenBudget: parsed.tokenBudget} : {}),
			...(parsed.maxIterations ? {maxIterations: parsed.maxIterations} : {}),
			...(parsed.completionPromise
				? {completionPromise: parsed.completionPromise}
				: {}),
			tokensUsed: 0,
			iteration: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		saveGoal(goal);
		showToast('Goal active');
		if (!busy()) queueGoalContinuation();
	}

	function loopCommand(args: string): void {
		const input = args.trim();
		if (!input) {
			openInfoModal(
				'Loop jobs',
				loopJobsRef.length > 0
					? loopJobsRef.map(formatLoopJob).join('\n')
					: 'No thread jobs are scheduled.\nUse /loop <spec> to create one.',
			);
			return;
		}
		const control = parseLoopControl(input);
		if (control === 'clear' || control === 'stop') {
			for (const timer of loopTimers.values()) clearTimeout(timer);
			loopTimers.clear();
			loopJobsRef = [];
			setPendingQueue(previous =>
				control === 'stop'
					? previous.filter(item => item.source !== 'loop')
					: previous,
			);
			cancelRunningBackgroundTasks('loop');
			persist();
			showToast(control === 'stop' ? 'Loop stopped' : 'Loop jobs cleared');
			return;
		}
		if (control && typeof control === 'object') {
			const id = control.deleteId;
			const before = loopJobsRef.length;
			loopJobsRef = loopJobsRef.filter(job => job.id !== id);
			const timer = loopTimers.get(id);
			if (timer) clearTimeout(timer);
			loopTimers.delete(id);
			persist();
			showToast(
				before === loopJobsRef.length
					? `Loop job not found: ${id}`
					: `Loop job deleted: ${id}`,
			);
			return;
		}
		const parsed = parseLoopSpec(input);
		if (!parsed) {
			appendInfo(
				'Usage: /loop [@after-turn <prompt> | @every 5m <prompt> | once after 30s <prompt> | stop | delete <id> | clear]',
			);
			return;
		}
		const job = newLoopJob(parsed);
		loopJobsRef = [...loopJobsRef, job];
		scheduleLoopTimer(job);
		persist();
		showToast(`Loop job created: ${job.cronExpression}`);
	}

	function scheduleLoopTimer(job: LoopJob): void {
		const existing = loopTimers.get(job.id);
		if (existing) clearTimeout(existing);
		const interval = loopIntervalMs(job.cronExpression);
		if (!interval) return;
		const delay = Math.max(
			0,
			(job.nextRunAt ?? Date.now() + interval) - Date.now(),
		);
		const timer = setTimeout(() => {
			loopTimers.delete(job.id);
			if (!loopJobsRef.some(candidate => candidate.id === job.id)) return;
			if (busy() || startupReadyRef === false) {
				job.nextRunAt = Date.now() + 1000;
				scheduleLoopTimer(job);
				return;
			}
			fireLoopJob(job);
		}, delay);
		timer.unref?.();
		loopTimers.set(job.id, timer);
	}

	function fireLoopJob(job: LoopJob): void {
		job.lastRunAt = Date.now();
		if (job.runOnce) {
			loopJobsRef = loopJobsRef.filter(candidate => candidate.id !== job.id);
		} else {
			const interval = loopIntervalMs(job.cronExpression);
			if (interval) {
				job.nextRunAt = Date.now() + interval;
				scheduleLoopTimer(job);
			}
		}
		persist();
		setPendingQueue(previous => [
			...previous,
			{value: job.prompt, source: 'loop'},
		]);
		queueMicrotask(processQueue);
	}

	function fireAfterTurnJobs(): void {
		const jobs = loopJobsRef.filter(
			job => job.cronExpression === '@after-turn',
		);
		if (jobs.length === 0) return;
		setPendingQueue(previous => [
			...previous,
			...jobs.map(job => ({value: job.prompt, source: 'loop' as const})),
		]);
		for (const job of jobs) {
			job.lastRunAt = Date.now();
			if (job.runOnce) {
				loopJobsRef = loopJobsRef.filter(candidate => candidate.id !== job.id);
			}
		}
	}

	function queueGoalContinuation(): void {
		if (
			!currentGoal ||
			currentGoal.status !== 'active' ||
			goalContinuationPending
		)
			return;
		if (pendingQueue().some(item => item.source === 'goal')) return;
		// Task completions wake the model with exact output. Do not burn goal
		// iterations polling work that is still running.
		if (activeBgCount() > 0 || activeAgents() > 0) return;
		if (
			currentGoal.tokenBudget &&
			currentGoal.tokensUsed >= currentGoal.tokenBudget
		) {
			saveGoal({
				...currentGoal,
				status: 'budget-limited',
				updatedAt: Date.now(),
			});
			showToast('Goal limited by token budget');
			return;
		}
		const iteration = currentGoal.iteration ?? 0;
		if (currentGoal.maxIterations && iteration >= currentGoal.maxIterations) {
			saveGoal({
				...currentGoal,
				status: 'iteration-limited',
				updatedAt: Date.now(),
			});
			showToast('Goal reached iteration limit');
			return;
		}
		const nextGoal = {
			...currentGoal,
			iteration: iteration + 1,
			updatedAt: Date.now(),
		};
		saveGoal(nextGoal);
		goalContinuationPending = true;
		const prompt = goalContinuationPrompt(nextGoal);
		setPendingQueue(previous =>
			previous.some(item => item.source === 'goal')
				? previous
				: [...previous, {value: prompt, source: 'goal'}],
		);
		goalContinuationPending = false;
		queueMicrotask(processQueue);
	}

	/** Model-facing question tool: input row resolves one explicit answer. */
	const askUser = async (
		question: string,
		options?: Array<{label: string; description?: string}>,
		multiple?: boolean,
	): Promise<string> =>
		new Promise(resolve => {
			reportHerdrAgent('blocked', {
				message: 'Question requires user input',
				sessionId: sessionId(),
			});
			if (process.env.NANOCODER_NONINTERACTIVE) {
				resolve('');
				return;
			}
			const headerMatch = /^\[([^\]]+)\]\s*/.exec(question);
			setPendingQuestion({
				header: headerMatch?.[1],
				question: question.replace(/^\[[^\]]+\]\s*/, ''),
				options: options ?? [],
				multiple,
				resolve,
			});
		});

	/** B16: one confirmation per call; the input row resolves y/n. */
	const approvalGate = async (
		name: string,
		detail: string,
	): Promise<boolean> => {
		const hook = await runHooks({
			event: 'PermissionRequest',
			toolName: name,
			toolInput: {detail},
		});
		if (hook.denied) return false;
		return new Promise(resolve => {
			reportHerdrAgent('blocked', {
				message: `${name}: approval required`,
				sessionId: sessionId(),
			});
			// B16: non-interactive stdin (piped/CI) auto-DECLINES mutations.
			if (process.env.NANOCODER_NONINTERACTIVE) {
				resolve(false);
				return;
			}
			setPendingApproval({name, detail, resolve});
		});
	};

	const refreshContextPercent = () => {
		const model = activeEndpoint().model;
		const projected = projectProviderMessages(context(), model);
		const tokens = estimateContextTokens(
			projected,
			model,
			`${buildSystemPrompt(toolProfile())}\n${JSON.stringify(toolCatalogForModel(model))}`,
		);
		const window = activeEndpoint().contextWindow;
		setContextPercent(
			window > 0 ? Math.min(100, Math.round((tokens / window) * 100)) : 0,
		);
	};

	/** Codex-style threshold check against history about to be sampled. */
	const shouldAutoCompactHistory = (history: ChatMessageLike[]): boolean => {
		if (
			!autoCompactRef.enabled ||
			!canAttemptAutoCompaction(compactionFailureRef)
		)
			return false;
		const model = activeEndpoint().model;
		const projected = projectProviderMessages(history, model);
		const tokens = estimateContextTokens(
			projected,
			model,
			`${buildSystemPrompt(toolProfile())}\n${JSON.stringify(toolCatalogForModel(model))}`,
		);
		const window = activeEndpoint().contextWindow;
		const messageTriggered = shouldAutoCompactContext({
			estimatedTokens: 0,
			contextWindow: window,
			thresholdPercent: autoCompactRef.threshold,
			messageCount: history.length,
			messageCap: maxMessages(),
			messageMargin: AUTO_COMPACT_MESSAGE_MARGIN,
		});
		if (messageTriggered) return true;
		if (tokens < autoCompactReentryFloorRef) return false;
		if (autoCompactReentryFloorRef > 0) autoCompactReentryFloorRef = 0;
		return tokens >= autoCompactTokenLimit(window, autoCompactRef.threshold);
	};
	const runCustomCommand = (name: string, args: string) => {
		const command = findCustomCommand(name);
		if (!command) {
			appendInfo(`Custom command /${name} not found.`);
			return;
		}
		const spec = command.arguments;
		const tokens = quoteAwareSplit(args);
		const required = spec.filter(arg => arg.required).length;
		if (tokens.length < required) {
			appendInfo(
				`Usage: /${name} ${spec
					.map(arg =>
						arg.rest
							? `[${arg.name}…]`
							: arg.required
								? `<${arg.name}>`
								: `[${arg.name}]`,
					)
					.join(' ')}`,
			);
			return;
		}
		// Expand command arguments into the MODEL prompt. Free-form trailing
		// intent is appended as `ARGUMENTS:` when the command declares no
		// placeholder (OpenClaude parity), never silently discarded.
		const prompt = expandCommandPrompt({
			body: command.body,
			rawArgs: args,
			spec,
			tokens,
		}).trim();
		if (!prompt) {
			appendInfo(`Custom command /${name} has an empty prompt.`);
			return;
		}
		// Reviewer lenses belong to PR creation only. Release commands may
		// merge an already-reviewed PR; rerunning every lens there wastes time
		// and differs from Claude/OpenClaude/OpenCode command behavior.
		const workflowReview = /^create-pr$/i.test(command.name)
			? '\n\nMANDATORY WORKFLOW GATE: Before pushing or creating the PR, call the `review_changes` tool. Wait for all configured review-* subagents. Do not bypass REVIEW_FINDINGS or REVIEW_UNAVAILABLE without explicit user approval.'
			: '';
		const interpretedPrompt = buildCommandInvocationPrompt({
			name: command.name,
			description: command.description,
			userRequest: args,
			guidance: prompt + workflowReview,
		});
		void submit(interpretedPrompt, undefined, {
			kind: 'command',
			name: command.name,
			// The ORIGINAL typed command (e.g. `/worktree purpose: hello
			// world`) is what the transcript shows as the user row; the body
			// above is what the provider actually sees.
			original: args ? `/${command.name} ${args}` : `/${command.name}`,
			body: prompt,
		});
	};

	/** B15: consecutive identical noop traces collapse into one `×N` row. */
	const appendNoopRow = (row: string) => {
		const current = messages();
		for (let i = current.length - 1; i >= 0; i--) {
			const message = current[i]!;
			if (
				message.kind === 'info' &&
				message.content.startsWith('InnerDaemon')
			) {
				const match = /^(.*?· noop)( ×\d+)?$/.exec(message.content);
				if (match && match[1] === row) {
					const count = Number(match[2]?.slice(2) ?? 1) + 1;
					setMessages(prev =>
						prev.map((item, index) =>
							index === i ? {...item, content: `${match[1]} ×${count}`} : item,
						),
					);
					return;
				}
				break;
			}
			if (message.role === 'tool') break;
			continue;
		}
		appendInfo(row);
	};

	const modeSwitch = (args: string) => {
		const MODES: Mode[] = ['yolo', 'auto-accept', 'normal', 'plan'];
		const name = args.trim();
		if (!name) {
			appendInfo(`Mode: ${mode()}\nAvailable: ${MODES.join(', ')}`);
			return;
		}
		if (!MODES.includes(name as Mode)) {
			appendInfo(`Unknown mode '${name}'. Available: ${MODES.join(', ')}`);
			return;
		}
		setMode(name as Mode);
		saveSettings({...loadSettings(), mode: name as Mode});
		showToast(`Mode: ${name}`);
	};

	const tuneSwitch = (args: string) => {
		const PROFILES: ToolProfile[] = ['full', 'minimal', 'nano', 'auto'];
		const name = args.trim();
		if (!name) {
			appendInfo(
				`Tool profile: ${toolProfile()}\nAvailable: ${PROFILES.join(', ')}`,
			);
			return;
		}
		if (!PROFILES.includes(name as ToolProfile)) {
			appendInfo(
				`Unknown profile '${name}'. Available: ${PROFILES.join(', ')}`,
			);
			return;
		}
		setToolProfile(name as ToolProfile);
		saveSettings({...loadSettings(), toolProfile: name as ToolProfile});
		showToast(`Tool profile: ${name}`);
	};

	// A9: tabbed settings surface, `/settings [general|providers|session|
	// about]` shows a tab, `/settings set <key> <value>` edits a value.
	const settingsSurface = (args: string) => {
		const [tabArg, ...rest] = args.trim().split(/\s+/);
		if (tabArg?.toLowerCase() === 'set') {
			applySetting(rest[0] ?? '', rest.slice(1).join(' '));
			return;
		}
		// GAP-19: open the interactive panel (←/→ tabs, ↑/↓ rows, Enter edit).
		if (!tabArg) {
			setSettingsTab(0);
			setSettingsIndex(0);
			setSettingsOpen(true);
			return;
		}
		const TABS = ['general', 'providers', 'session', 'about'];
		const current = TABS.includes((tabArg ?? '').toLowerCase())
			? (tabArg ?? '').toLowerCase()
			: 'general';
		const tabBar = `Settings [${TABS.map(tab => (tab === current ? `*${tab}*` : tab)).join(' | ')}]`;
		switch (current) {
			case 'providers':
				appendInfo(
					`${tabBar}\n${listProviders()
						.map(
							provider =>
								`  └ ${provider.id}, ${provider.baseUrl} (${provider.models.length} models)`,
						)
						.join('\n')}\n\n` +
						`Edit: /setup-providers edit <id> · Add: /setup-providers · Delete: /setup-providers delete <id>`,
				);
				return;
			case 'session':
				appendInfo(
					`${tabBar}\n` +
						`  └ session: ${sessionId()} · ${sessionName()}\n` +
						`  └ checkpoints: ${listCheckpoints().length}\n` +
						`  └ trusted dirs: ${(loadSettings().trustedDirs ?? []).length}`,
				);
				return;
			case 'about':
				appendInfo(
					`${tabBar}\n` +
						`  └ ${VERSION} · OpenTUI rewrite\n` +
						`  └ config dir: ${configDir()}`,
				);
				return;
			default:
				appendInfo(
					`${tabBar}\n` +
						`  └ mode: ${mode()}\n` +
						`  └ tool profile: ${toolProfile()}\n` +
						`  └ max messages: ${maxMessages()}\n` +
						`  └ auto-compact: ${
							autoCompactRef.enabled
								? `on (threshold ${autoCompactRef.threshold}%)`
								: 'off'
						}\n\n` +
						`Set a value: /settings set <mode|profile|maxMessages|autoCompactThreshold|resumeCwd> <value>`,
				);
		}
	};

	const applySetting = (key: string, value: string) => {
		const settings = loadSettings();
		switch (key) {
			case 'mode': {
				const next = value as Mode;
				if (!['yolo', 'auto-accept', 'normal', 'plan'].includes(next)) {
					appendInfo(`Invalid mode '${value}'.`);
					return;
				}
				setMode(next);
				saveSettings({...settings, mode: next});
				return;
			}
			case 'profile': {
				const next = value as ToolProfile;
				if (!['full', 'minimal', 'nano', 'auto'].includes(next)) {
					appendInfo(`Invalid profile '${value}'.`);
					return;
				}
				setToolProfile(next);
				saveSettings({...settings, toolProfile: next});
				return;
			}
			case 'maxMessages': {
				const num = Number(value);
				if (!Number.isFinite(num) || num <= 0) {
					appendInfo(`Invalid maxMessages '${value}'.`);
					return;
				}
				setMaxMessages(num);
				saveSettings({...settings, maxMessages: num});
				return;
			}
			case 'modelFallback': {
				const enabled = ['on', 'true', '1'].includes(
					value.trim().toLowerCase(),
				);
				const disabled = ['off', 'false', '0'].includes(
					value.trim().toLowerCase(),
				);
				if (!enabled && !disabled) {
					appendInfo(`Invalid model fallback '${value}'. Use on/off.`);
					return;
				}
				saveSettings({...settings, modelFallback: enabled});
				setFallbackEndpoints(
					enabled
						? listProviders()
								.filter(provider => provider.id !== activeEndpoint().id)
								.map(provider => ({
									id: provider.id,
									baseUrl: provider.baseUrl,
									apiKey: provider.apiKeyResolved,
									model: provider.models[0] ?? 'mock-model-1',
									sdkProvider: provider.sdkProvider,
									codexAccount: provider.codexAccount,
									providerOptions: provider.providerOptions,
									promptCacheKey: provider.promptCacheKey,
								}))
						: [],
				);
				showToast(`Model fallback: ${enabled ? 'on' : 'off'}`);
				return;
			}
			case 'autoCompactThreshold': {
				const num = Math.max(50, Math.min(95, Number(value.replace(/%$/, ''))));
				if (!Number.isFinite(num)) {
					appendInfo(`Invalid threshold '${value}'.`);
					return;
				}
				autoCompactRef.enabled = true;
				autoCompactRef.threshold = num;
				saveSettings({
					...settings,
					autoCompact: {enabled: true, threshold: num},
				});
				return;
			}
			case 'theme': {
				const next = value.trim().toLowerCase();
				if (!THEMES[next]) {
					appendInfo(
						`Unknown theme '${value}'. Available: ${Object.keys(THEMES).join(', ')}`,
					);
					return;
				}
				selectTheme(next);
				return;
			}
			case 'watchdog': {
				const ms = Number(value);
				if (!Number.isFinite(ms) || ms < 0) {
					appendInfo(`Invalid watchdog '${value}'.`);
					return;
				}
				watchdogMsRef = ms;
				saveSettings({...settings, watchdogMs: ms});
				return;
			}
			case 'streamGuard': {
				const ms = Number(value);
				if (!Number.isFinite(ms) || ms < 0) {
					appendInfo(`Invalid stream guard '${value}'.`);
					return;
				}
				streamGuardRef = {...streamGuardRef, maxDurationMs: ms};
				saveSettings({
					...settings,
					streamGuard: {...settings.streamGuard, maxDurationMs: ms},
				});
				return;
			}
			case 'titleShape': {
				const next = value.trim().toLowerCase();
				if (!['powerline-angled', 'tiny', 'none'].includes(next)) {
					appendInfo(
						`Invalid title shape '${value}'. Available: powerline-angled, tiny, none`,
					);
					return;
				}
				setTitleShape(next);
				saveSettings({...settings, titleShape: next});
				return;
			}
			case 'statusLine': {
				const next = value.trim().toLowerCase();
				const on = next === 'on' || next === 'true' || next === '1';
				const off = next === 'off' || next === 'false' || next === '0';
				if (!on && !off) {
					appendInfo(`Invalid status line '${value}'. Use on/off.`);
					return;
				}
				setStatusLineEnabled(on);
				saveSettings({...settings, statusLine: on});
				return;
			}
			case 'thinkingMode': {
				const next = value.trim().toLowerCase();
				if (!['hidden', 'show', 'line'].includes(next)) {
					appendInfo(`Invalid thinking mode '${value}'. Use hidden/show/line.`);
					return;
				}
				setThinkingMode(next as 'hidden' | 'show' | 'line');
				saveSettings({
					...settings,
					thinkingMode: next as 'hidden' | 'show' | 'line',
				});
				return;
			}
			case 'cavemanMode': {
				const next = value.trim().toLowerCase();
				const on = next === 'on' || next === 'true' || next === '1';
				const off = next === 'off' || next === 'false' || next === '0';
				if (!on && !off) {
					appendInfo(`Invalid caveman mode '${value}'. Use on/off.`);
					return;
				}
				setCavemanMode(on);
				saveSettings({...settings, cavemanMode: on});
				return;
			}
			case 'systemPrompt': {
				const next = value.trim().toLowerCase();
				if (!SYSTEM_PROMPT_STYLES.includes(next as SystemPromptStyle)) {
					appendInfo(
						`Invalid system prompt '${value}'. Use ${SYSTEM_PROMPT_STYLES.join(', ')}.`,
					);
					return;
				}
				saveSettings({...settings, systemPrompt: next});
				if (next === 'custom') {
					// Seed SYSTEM.md with the built-in prompt so the user has
					// a starting point to edit in any editor.
					seedCustomSystemPrompt(buildSystemPrompt());
					showToast(`Custom prompt: edit ${systemPromptPath()}`);
				} else {
					showToast(`System prompt: ${next}`);
				}
				return;
			}
			case 'respectGitignore': {
				const next = value.trim().toLowerCase();
				const on = next === 'on' || next === 'true' || next === '1';
				const off = next === 'off' || next === 'false' || next === '0';
				if (!on && !off) {
					appendInfo(`Invalid gitignore setting '${value}'. Use on/off.`);
					return;
				}
				saveSettings({...settings, respectGitignore: on});
				showToast(`Respect gitignore: ${on ? 'on' : 'off'}`);
				return;
			}
			case 'sandbox': {
				const next = value.trim().toLowerCase();
				if (!['auto', 'workspace-write', 'read-only', 'off'].includes(next)) {
					appendInfo(
						`Invalid sandbox mode '${value}'. Use auto, workspace-write, read-only or off.`,
					);
					return;
				}
				saveSettings({
					...settings,
					sandbox: {
						...(settings.sandbox ?? {
							network: true,
							writablePaths: [],
						}),
						mode: next as 'auto' | 'workspace-write' | 'read-only' | 'off',
					},
				});
				showToast(`Command sandbox: ${next}`);
				return;
			}
			case 'sandboxNetwork': {
				const next = value.trim().toLowerCase();
				const on = next === 'on' || next === 'true' || next === '1';
				const off = next === 'off' || next === 'false' || next === '0';
				if (!on && !off) {
					appendInfo(`Invalid sandbox network '${value}'. Use on/off.`);
					return;
				}
				saveSettings({
					...settings,
					sandbox: {
						...(settings.sandbox ?? {
							mode: 'auto',
							writablePaths: [],
						}),
						network: on,
					},
				});
				showToast(`Sandbox network: ${on ? 'on' : 'off'}`);
				return;
			}
			case 'resumeCwd': {
				const next = value.trim().toLowerCase() as ResumeCwdMode;
				if (!['session', 'current', 'ask'].includes(next)) {
					appendInfo(
						`Invalid resume working dir '${value}'. Use session, current or ask.`,
					);
					return;
				}
				setResumeCwdMode(next);
				saveSettings({...settings, resumeCwd: next});
				return;
			}
			default:
				appendInfo(
					`Unknown setting '${key}'. Available: mode, profile, maxMessages, autoCompactThreshold, theme, watchdog, streamGuard, titleShape, statusLine, thinkingMode, cavemanMode, respectGitignore, resumeCwd`,
				);
		}
	};

	/**
	 * `/setup-providers` — MODAL provider management. `delete` stays a
	 * display-only command (no prompts); edit/add open the connect modal.
	 */
	const setupProviders = async (args: string) => {
		if (busy()) {
			appendInfo('Cannot manage providers while a turn is running.');
			return;
		}
		const [action, idArg] = args.trim().split(/\s+/);
		if (action === 'delete' && idArg) {
			deleteProvider(idArg);
			return;
		}
		if (action === 'edit' && idArg) {
			setConnectOpen({editId: idArg});
			return;
		}
		setConnectOpen({});
	};

	/** `/codex` — open the Codex connect modal (ChatGPT account or key). */
	const connectCodex = async () => {
		if (busy()) {
			appendInfo('Cannot connect while a turn is running.');
			return;
		}
		setConnectOpen({provider: 'codex'});
	};

	/** `/connect` — open the provider-connect modal (opencode-style). */
	const connectProvider = async (args: string) => {
		if (busy()) {
			appendInfo('Cannot connect while a turn is running.');
			return;
		}
		const name = args.trim().toLowerCase();
		if (name === 'codex') {
			setConnectOpen({provider: 'codex'});
			return;
		}
		if (name === 'custom') {
			setConnectOpen({provider: 'custom'});
			return;
		}
		setConnectOpen({});
	};

	/**
	 * The connect modal's save action: upsert the provider into the config,
	 * refresh the model catalogs, and (opencode parity) drop the user into
	 * the model picker afterwards — unless this was an EDIT opened from the
	 * settings surface, where the modal closes back to the settings list.
	 */
	const saveConnectedProvider = (provider: ProviderConfig) => {
		const config = loadConfig();
		// An EDIT is also a save whose id ALREADY exists (the connect modal's
		// manage step edits an existing connection without a settings
		// editId). Only a genuinely NEW id drops into the model picker
		// afterwards.
		const wasEdit =
			Boolean(connectOpen()?.editId) ||
			config.providers.some(
				candidate => candidate.id.toLowerCase() === provider.id.toLowerCase(),
			);
		config.providers = config.providers.filter(
			candidate => candidate.id.toLowerCase() !== provider.id.toLowerCase(),
		);
		config.providers.push(provider);
		saveConfig(config);
		refreshModelCatalogs();
		// Editing the ACTIVE provider applies the new base URL/credentials
		// immediately instead of waiting for a model switch.
		if (activeEndpoint().id.toLowerCase() === provider.id.toLowerCase()) {
			setActiveEndpoint(prev => ({
				...prev,
				baseUrl: provider.baseUrl,
				apiKey: resolveApiKey(provider.apiKey),
				sdkProvider: provider.sdkProvider,
				codexAccount: provider.codexAccount,
				providerOptions: provider.providerOptions,
				promptCacheKey: provider.promptCacheKey,
				alwaysAllow: provider.alwaysAllow,
			}));
		}
		setConnectOpen(null);
		showToast(`Provider '${provider.id}' connected`);
		if (!wasEdit) {
			setModelModalInherit(false);
			setFallbackTarget(null);
			setModelOpen(true);
		}
	};

	/**
	 * Delete a provider from the config: `/provider delete <id>` AND the
	 * connect modal's manage step (`d` → `y`). Clears the saved preference
	 * when it points at the deleted provider, and switches the ACTIVE
	 * endpoint away so the next turn never dials a deleted endpoint.
	 */
	const deleteProvider = (id: string) => {
		// Deleting the provider that the saved preference points at must
		// clear the preference — otherwise the next start resolves a
		// provider that no longer exists and falls back to the mock
		// provider (`mock-model-1`).
		const {config, prefs} = applyProviderDeletion(
			loadConfig(),
			loadPreferences(),
			id,
		);
		saveConfig(config);
		savePreferences(prefs);
		if (activeEndpoint().id.toLowerCase() === id.toLowerCase()) {
			const next = listProviders()[0];
			if (next) {
				setActiveEndpoint({
					...activeEndpoint(),
					id: next.id,
					name: next.name ?? next.id,
					baseUrl: next.baseUrl,
					apiKey: next.apiKeyResolved,
					model: next.models[0] ?? 'mock-model-1',
					models: next.models,
					modelEfforts: next.modelEfforts,
					contextWindow: next.contextWindow ?? 128_000,
					sdkProvider: next.sdkProvider,
					codexAccount: next.codexAccount,
					providerOptions: next.providerOptions,
					promptCacheKey: next.promptCacheKey,
					alwaysAllow: next.alwaysAllow,
				});
				savePreferences({
					...loadPreferences(),
					lastProvider: next.id,
					lastModel: next.models[0] ?? 'mock-model-1',
				});
			}
		}
		// One-off confirmations are TOASTS — never transcript rows (the
		// chat history must only ever contain actual conversation).
		showToast(`Provider '${id}' deleted`);
	};

	const submit = async (
		value: string,
		attachments?: Record<string, string>,
		command?: {
			kind: 'command' | 'skill';
			name: string;
			original?: string;
			body: string;
		},
	) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		if (attachments && Object.keys(attachments).length > 0) {
			attachments = persistImageAttachments(trimmed, attachments, sessionId());
		}

		// Vision fallback (Settings → Capabilities → Vision model): when the
		// prompt carries `[Image #N]` attachments and a vision model is
		// configured, analyze each image through THAT model and hand the
		// description to the main (possibly text-only) agent, with a chat
		// indicator mirroring the web-search fallback line.
		let prompt = trimmed;
		const imageTokens = [...trimmed.matchAll(/\[Image #(\d+)\]/g)];
		const visionFallback = resolveVisionFallback();
		const nativeVision = supportsNativeImageInput(activeEndpoint());
		if (
			imageTokens.length > 0 &&
			visionFallback &&
			attachments &&
			!nativeVision
		) {
			let replaced = 0;
			for (const match of imageTokens) {
				const path = attachments[match[1] ?? ''];
				if (!path) continue;
				try {
					const description = await analyzeImageWithFallback(
						path,
						'Describe this image for a text-only assistant that cannot see it. ' +
							'Be specific about visible text, layout, colors, UI elements, and anything ' +
							'another agent might need to act on.',
					);
					if (description.trim()) {
						prompt = prompt.replace(
							match[0],
							`<image-description>\n${description.trim()}\n</image-description>`,
						);
						replaced += 1;
					}
				} catch (error) {
					// Best-effort: keep the [Image #N] token so the main model
					// still sees the attachment reference, but surface the
					// failure so a misconfigured fallback is debuggable.
					appendInfo(
						`Vision fallback failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			if (replaced > 0) {
				appendWarning(
					`  ✦ Vision fallback: ${visionFallback.model} analyzed ${replaced} image${replaced === 1 ? '' : 's'} → ` +
						`${activeEndpoint().model} responds`,
				);
			}
		}

		// `!command` → user-invoked bash (Executed Bash), never sent to the LLM.
		if (prompt.startsWith('!')) {
			setInput('');
			const command = prompt.slice(1).trim();
			const result = await runBash(
				command,
				undefined,
				undefined,
				workspaceCwd(),
				next => {
					updateWorkspaceCwd(next);
					persist();
				},
				'user',
				workspaceRoot,
			);
			if (result.cwd) setWorkspaceCwd(result.cwd);
			appendMessage({
				role: 'tool',
				content: `✦ Executed Bash(${command})`,
				tool: {
					name: 'execute_bash:user',
					detail: command,
					output: result.content,
				},
			});
			persist();
			return;
		}

		// `/command` → slash-command pipeline (display-only output).
		if (prompt.startsWith('/')) {
			setInput('');
			// `/goal` is a user command, not the generated continuation prompt.
			// Keep the command in arrow history so ↑ recalls what the user typed.
			if (/^\/goal(?:\s|$)/i.test(prompt)) {
				setPromptHistory(prev =>
					prev[prev.length - 1] === prompt
						? prev
						: [...prev.slice(-99), prompt],
				);
				setHistoryIndex(-1);
			}
			runCommand(prompt, {
				exit,
				clear,
				compact,
				goal: goalCommand,
				loop: loopCommand,
				fork,
				herdrFork,
				submitPrompt: (prompt, command) => {
					// /mock:confirm previews the LIVE approval box, approval
					// only prompts in `normal` mode, so switch first.
					if (prompt === 'confirm' && mode() !== 'normal') {
						setMode('normal');
						saveSettings({...loadSettings(), mode: 'normal'});
						appendInfo('Switched to normal mode for the confirmation preview.');
					}
					void submit(prompt, undefined, command);
				},
				retry: retryLast,
				undo: undoLast,
				rewind,
				resume: resumeSession,
				rename,
				usage,
				sessions: listSessionsInfo,
				openPRs,
				status,
				model: switchModel,
				setEffort: switchEffort,
				providers: listProvidersInfo,
				custom: runCustomCommand,
				modeSwitch,
				settings: settingsSurface,
				setupProviders,
				connectCodex,
				codexReset,
				connectProvider,
				mcp: mcpSurface,
				session: sessionCommand,
				checkpoint,
				checkpoints: checkpointsSurface,
				restore: restoreCheckpoint,
				tune: tuneSwitch,
				help,
				commandsList,
				toolsList,
				skillsList,
				tasksList,
				ps: () => {
					setPsInitialTab(
						activeBgCount() > 0
							? 'jobs'
							: activeAgents() > 0
								? 'agents'
								: visibleGoal()?.status === 'active'
									? 'goal'
									: 'jobs',
					);
					setPsOpen(true);
				},
				version: versionInfo,
				credits,
				doctor,
				privacy: privacyInfo,
				statusline: statuslineInfo,
				lspInfo,
				innerdaemonInfo,
				scheduleInfo,
				updateInfo,
				exportSession,
				contextMax,
				setupConfigInfo,
				setupMcpInfo,
				remember,
				forget,
				preferences,
			});
			return;
		}

		const promptHook = await runHooks({event: 'UserPromptSubmit', prompt});
		if (promptHook.denied) {
			appendWarning(promptHook.denied);
			return;
		}
		if (typeof promptHook.updatedInput?.prompt === 'string') {
			prompt = promptHook.updatedInput.prompt;
		}
		if (promptHook.additionalContext.length > 0) {
			prompt += `\n\n${promptHook.additionalContext.join('\n')}`;
		}

		// Chat while busy → queued (submitted when the turn settles).
		// CACHE HEAD GATE: never fire the first LLM request while lazy
		// MCP/custom-tool loading is still registering tools (the catalog is
		// the cache head; a mid-session tool arrival would change the prefix
		// and miss the provider's prompt cache for every later turn).
		if (!startupReadyRef) {
			appendInfo('Still loading tools (MCP/skills)… try again in a moment.');
			return;
		}
		if (queryActiveRef || (busy() && foregroundTurnOwner !== 0)) {
			// Queue protection: terminal key repeats can deliver the same
			// Enter twice before Solid paints the cleared input. Never enqueue
			// an identical prompt/attachment set twice in one burst.
			setPendingQueue(prev => {
				const previous = prev[prev.length - 1];
				const sameAttachments =
					JSON.stringify(previous?.attachments ?? {}) ===
					JSON.stringify(attachments ?? {});
				if (previous?.value === value && sameAttachments) return prev;
				return enqueueUserWork(prev, {value, attachments});
			});
			// The queued message renders as a persistent block above the
			// input (parity: nanocoder's queuedBlock), NOT a transcript row
			// that scrolls away.
			setInput('');
			return;
		}

		// The transcript shows the ORIGINAL user text (for a triggered
		// command that is the typed `/command args`, NOT the injected body);
		// the provider sees the prompt with vision-description blocks
		// substituted for [Image #N].
		await runTurn(command?.original ?? value, prompt, attachments, command);
		processQueue();
	};

	const runTurn = async (
		value: string,
		providerValue: string = value,
		attachments?: Record<string, string>,
		command?: {
			kind: 'command' | 'skill';
			name: string;
			original?: string;
			body: string;
		},
	) => {
		queryActiveRef = true;
		const turnId = ++foregroundTurnSeq;
		foregroundTurnOwner = turnId;
		const autonomousTurn = autonomousTurnRef;
		const loopTurn = loopTurnRef;
		const taskTurn = taskTurnRef;
		const systemTurn = autonomousTurn || loopTurn || taskTurn;
		goalAccountingTurnRef = autonomousTurn;
		autonomousTurnRef = false;
		loopTurnRef = false;
		taskTurnRef = false;
		// /undo file parity (openclaude rewind): every REAL LLM turn starts a
		// file-undo exchange — the file tools snapshot their targets during
		// the turn, and /undo restores them with the transcript. Slash
		// commands and `!bash` never reach here, so they can't push dummy
		// exchanges that would swallow the previous exchange's file undo.
		if (!systemTurn) beginFileUndoExchange(value);
		// Codex pre-sampling behavior: compact prior history, then continue
		// this same submitted prompt automatically against the summary.
		if (shouldAutoCompactHistory(context())) {
			await tryAutoCompactHistory(context());
		}
		// Snapshot for `/retry` BEFORE the user message lands.
		if (!systemTurn) {
			setRetrySnapshot({
				messages: [...messages()],
				context: [...context()],
				prompt: value,
			});
		}
		if (!systemTurn) {
			setPromptHistory(prev =>
				prev[prev.length - 1] === value ? prev : [...prev.slice(-99), value],
			);
		}
		setHistoryIndex(-1);

		// B22: the transcript shows the original; the provider sees scrubbed
		// text (placeholders are rehydrated in replies).
		if (!systemTurn) {
			appendMessage({
				role: 'user',
				content: value,
				...(attachments && Object.keys(attachments).length > 0
					? {attachments}
					: {}),
				...(command ? {command} : {}),
			});
		}
		// Persist user message BEFORE provider/tool work. A long or interrupted
		// turn must still appear in `/resume`; waiting for finally means a
		// process exit or crash loses the latest prompt for several minutes.
		persist();
		const nativeImagePaths = supportsNativeImageInput(activeEndpoint())
			? Object.entries(attachments ?? {})
					.filter(([index]) => providerValue.includes(`[Image #${index}]`))
					.map(([, path]) => path)
			: [];
		const sourceContext = imageSourceContext(value, attachments ?? {});
		const mentionContext = buildMentionContext(value, workspaceCwd());
		const userMsg = {
			role: 'user' as const,
			content:
				scrubberRef.scrub(providerValue) + sourceContext + mentionContext,
			...(nativeImagePaths.length > 0 ? {images: nativeImagePaths} : {}),
		};
		// CACHE HEAD PARITY (codex): the current DATE rides the request
		// TAIL, not the system head. The dated message is what the provider
		// sees AND what the context persists, so a day change or a next-day
		// resume keeps the byte-stable head warm; the display transcript
		// keeps the clean user text.
		const datedUserMsg = {
			...userMsg,
			content: `${userMsg.content}${currentDateFragment()}`,
		};
		setInput('');
		setBusy(true);
		setStreaming('');
		setCompletionMessage('');
		setCompletionTone('default');
		// A new turn starts: stop the COMPLETED popup (armed or visible).
		completionPopupController.cancel();
		setReasoning('');
		setRunning(true);
		setTurnElapsed(0);
		thinkingStartedAt = 0;
		setThinkingElapsed(0);
		const turnTimer = setInterval(() => {
			setTurnElapsed(prev => prev + 1);
			setThinkingElapsed(
				thinkingStartedAt > 0
					? Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000))
					: 0,
			);
		}, 1000);
		const controller = new AbortController();
		abortRef = controller;
		const startedAt = Date.now();
		let completionFailed = false;
		let completionInterrupted = false;
		let detachedWorkStarted = false;
		const releaseForegroundForDetachedWork = (): void => {
			if (detachedWorkStarted || foregroundTurnOwner !== turnId) return;
			detachedWorkStarted = true;
			foregroundTurnOwner = 0;
			// Background work must not own the foreground prompt. Release these
			// signals immediately at handoff, rather than waiting for the model
			// loop's finally block after it notices the flag.
			setBusy(false);
			setRunning(false);
			setStreaming('');
			setReasoning('');
			setThinkingActive(false);
		};
		let completionSummary = value.replace(/\s+/g, ' ').trim().slice(0, 180);
		reportHerdrAgent('working', {
			message: completionSummary || 'Working',
			sessionId: sessionId(),
		});

		let history: ChatMessageLike[] = [...context(), datedUserMsg];
		// F4: subscribe blocks auto-trigger, a custom command whose
		// `subscribe:` keywords match the prompt injects its body.
		for (const command of loadCustomCommands()) {
			if (
				command.subscribe?.some(keyword =>
					value.toLowerCase().includes(keyword.toLowerCase()),
				)
			) {
				history = [...history, {role: 'user', content: command.body.trim()}];
				appendMessage({
					role: 'user',
					content: `${value} (auto-triggered /${command.name})`,
					command: {
						kind: 'command',
						name: command.name,
						original: `${value} (auto-triggered /${command.name})`,
						body: command.body.trim(),
					},
				});
				appendInfo(
					`Auto-triggered custom command /${command.name} (subscribe).`,
				);
			}
		}
		// F6: skill `subscribe:` keywords auto-trigger the same way.
		for (const skill of loadSkills()) {
			if (
				skill.subscribe?.some(keyword =>
					value.toLowerCase().includes(keyword.toLowerCase()),
				)
			) {
				history = [...history, {role: 'user', content: skill.body.trim()}];
				appendMessage({
					role: 'user',
					content: `${value} (auto-triggered skill:${skill.name})`,
					command: {
						kind: 'skill',
						name: skill.name,
						original: `${value} (auto-triggered skill:${skill.name})`,
						body: skill.body.trim(),
					},
				});
				appendInfo(`Auto-triggered skill ${skill.name} (subscribe).`);
			}
		}
		history = capMessages(history, maxMessages());
		let emptyTurnCount = 0;
		let repeatedToolState: RepeatedToolState = INITIAL_REPEATED_TOOL_STATE;
		let malformedRetryCount = 0;
		let taskCloseoutNudgeCount = 0;
		let lastTaskCloseoutDraft = '';
		let taskToolRanAfterCloseoutDraft = false;
		let toolBriefActive = false;
		let reactiveCompactRetries = 0;
		setDiagnosticsCount(0);
		let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
		if (watchdogMsRef > 0) {
			watchdogTimer = setTimeout(() => {
				watchdogRef = true;
				setCancelling(true);
				abortRef?.abort();
			}, watchdogMsRef);
		}
		try {
			// B15: preflight steering evaluation before the first request.
			const turnFacts = () => ({
				intent: classifyIntent(value),
				model: activeEndpoint().model,
				budgetTurns: 0,
				totalBudget: TOOL_LOOP_BUDGET,
				backgroundTasksRunning: activeBgCount() > 0,
			});
			const steering = evaluateSteering(value, steeringRef, turnFacts());
			if (steering) {
				const {rule, intent} = steering;
				const facts = {...turnFacts(), intent};
				if (rule.action === 'block') {
					appendInfo(formatInnerDaemonRow(rule.id, 'block', facts));
					appendInfo(rule.message ?? `Blocked by steering rule ${rule.id}.`);
					return;
				}
				if (rule.action === 'stop') {
					appendInfo(formatInnerDaemonRow(rule.id, 'stop', facts));
					appendInfo(
						`InnerDaemon stopped the loop: ${rule.message ?? rule.id}`,
					);
					return;
				}
				if (rule.action === 'inject' && rule.inject) {
					appendInfo(formatInnerDaemonRow(rule.id, 'inject', facts));
					history = [...history, {role: 'user', content: rule.inject}];
				} else if (rule.action === 'noop') {
					appendNoopRow(formatInnerDaemonRow(rule.id, 'noop', facts));
				}
			}
			// No round cap: the loop runs until the model answers with text,
			// a safety guard trips (empty turn / repeated tool signature /
			// malformed retries), or an error is thrown. `round` still
			// counts tool turns for the steering audit fact.
			turnLoop: for (let round = 0; ; round++) {
				// Settled `⚙ Thought (Ns)` reports the THINKING phase length
				// (since reasoning first streamed), not the whole turn.
				const thoughtDuration = (): number =>
					thinkingSeconds(
						thinkingStartedAt > 0 ? thinkingStartedAt : startedAt,
						Date.now(),
					);
				let result: Awaited<ReturnType<typeof streamChat>>;
				const beginThinkingPhase = () => {
					if (thinkingActive()) return;
					setThinkingActive(true);
					thinkingStartedAt = Date.now();
				};
				try {
					result = await streamChat(
						history,
						{
							onText: delta => {
								// Reply text streaming ⇒ the thinking phase is over.
								if (delta) setThinkingActive(false);
								setStreaming(prev => prev + delta);
							},
							onReasoning: delta => {
								if (delta) beginThinkingPhase();
								setReasoning(prev => prev + delta);
							},
							onReasoningStart: beginThinkingPhase,
						},
						controller.signal,
						toolCatalogForModel(activeEndpoint().model),
						streamGuardRef,
						toolProfile(),
						// The primary provider failed and a FALLBACK answered —
						// surface it, or the user thinks the active model lost
						// its memory (it was never the one that replied).
						fallback => {
							setCompletionTone('default');
							setCompletionMessage(
								`⚠ ${fallback.id} answered · ${fallback.model} (primary failed)`,
							);
							if (resumeNoticeTimer) clearTimeout(resumeNoticeTimer);
							resumeNoticeTimer = setTimeout(() => {
								setCompletionMessage('');
								setCompletionTone('default');
							}, 8000);
						},
					);
				} catch (error) {
					if (isCompactOverflowError(error) && reactiveCompactRetries < 2) {
						reactiveCompactRetries += 1;
						setStreaming('');
						setReasoning('');
						setThinkingActive(false);
						try {
							history = await compactHistory(history);
						} catch (compactionError) {
							appendWarning(
								`Reactive compaction failed: ${compactionError instanceof Error ? compactionError.message : String(compactionError)}`,
							);
							throw error;
						}
						round -= 1;
						continue;
					}
					throw error;
				}
				// The round's stream ended — if the model only reasoned and
				// called tools, the tool phase is WORKING, not thinking.
				setThinkingActive(false);

				// Tool-call recovery (parity: nanocoder's self-correction
				// loop): when the model emitted tool-call-SHAPED text but no
				// executable call, first try the layered text parser (XML /
				// Llama tags / JSON). If it recovers calls, execute them as a
				// normal tool turn; if the markup is MALFORMED, feed the
				// parse error back to the model and retry (capped).
				if (
					result.toolCalls.length === 0 &&
					result.text.trim() &&
					looksLikeToolCallText(result.text)
				) {
					const parsed = parseToolCalls(result.text);
					if (parsed.success && parsed.toolCalls.length > 0) {
						result = {
							...result,
							toolCalls: parsed.toolCalls.map(call => ({
								id: call.id,
								name: call.name,
								rawArguments: call.arguments,
								arguments: parseArguments(call.arguments),
							})),
							text: parsed.cleanText,
						};
					} else if (!parsed.success) {
						if (malformedRetryCount >= MAX_MALFORMED_RETRIES) {
							appendError(
								`Model produced malformed tool calls ${MAX_MALFORMED_RETRIES + 1} times in a row and cannot self-correct. Try rephrasing the request or switching models.`,
							);
							break;
						}
						malformedRetryCount += 1;
						appendInfo(
							`Malformed tool call, asking the model to correct itself (${malformedRetryCount}/${MAX_MALFORMED_RETRIES + 1}).`,
						);
						appendAssistantMessage(result.text, {
							reasoning: result.reasoning.trim() || undefined,
							durationSec: thoughtDuration(),
						});
						history = [
							...history,
							{role: 'assistant', content: result.text},
							{
								role: 'user',
								content:
									`Your previous response contained a malformed tool call. ${parsed.error ?? ''}\n\n` +
									`${parsed.examples ?? ''}\n\nPlease try again using the correct format.`,
							},
						];
						continue;
					}
				}

				if (result.toolCalls.length === 0) {
					if (result.text.trim()) {
						const unfinishedTasks = tasks().filter(
							task =>
								task.status === 'pending' || task.status === 'in_progress',
						);
						if (unfinishedTasks.length > 0 && taskCloseoutNudgeCount < 2) {
							taskCloseoutNudgeCount += 1;
							// This text already rendered as the normal live Markdown reply. Persist
							// it before clearing streaming for the checklist closeout round; otherwise
							// calling write_tasks makes the visible response disappear.
							const visibleDraft = scrubberRef.rehydrate(result.text);
							if (visibleDraft !== lastTaskCloseoutDraft) {
								appendAssistantMessage(visibleDraft, {
									reasoning: result.reasoning.trim() || undefined,
									durationSec: thoughtDuration(),
								});
								lastTaskCloseoutDraft = visibleDraft;
								taskToolRanAfterCloseoutDraft = false;
							}
							history = [
								...history,
								{role: 'assistant', content: result.text},
								{
									role: 'user',
									content:
										'You still have unfinished checklist items. Before giving the final response, call write_tasks with the full list and mark each genuinely finished item completed. Keep blocked or incomplete work in_progress/pending. Do not merely describe the update in prose.',
								},
							];
							setStreaming('');
							setReasoning('');
							recordUsage(result.usage);
							continue;
						}
						// Never fabricate checklist completion. If the model ignored two
						// explicit closeout nudges, preserve exact task state and withhold
						// the completion signal instead of lying to the next iteration.
						const remainingUnfinishedTasks = unfinishedTasks;
						completionSummary =
							result.text.replace(/\s+/g, ' ').trim().slice(0, 180) ||
							completionSummary;
						if (currentGoal && autonomousTurn) {
							const status = goalStatusFromResponse(
								result.text,
								currentGoal.status,
								currentGoal.completionPromise,
							);
							if (status !== currentGoal.status) {
								saveGoal({...currentGoal, status, updatedAt: Date.now()});
								if (status === 'complete' || status === 'blocked') {
									setPendingQueue(previous =>
										previous.filter(item => item.source !== 'goal'),
									);
									cancelRunningBackgroundTasks('goal');
								}
							}
						}
						const visibleReply = scrubberRef.rehydrate(result.text);
						if (
							shouldPersistTaskCloseoutReply(
								visibleReply,
								lastTaskCloseoutDraft,
								taskToolRanAfterCloseoutDraft,
							)
						) {
							appendAssistantMessage(visibleReply, {
								reasoning: result.reasoning.trim() || undefined,
								durationSec: thoughtDuration(),
							});
						}
						const completionUsage = usageSignal(result.usage);
						const cacheLabel = formatCacheHitLabel(cacheStats(result.usage));
						// Static completion line ABOVE the input (diamond glyph,
						// secondary), not a transcript row. Expires after a
						// few seconds like the exit confirmation.
						if (remainingUnfinishedTasks.length === 0) {
							setCompletionMessage(
								`✦ Worked for a ${getRandomAdjective()} ${formatElapsedTime(startedAt)}.` +
									(completionUsage?.total_tokens
										? ` · ${formatTokens(completionUsage.total_tokens)} tokens`
										: '') +
									(cacheLabel ? ` · ${cacheLabel}` : ''),
							);
							// COMPLETED attention modal: a finished task arms the
							// idle window (shows only after a full idle period).
							completionPopupController.arm();
						}
						capturePRs(result.text);
						// Keep the LOCAL history (what the provider saw) in
						// sync, the post-loop `setContext(history)` below is
						// the single source of truth for the saved session,
						// so a resumed conversation re-sends the EXACT same
						// prefix and keeps the provider's prompt cache.
						history = [...history, {role: 'assistant', content: result.text}];
						setContext(history);
						refreshContextPercent();
						recordUsage(result.usage);
						break;
					}

					// Empty turn (reasoning-only or fully silent): nudge once per
					// attempt, matching nanocoder's empty-response retry flow.
					if (emptyTurnCount >= MAX_EMPTY_TURNS) {
						appendError(
							`Model produced no output after ${MAX_EMPTY_TURNS + 1} attempts. ` +
								'The model may be exhausting its token budget on reasoning, or the request may have been refused. ' +
								'Try rephrasing, lowering reasoning effort, or switching models.',
						);
						break;
					}
					emptyTurnCount += 1;
					const nudge = result.reasoning.trim()
						? 'You produced reasoning but no final response. Please provide your answer based on your reasoning above.'
						: 'Please continue with the task.';
					if (result.reasoning.trim()) {
						appendAssistantMessage('', {
							reasoning: result.reasoning.trim(),
							durationSec: thoughtDuration(),
						});
					}
					appendInfo(
						`Empty response, retry ${emptyTurnCount}/${MAX_EMPTY_TURNS + 1}: "${nudge}"`,
					);
					history = [...history, {role: 'user', content: nudge}];
					continue;
				}

				// B14: repeated identical EFFECTFUL tool signature across turns →
				// loop guard. Checklist bookkeeping (`write_tasks`) is excluded:
				// models legitimately repeat it while advancing and closing tasks.
				// Other tools remain guarded, including skill loading.
				const repeated = evaluateRepeatedToolCalls(
					result.toolCalls,
					repeatedToolState,
				);
				repeatedToolState = repeated.state;
				if (repeated.stop) {
					appendError(
						`Repeated tool call detected (${repeated.state.count}× identical calls), stopping the loop.`,
					);
					break;
				}

				// Tool turn: execute every call, render each row, feed the
				// results back so the model can reply.
				const toolMessages: ChatMessageLike[] = [];
				// Settled Thought block for a reasoning+tools turn (parity:
				// /mock:thoughtrun keeps `⚙ Thought (Ns)` above the tally).
				if (result.reasoning.trim()) {
					appendAssistantMessage('', {
						reasoning: result.reasoning.trim(),
						durationSec: thoughtDuration(),
					});
				}
				// Pre-tool BRIEF (parity: claude code / openclaude render the
				// model's "I'll check X" narration BEFORE the tool box). It is
				// attached to the FIRST tool message of the batch and renders
				// once as part of the tool entry — never repeated per tool.
				const preToolText = splitPreToolText(
					scrubberRef.rehydrate(result.text),
				);
				const briefText = result.text.trim()
					? oneSentencePreToolBrief(preToolText.brief)
					: '';
				const priorRoundBriefed = toolBriefActive;
				if (briefText) toolBriefActive = true;
				// Text became pre-tool brief. Remove live-reply copy immediately;
				// otherwise same narration paints above tool and again below it
				// until next streaming throttle tick.
				setStreaming('');
				// Keep prose after the compact pre-tool sentence as a normal
				// assistant message. Previously every result.text attached to a
				// tool call was collapsed into one brief, silently dropping
				// substantive sentences between tool rounds.
				if (preToolText.remainder) {
					appendAssistantMessage(preToolText.remainder, {
						reasoning: result.reasoning.trim() || undefined,
						durationSec: thoughtDuration(),
					});
				}
				const toolResults: Array<{
					tool_call_id: string;
					content: string;
					displayArgs?: Record<string, unknown>;
				}> = [];
				// B8: single-tool profiles truncate to one call per turn.
				const selectedCalls = isSingleToolProfile(
					toolProfile(),
					activeEndpoint().model,
				)
					? result.toolCalls.slice(0, 1)
					: result.toolCalls;
				// Normalize BEFORE rendering and provider-history persistence. Doing
				// this only inside executeTool still shows redundant `cd <cwd> &&`
				// in the visible call and teaches the model to repeat it.
				const calls: MockToolCall[] = selectedCalls.map(call => {
					if (resolveToolName(call.name) !== 'execute_bash') return call;
					const command = call.arguments.command;
					if (typeof command !== 'string') return call;
					const normalized = normalizeBashCommand(command, workspaceCwd());
					if (normalized === command) return call;
					const args = {...call.arguments, command: normalized};
					return {...call, arguments: args, rawArguments: JSON.stringify(args)};
				});
				if (calls.some(call => resolveToolName(call.name) === 'write_tasks')) {
					taskToolRanAfterCloseoutDraft = true;
				}
				let declined = false;
				// B17: read-only batches run in PARALLEL (results keep order);
				// mutation tools always run sequentially.
				const allReadOnly = calls.every(call => {
					const availability = toolAvailability(
						call.name,
						toolProfile(),
						mode(),
						activeEndpoint().model,
					);
					return (
						availability.available &&
						isReadOnlyTool(call.name) &&
						isParallelSafeTool(call.name) &&
						!evaluateToolConstraint(call.name, steeringRef, {
							intent: classifyIntent(value),
							model: activeEndpoint().model,
							budgetTurns: round,
							totalBudget: TOOL_LOOP_BUDGET,
							backgroundTasksRunning: activeBgCount() > 0,
						})
					);
				});
				// B9/C6: pre-append every running row for the read-only
				// PARALLEL batch so the compact tally streams LIVE instead of
				// appearing only after the whole batch settles.
				const batchStartedAt = Date.now();
				if (allReadOnly) {
					for (const [callIndex, call] of calls.entries()) {
						const detail = toolDisplayDetail(call);
						appendMessage({
							role: 'tool',
							content: `✦ ${displayToolName(call.name)}${detail ? `(${detail})` : ''}`,
							running: true,
							toolId: call.id,
							// First message carries the brief TEXT; every
							// message marks the batch so later boxes share
							// the single glyph and indent to the brief column.
							brief: toolCallBrief(briefText, callIndex, priorRoundBriefed),
							tool: {name: call.name, detail, output: '', args: call.arguments},
						});
					}
				}
				const parallelResults = allReadOnly
					? await Promise.all(
							calls.map(call =>
								executeTool(call, {
									sessionId: sessionId(),
									onProgress: content =>
										setLiveOutputs(prev => ({
											...prev,
											[call.id]: content,
										})),
									signal: controller.signal,
									cwd: workspaceCwd(),
									workspaceRoot,
									onCwdChange: updateWorkspaceCwd,
									askUser,
									onStateChange: persist,
									onDetachedWork: releaseForegroundForDetachedWork,
									onDetachedComplete: queueDetachedCompletion,
									backgroundOwner: autonomousTurn
										? 'goal'
										: loopTurn
											? 'loop'
											: 'user',
								}),
							),
						)
					: null;
				callLoop: for (const [index, call] of calls.entries()) {
					// Render the row BEFORE execution so bash output streams live
					// into the transcript tail (parity: streaming tool rows).
					const detail = toolDisplayDetail(call);
					const callStartedAt = allReadOnly ? batchStartedAt : Date.now();
					// B9/C6: the read-only PARALLEL batch pre-appends every
					// running row BEFORE execution so the compact tally streams
					// live (the rows above already exist for that path).
					if (!allReadOnly) {
						appendMessage({
							role: 'tool',
							content: `✦ ${displayToolName(call.name)}${detail ? `(${detail})` : ''}`,
							running: true,
							toolId: call.id,
							brief: toolCallBrief(briefText, index, priorRoundBriefed),
							tool: {name: call.name, detail, output: '', args: call.arguments},
						});
					}
					if (declined) {
						const declinedContent = 'Declined by user.';
						toolResults.push({tool_call_id: call.id, content: declinedContent});
						toolMessages.push({
							role: 'tool',
							content: declinedContent,
							tool_call_id: call.id,
						});
						setMessages(prev =>
							prev.map(message =>
								message.toolId === call.id
									? {
											...message,
											running: false,
											tool: {...message.tool!, output: declinedContent},
										}
									: message,
							),
						);
						continue;
					}
					// B15: steering tool-call constraints block before dispatch.
					const toolConstraint = evaluateToolConstraint(
						call.name,
						steeringRef,
						{
							intent: classifyIntent(value),
							model: activeEndpoint().model,
							budgetTurns: round,
							totalBudget: TOOL_LOOP_BUDGET,
							backgroundTasksRunning: activeBgCount() > 0,
						},
					);
					if (toolConstraint) {
						const reason =
							`Blocked by steering rule ${toolConstraint.rule.id}: ` +
							`${toolConstraint.rule.message ?? 'constraint'}`;
						appendInfo(
							formatInnerDaemonRow(toolConstraint.rule.id, 'block', {
								intent: toolConstraint.intent,
								model: activeEndpoint().model,
								budgetTurns: round,
								totalBudget: TOOL_LOOP_BUDGET,
								backgroundTasksRunning: activeBgCount() > 0,
							}),
						);
						toolResults.push({tool_call_id: call.id, content: reason});
						toolMessages.push({
							role: 'tool',
							content: reason,
							tool_call_id: call.id,
						});
						setMessages(prev =>
							prev.map(message =>
								message.toolId === call.id
									? {
											...message,
											running: false,
											tool: {...message.tool!, output: reason},
										}
									: message,
							),
						);
						continue;
					}
					// D7/D3: profile/plan availability.
					const availability = toolAvailability(
						call.name,
						toolProfile(),
						mode(),
						activeEndpoint().model,
					);
					if (!availability.available) {
						const reason = `Tool ${displayToolName(call.name)} ${availability.reason}.`;
						toolResults.push({tool_call_id: call.id, content: reason});
						toolMessages.push({
							role: 'tool',
							content: reason,
							tool_call_id: call.id,
						});
						setMessages(prev =>
							prev.map(message =>
								message.toolId === call.id
									? {
											...message,
											running: false,
											tool: {...message.tool!, output: reason},
										}
									: message,
							),
						);
						continue;
					}
					// B16: approval gating.
					if (
						requiresApproval(
							call.name,
							mode(),
							activeEndpoint().alwaysAllow ?? [],
						)
					) {
						const approved = await approvalGate(
							displayToolName(call.name),
							detail,
						);
						reportHerdrAgent('working', {
							message: completionSummary || 'Working',
							sessionId: sessionId(),
						});
						if (!approved) {
							declined = true; // decline cancels the REST
							const declinedContent = 'Declined by user.';
							toolResults.push({
								tool_call_id: call.id,
								content: declinedContent,
							});
							toolMessages.push({
								role: 'tool',
								content: declinedContent,
								tool_call_id: call.id,
							});
							setMessages(prev =>
								prev.map(message =>
									message.toolId === call.id
										? {
												...message,
												running: false,
												tool: {...message.tool!, output: declinedContent},
											}
										: message,
								),
							);
							continue;
						}
					}
					const toolResult =
						parallelResults?.[index] ??
						(await executeTool(call, {
							sessionId: sessionId(),
							onProgress: content =>
								setLiveOutputs(prev => ({...prev, [call.id]: content})),
							signal: controller.signal,
							cwd: workspaceCwd(),
							workspaceRoot,
							askUser,
							onStateChange: persist,
							onDetachedWork: releaseForegroundForDetachedWork,
							onDetachedComplete: queueDetachedCompletion,
							backgroundOwner: autonomousTurn
								? 'goal'
								: loopTurn
									? 'loop'
									: 'user',
							onCwdChange: next => {
								updateWorkspaceCwd(next);
								persist();
							},
						}));
					if (call.arguments._malformed) {
						// B7: malformed arguments → corrective nudge so the model
						// retries with valid JSON (self-correction loop).
						appendInfo(
							`Auto-recovered malformed tool call: ${call.name}, retrying with valid arguments.`,
						);
						toolMessages.push({
							role: 'user',
							content:
								`Your tool call to ${call.name} had invalid JSON arguments ` +
								`(${call.rawArguments}). Please retry with valid JSON.`,
						});
					}
					toolResults.push(toolResult);
					toolMessages.push({
						role: 'tool',
						content: toolResult.content,
						tool_call_id: toolResult.tool_call_id,
					});
					// Fast tools settle before the next paint: an MCP stdio
					// round trip can be ~1ms while the renderer frames at
					// ~16ms, so without a floor the row appears already
					// green with output and the grey running glyph is never
					// seen. Hold the RUNNING state until the floor elapses
					// (parity: the startup loader's MIN_LOAD_MS floor).
					const executedAt = Date.now();
					const runningRemaining = toolRunningRemainingMs(
						callStartedAt,
						executedAt,
					);
					if (runningRemaining > 0) {
						await new Promise(resolve => setTimeout(resolve, runningRemaining));
					}
					setMessages(prev =>
						prev.map(message =>
							message.toolId === call.id
								? {
										...message,
										running: false,
										tool: {
											...message.tool!,
											output: toolResult.content,
											args: toolResult.displayArgs ?? message.tool!.args,
										},
										toolStats: {
											durationSec: Math.max(
												0,
												(executedAt - callStartedAt) / 1000,
											),
											toolCalls: calls.length,
										},
									}
								: message,
						),
					);
					setLiveOutputs(prev => {
						const next = {...prev};
						delete next[call.id];
						return next;
					});
					if (detachedWorkStarted) {
						// Completion notification resumes work with exact output. End this
						// turn now instead of polling or holding foreground ownership.
						break callLoop;
					}
				}

				// Detached work ends the current turn immediately. A model batch can
				// contain more calls after that detached call, but those calls were
				// never executed and therefore have no tool result. Persisting the
				// original full declaration creates an invalid provider history:
				// `tool_calls` contains orphaned calls, which breaks resume with
				// "No tool output found". Keep only declarations with results.
				const completedCallCount = toolMessages.filter(
					message => message.role === 'tool',
				).length;
				const completedCalls = calls.slice(0, completedCallCount);
				const assistantToolMsg: ChatMessageLike = {
					role: 'assistant',
					content: result.text,
					tool_calls: completedCalls.map((call: MockToolCall) => ({
						id: call.id,
						name: call.name,
						arguments: call.rawArguments,
					})),
				};
				history = [...history, assistantToolMsg, ...toolMessages];
				refreshContextPercent();
				if (detachedWorkStarted) {
					// Finally clears busy while detached process keeps running.
					break turnLoop;
				}
				// Codex true mid-turn continuation: compact after tool output,
				// replace local history, then sample again in this SAME loop.
				if (shouldAutoCompactHistory(history)) {
					history = await tryAutoCompactHistory(history);
				}
				// B4: cap the provider context to the newest N messages.
				history = capMessages(history, maxMessages());
				// B21: auto-diagnostics after a tool turn, run the LSP
				// diagnostics tool and inject the summary before recursion.
				// ONLY when there are FINDINGS: a clean "no issues" pass must
				// not spam the chat with a useless row or waste provider
				// tokens (parity: the original only surfaces findings).
				try {
					const diagnostics = await executeTool(
						{
							id: 'call_diag',
							name: 'lsp_get_diagnostics',
							arguments: {},
							rawArguments: '{}',
						},
						{},
					);
					const issues = /(\d+)\s+(?:issue|error|problem)s?/i.exec(
						diagnostics.content,
					);
					const count = issues ? Number(issues[1]) : 0;
					setDiagnosticsCount(count);
					if (count > 0) {
						appendInfo(firstLine(diagnostics.content, 120));
						history = [
							...history,
							{
								role: 'user',
								content: `<diagnostics-summary>\n${diagnostics.content}\n</diagnostics-summary>`,
							},
						];
					}
				} catch {
					// diagnostics are best-effort; never block the loop
				}
				setStreaming('');
				setReasoning('');
				thinkingStartedAt = 0;
				recordUsage(result.usage);
			}
			// Session-management parity: the persisted context MUST mirror
			// the final provider history (including every tool round). The
			// old code only synced after a TEXT turn, so sessions that ended
			// on a tool turn saved a SHORTER context, resuming them sent a
			// different prefix and missed the LLM cache on the first turn.
			setContext(history);
			refreshContextPercent();
			// Compaction check AFTER the whole turn (tool rounds included) —
			// the text branch checks it too, but a tool-heavy turn grows the
			// history past the message cap without ever hitting a text turn.
			// Completion line also shows after TOOL-only turns (the loop can
			// end on tools with no final text round, the text branch above
			// already set it; this covers the other path).
			if (!completionMessage()) {
				setCompletionMessage(
					`✦ Worked for a ${getRandomAdjective()} ${formatElapsedTime(startedAt)}.` +
						(formatCacheHitLabel(cacheStats(lastUsage())) ?? ''),
				);
				// COMPLETED attention modal (tool-only turn path): arm the
				// idle window exactly like the text-turn completion.
				completionPopupController.arm();
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				completionInterrupted = true;
				// ESC interrupt: commit the partial stream AND the turn's
				// history to the provider context (B20). `/clear` aborts
				// without the flag and leaves the wiped state.
				if (watchdogRef) {
					// B5: the within-turn watchdog aborted, surface the
					// InnerDaemon audit row and commit the partial.
					watchdogRef = false;
					const partial = streaming();
					if (partial.trim()) {
						appendAssistantMessage(partial);
					}
					setContext(interruptedContext(history, partial));
					appendInfo('Interrupted by watchdog.');
					appendInfo(
						formatInnerDaemonRow('watchdog', 'timeout', {
							intent: classifyIntent(value),
							model: activeEndpoint().model,
							budgetTurns: 0,
							totalBudget: TOOL_LOOP_BUDGET,
							backgroundTasksRunning: activeBgCount() > 0,
						}),
					);
				} else if (interruptedRef) {
					interruptedRef = false;
					const partial = streaming();
					const partialReasoning = reasoning();
					if (partial.trim() || partialReasoning.trim()) {
						appendAssistantMessage(partial, {
							reasoning: partialReasoning.trim() || undefined,
							durationSec: thinkingSeconds(
								thinkingStartedAt > 0 ? thinkingStartedAt : startedAt,
								Date.now(),
							),
						});
						refreshContextPercent();
					}
					// Mid-tool-loop or reasoning-only interrupts stream no
					// text — the USER MESSAGE still belongs in context, or
					// the next request loses the turn entirely.
					setContext(interruptedContext(history, partial));
					appendError('Interrupted by user.');
				}
				return;
			}
			completionFailed = true;
			completionSummary =
				(error instanceof Error ? error.message : String(error))
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 180) || 'Task failed';
			appendError(error instanceof Error ? error.message : String(error));
		} finally {
			queryActiveRef = false;
			clearInterval(turnTimer);
			if (watchdogTimer) clearTimeout(watchdogTimer);
			// SETTLE ANY STILL-RUNNING TOOL ROWS. A turn can end with a tool
			// message still `running:true` — Esc interrupt / watchdog /
			// provider error mid-tool (runBash keeps streaming output into
			// liveOutputs after the turn dies). Left alone it becomes a
			// GHOST: invisible while idle (the settled memo skips running
			// rows, the live region is empty), then it RESURFACES in the
			// live region during the NEXT turn — stacked next to the new
			// turn's identical command, the "same bash printed twice while
			// running" the user saw. Settle them with whatever output
			// streamed so the transcript is honest and no ghost survives.
			setMessages(prev => settleRunningToolRows(prev, liveOutputs()));
			// CLEAR the live-output cache: liveOutputs persists tool output
			// across turns (the pump writes to it, liveToolRows reads it).
			// Settling consumed it into the transcript; clearing it prevents
			// STALE output from bleeding into the NEXT turn's identical tool
			// (a brief live-region window where the new message reads the old
			// tool's output from liveOutputs = the "same bash printed twice
			// while running" the user saw). Done after the settle so the
			// settled row's output is captured first.
			setLiveOutputs({});
			if (foregroundTurnOwner === turnId) {
				setCancelling(false);
				setRunning(false);
				setBusy(false);
				setStreaming('');
				setReasoning('');
				setThinkingActive(false);
				thinkingStartedAt = 0;
				setThinkingElapsed(0);
			}
			void runHooks({event: 'Stop', data: {interrupted: interruptedRef}});
			if (currentGoal && autonomousTurn) {
				let nextGoal: SessionGoal = {
					...currentGoal,
					timeUsedSeconds:
						currentGoal.timeUsedSeconds +
						Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
					updatedAt: Date.now(),
				};
				if (
					nextGoal.status === 'active' &&
					nextGoal.maxIterations &&
					(nextGoal.iteration ?? 0) >= nextGoal.maxIterations
				) {
					nextGoal = {...nextGoal, status: 'iteration-limited'};
				}
				setCurrentGoal(nextGoal);
			}
			persist();
			goalAccountingTurnRef = false;
			const terminalGoalState =
				autonomousTurn && currentGoal ? currentGoal.status : undefined;
			const completionBlocked = terminalGoalState === 'blocked';
			const goalWillContinue = currentGoal?.status === 'active';
			const afterTurnWillContinue =
				!loopTurn &&
				loopJobsRef.some(job => job.cronExpression === '@after-turn');
			const queuedWillContinue = pendingQueue().length > 0;
			const willContinue =
				!completionFailed &&
				!completionInterrupted &&
				!interruptedRef &&
				(goalWillContinue || afterTurnWillContinue || queuedWillContinue);
			reportHerdrAgent(
				completionBlocked ? 'blocked' : willContinue ? 'working' : 'idle',
				{
					message: completionBlocked
						? 'Goal needs input'
						: completionFailed
							? 'Task failed'
							: completionInterrupted
								? 'Task interrupted'
								: willContinue
									? 'Continuing queued work'
									: 'Task complete',
					sessionId: sessionId(),
				},
			);
			const shouldNotify = shouldNotifyTurnComplete({
				interrupted: completionInterrupted || interruptedRef,
			});
			if (shouldNotify) {
				notifyTaskComplete({
					title: completionFailed
						? 'BoboNyo task failed'
						: terminalGoalState === 'blocked'
							? 'BoboNyo needs input'
							: terminalGoalState === 'budget-limited'
								? 'BoboNyo goal paused'
								: willContinue
									? 'BoboNyo step finished'
									: 'BoboNyo finished',
					body: completionSummary || 'Task complete',
				});
			}
			if (!completionFailed && !completionInterrupted && !interruptedRef) {
				if (!loopTurn) fireAfterTurnJobs();
				if (currentGoal?.status === 'active') queueGoalContinuation();
			}
		}
	};

	const recordUsage = (usage: Record<string, unknown> | undefined) => {
		const snapshot = usageSignal(usage);
		if (!snapshot) return;
		setLastUsage(snapshot);
		setUsageHistory(prev => [
			...prev,
			{
				...snapshot,
				provider: activeEndpoint().id,
				model: activeEndpoint().model,
				ts: Date.now(),
			},
		]);
		// Accumulate the turn's usage into the per-provider MONTHLY ledger
		// (`used N.NM` for token-plan providers, the cache rate for ANY
		// provider that reports cache fields). The disk-backed ledger
		// survives restarts, unlike the session-scoped history above.
		const updated = recordProviderUsage(activeEndpoint().baseUrl, snapshot);
		if (updated) setProviderUsage(updated);
		if (currentGoal && goalAccountingTurnRef) {
			const next: SessionGoal = {
				...currentGoal,
				tokensUsed: currentGoal.tokensUsed + (snapshot.total_tokens ?? 0),
				updatedAt: Date.now(),
			};
			if (
				next.status === 'active' &&
				next.tokenBudget &&
				next.tokensUsed >= next.tokenBudget
			) {
				next.status = 'budget-limited';
			}
			saveGoal(next);
		}
		// Prompt-cache alert: an unusually cache-miss-heavy turn is exactly
		// what drives the cost up — surface it for ANY provider that reports
		// cache fields, not just DeepSeek. Toast (transient) — never a chat
		// history row, same policy as setting changes.
		{
			const stats = cacheStats(snapshot);
			if (shouldAlertCacheMiss(stats)) {
				showToast(
					`Cache miss ${Math.round((1 - (stats?.ratio ?? 0)) * 100)}% on this turn · costs more`,
				);
			}
		}
	};

	/**
	 * Codex-style LLM compaction: summarize the old context through the
	 * provider, then replace the history with the handoff summary (prefixed)
	 * + the recent user prompts. The compaction is a SEPARATE request, it
	 * never interrupts or re-sends the old blob to the main conversation, so
	 * the resumed turns start from a short, cache-friendly prefix.
	 *
	 * The summarization request starts with the FULL context (parity: codex
	 * `drain_to_completed`). If the model's context window rejects it, the
	 * OLDEST history item is trimmed and the request is retried — same
	 * trim-from-the-start strategy codex uses on `ContextWindowExceeded`,
	 * which preserves the cache head AND keeps the recent messages intact.
	 */
	const summarizeContext = async (
		ctx: ChatMessageLike[],
		preservedTurns: number,
	): Promise<string> => {
		let summary = '';
		let attempt = microcompactToolResults(
			prepareCompactionSummaryHistory(ctx),
			activeEndpoint().model,
		).messages;
		const compactRequest: ChatMessageLike = {
			role: 'user',
			content: buildSummarizationPrompt(workspaceCwd(), preservedTurns),
		};
		for (;;) {
			try {
				// OpenClaude/Codex shape: normal conversation context followed by a
				// final user compaction request. A synthetic system message here is
				// ignored by Responses wire and weakens behavior across providers.
				await streamChat(
					[...attempt, compactRequest],
					{
						onText: delta => {
							summary += delta;
						},
						onReasoning: () => {},
					},
					undefined,
					[],
					undefined,
					toolProfile(),
					undefined,
					undefined,
					{disableCaveman: true},
				);
				break;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const trimmed = trimOldestCompactionTurn(attempt);
				if (
					!isCompactOverflowError(error) ||
					trimmed.length >= attempt.length
				) {
					throw error;
				}
				attempt = trimmed;
				summary = '';
				if (process.env.NODE_ENV !== 'test') {
					appendInfo(
						`Compaction request overflowed the window, trimming oldest complete turn: ${message}`,
					);
				}
			}
		}
		return normalizeCompactionSummary(summary);
	};

	const compactHistory = async (
		ctx: ChatMessageLike[],
	): Promise<ChatMessageLike[]> => {
		setCompacting(true);
		try {
			const partition = partitionCompactionHistory(ctx);
			const transcriptPath = saveCompactionTranscript(
				sessionId(),
				messages(),
				ctx,
			);
			const rawSummary = await summarizeContext(
				partition.summarize,
				partition.preservedTurns,
			);
			if (!rawSummary) throw new Error('the model returned an empty summary');
			const model = activeEndpoint().model;
			const summary = truncateCompactionText(
				rawSummary,
				Math.max(
					1_000,
					Math.min(20_000, Math.floor(activeEndpoint().contextWindow * 0.2)),
				),
				model,
			);
			const state = buildCompactionStateSnapshot({
				sessionId: sessionId(),
				cwd: workspaceCwd(),
				workspaceRoot,
				transcriptPath,
				tasks: tasks(),
				...(currentGoal ? {goal: currentGoal} : {}),
				loopJobs: loopJobsRef,
				queuedPrompts: pendingQueue().map(item => ({
					value: item.value,
					...(item.source ? {source: item.source} : {}),
				})),
				agents: activeAgentRuns(),
				messages: messages(),
				context: ctx,
				availableSkills: loadSkills().map(skill => ({
					name: skill.name,
					source: skill.source,
					body: skill.body,
				})),
				model,
				budgets: compactionSnapshotBudgets(activeEndpoint().contextWindow),
			});
			let compacted: ChatMessageLike[] = [
				{role: 'user', content: `${SUMMARY_PREFIX}\n${summary}`},
				{role: 'user', content: state},
				...partition.preserve,
			];
			let installedPreservedTurns = partition.preservedTurns;
			const postCompactLimit = autoCompactTokenLimit(
				activeEndpoint().contextWindow,
				autoCompactRef.threshold,
				AUTO_COMPACT_SAFETY_BUFFER_TOKENS,
			);
			let postCompactTokens = estimateContextTokens(
				compacted,
				model,
				`${buildSystemPrompt(toolProfile())}\n${JSON.stringify(toolCatalogForModel(model))}`,
			);
			while (
				postCompactTokens >= postCompactLimit &&
				partition.preservedTurns > 0
			) {
				const trimmed = dropOldestPreservedTurn(compacted.slice(2));
				if (trimmed.length >= compacted.length - 2) break;
				compacted = [...compacted.slice(0, 2), ...trimmed];
				installedPreservedTurns = Math.max(0, installedPreservedTurns - 1);
				postCompactTokens = estimateContextTokens(
					compacted,
					model,
					`${buildSystemPrompt(toolProfile())}\n${JSON.stringify(toolCatalogForModel(model))}`,
				);
			}
			const reduction = Math.round(
				((ctx.length - compacted.length) / Math.max(1, ctx.length)) * 100,
			);
			compactionFailureRef = recordCompactionSuccess();
			autoCompactReentryFloorRef = autoCompactReentryFloor(
				postCompactTokens,
				postCompactLimit,
			);
			setContext(compacted);
			setMessages(
				compactedDisplayMessages(messages(), installedPreservedTurns),
			);
			setRetrySnapshot(null);
			resetFileUndoStack();
			appendInfo(
				`Context compacted via LLM summary (${reduction}% reduction, ` +
					`${summary.split('\n').length} line summary, ${postCompactTokens} estimated tokens).`,
			);
			refreshContextPercent();
			persist();
			return compacted;
		} catch (error) {
			compactionFailureRef = recordCompactionFailure(compactionFailureRef);
			if (
				compactionFailureRef.consecutiveFailures >= COMPACTION_FAILURE_LIMIT &&
				process.env.NODE_ENV !== 'test'
			) {
				appendWarning(
					`Auto-compaction paused for ${Math.round(COMPACTION_FAILURE_COOLDOWN_MS / 1000)}s after ${compactionFailureRef.consecutiveFailures} consecutive failures.`,
				);
			}
			throw error;
		} finally {
			setCompacting(false);
		}
	};
	const tryAutoCompactHistory = async (
		ctx: ChatMessageLike[],
	): Promise<ChatMessageLike[]> => {
		try {
			return await compactHistory(ctx);
		} catch (error) {
			appendWarning(
				`Auto-compaction failed; continuing current turn: ${error instanceof Error ? error.message : String(error)}`,
			);
			return ctx;
		}
	};
	const compact = async () => {
		void runHooks({event: 'SessionStart', sessionSource: 'compact'});
		if (busy()) {
			appendInfo('Cannot compact while a turn is running.');
			return;
		}
		const ctx = context();
		if (ctx.length <= 6) {
			appendInfo('Context is already compact (fewer than 7 messages).');
			return;
		}
		try {
			await compactHistory(ctx);
		} catch (error) {
			appendError(
				`Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const retryLast = () => {
		if (busy()) {
			appendInfo('Cannot retry while a turn is running.');
			return;
		}
		const snapshot = retrySnapshot();
		if (!snapshot) {
			appendInfo('Nothing to retry yet.');
			return;
		}
		setMessages(snapshot.messages);
		setContext(snapshot.context);
		setInput('');
		void submit(snapshot.prompt);
	};

	const undoLast = () => {
		if (busy()) {
			appendInfo('Cannot undo while a turn is running.');
			return;
		}
		const {keptMessages, keptContext, undonePrompt} = undoExchange(
			messages(),
			context(),
		);
		if (undonePrompt === null) {
			appendInfo('Nothing to undo yet.');
			return;
		}
		// Undo starts a new exchange: stop the COMPLETED popup.
		completionPopupController.cancel();
		setMessages(keptMessages);
		setContext(keptContext);
		// `/undo` is conversation-only. `/rewind` is the explicit destructive
		// filesystem option, so ordinary undo never changes files.
		// opencode parity: the undone prompt comes back into the input so it
		// can be edited and re-sent.
		if (undonePrompt) setInput(undonePrompt);
		persist();
		// Success notice ABOVE the input (same slot as the resume notice):
		// green, leading breakline, auto-expires a few seconds later or when
		// the next turn starts (runTurn clears the completion slot). Never a
		// permanent transcript row.
		setCompletionTone('success');
		setCompletionMessage('Undid the last message.');
		if (resumeNoticeTimer) clearTimeout(resumeNoticeTimer);
		resumeNoticeTimer = setTimeout(() => {
			setCompletionMessage('');
			setCompletionTone('default');
		}, 6000);
	};

	const rewindConversation = (userIndex: number, restoreFiles: boolean) => {
		if (busy()) {
			appendInfo('Cannot rewind while a turn is running.');
			return;
		}
		const result = rewindExchangeAt(messages(), context(), userIndex);
		if (!result.undonePrompt) {
			appendInfo('Nothing to rewind yet.');
			return;
		}
		completionPopupController.cancel();
		setMessages(result.keptMessages);
		setContext(result.keptContext);
		let restored = 0;
		if (restoreFiles) restored = rewindFileExchangeAt(userIndex).length;
		else discardFileUndoFrom(userIndex);
		if (result.undonePrompt) setInput(result.undonePrompt);
		persist();
		setCompletionTone('success');
		setCompletionMessage(
			`Rewound conversation${restoreFiles ? ' and files' : ''}.` +
				(restored
					? ` Restored ${restored} file${restored === 1 ? '' : 's'}.`
					: ''),
		);
		if (resumeNoticeTimer) clearTimeout(resumeNoticeTimer);
		resumeNoticeTimer = setTimeout(() => {
			setCompletionMessage('');
			setCompletionTone('default');
		}, 6000);
	};

	const rewind = () => {
		if (busy()) {
			appendInfo('Cannot rewind while a turn is running.');
			return;
		}
		const candidates = messages()
			.map((message, index) => ({message, index}))
			.filter(({message}) => message.role === 'user' && !message.error);
		if (candidates.length === 0) {
			appendInfo('Nothing to rewind yet.');
			return;
		}
		const exchangePrompts = fileUndoExchanges();
		openSettingsList(
			'Rewind',
			candidates.map(({message, index}, userIndex) => ({
				label: message.content || '(empty message)',
				value: `before message ${userIndex + 1}${exchangePrompts[userIndex]?.prompt ? ' · files tracked' : ''}`,
				activateHint: 'select',
				onActivate: () => {
					setSettingsList(null);
					setSettingsOpen(false);
					setPendingQuestion({
						header: 'Rewind',
						question: `Restore conversation before: ${message.content || '(empty message)'}`,
						options: [
							{
								label: 'Conversation only',
								description: 'Leave files unchanged.',
							},
							{
								label: 'Conversation + files',
								description: 'Restore tracked files too.',
							},
							{label: 'Cancel'},
						],
						resolve: answer => {
							if (answer === 'Conversation only')
								rewindConversation(userIndex, false);
							if (answer === 'Conversation + files')
								rewindConversation(userIndex, true);
						},
					});
				},
			})),
		);
	};

	const fork = () => {
		if (busy()) {
			appendInfo('Cannot fork while a turn is running.');
			return;
		}
		persist();
		if (!currentSession || currentSession.messages.length === 0) {
			appendInfo('Nothing to fork yet.');
			return;
		}
		const forked = forkSession(currentSession);
		currentSession = forked;
		setSessionId(forked.id);
		setSessionName(forked.name);
		setCompletionTone('success');
		setCompletionMessage(`Forked session ${forked.id}.`);
		showToast(`Forked: ${forked.id}`);
	};
	const herdrFork = (split: string) => {
		if (!herdrAvailable()) {
			appendInfo('/herdr:fork is only available inside Herdr.');
			return;
		}
		if (busy()) {
			appendInfo('Cannot fork while a turn is running.');
			return;
		}
		persist();
		if (!currentSession || currentSession.messages.length === 0) {
			appendInfo('Nothing to fork yet.');
			return;
		}
		const normalizedSplit = split.trim().toLowerCase();
		if (normalizedSplit !== 'vertical' && normalizedSplit !== 'horizontal') {
			appendInfo('Usage: /herdr:fork [vertical|horizontal]');
			return;
		}
		try {
			const forked = forkSession(currentSession);
			const pane = forkInHerdrPane(
				forked.id,
				normalizedSplit as HerdrSplit,
				process.cwd(),
			);
			appendInfo(`Forked ${forked.id} into Herdr pane ${pane}.`);
		} catch (error) {
			appendError(error instanceof Error ? error.message : String(error));
		}
	};
	const resumeSession = (ref?: string) => {
		if (busy()) {
			appendInfo('Cannot resume while a turn is running.');
			return;
		}
		// Resuming swaps the conversation: stop the COMPLETED popup.
		completionPopupController.cancel();
		if (!ref) {
			setResumeOpen(true);
			return;
		}
		abortRef?.abort();
		clearMessages();
		// `startNewSession(ref)` loads asynchronously. Do not persist here:
		// `currentSession` still points at the old conversation, so this write
		// can overwrite its file with the just-cleared display before resume
		// installs the target session.
		startNewSession(ref);
	};

	const listSessionsInfo = () => {
		const sessions = listSessions();
		openSettingsList(
			'Sessions',
			sessions.map(session => ({
				label: session.firstMessage || session.id,
				value: session.id,
				activateHint: 'resume',
				onActivate: () => {
					setSettingsList(null);
					setSettingsOpen(false);
					resumeSession(session.id);
				},
			})),
		);
	};

	const rename = (name: string) => {
		if (!name) {
			appendInfo('Usage: /rename <name>');
			return;
		}
		setSessionName(name);
		if (currentSession) currentSession.name = name;
		persist();
		// Session logs render as WARNING rows: yellow with the `✦` glyph
		// (parity: the vision-fallback indicator), never plain info.
		appendWarning(`  ✦ Session renamed to "${name}".`);
	};

	const checkpoint = (name: string) => {
		persist();
		if (name.trim()) {
			// A4: a named checkpoint snapshots messages+context for /restore.
			const saved = saveCheckpoint(
				name.trim(),
				messages().filter(message => message.kind !== 'info'),
				context(),
			);
			appendInfo(`Checkpoint "${saved}" saved (${sessionId()}).`);
			return;
		}
		appendInfo(`Checkpoint saved: ${sessionId()} · ${sessionName()}.`);
	};

	const checkpointsSurface = () => {
		const list = listCheckpoints();
		openSettingsList(
			'Checkpoints',
			list.map(data => ({
				label: data.name,
				value: `${data.messages.length} messages · ${new Date(
					data.createdAt,
				).toLocaleString()}`,
				activateHint: 'restore',
				onActivate: () => {
					setSettingsList(null);
					setSettingsOpen(false);
					restoreCheckpoint(data.name);
				},
			})),
		);
	};

	const restoreCheckpoint = (name: string) => {
		if (!name.trim()) {
			appendInfo('Usage: /restore <checkpoint-name>');
			return;
		}
		const data = loadCheckpoint(name.trim());
		if (!data) {
			appendInfo(`Checkpoint "${name}" not found. Try /checkpoints.`);
			return;
		}
		setMessages(data.messages);
		setContext(data.context);
		persist();
		appendInfo(
			`Restored checkpoint "${data.name}" (${data.messages.length} messages).`,
		);
	};

	// F2: catalog breadth, display-only info commands.
	// `/commands` opens the SAME list modal the settings row uses: selecting
	// a command inserts it into the input box and closes the modal (parity:
	// the reference command palette) instead of printing to the transcript.
	const commandsList = () => {
		setCommandsOpen(true);
	};
	// `/help` opens the same command catalog instead of printing into the
	// conversation transcript.
	const help = () => commandsList();
	// Pure-information commands open MODALS (same list/detail surfaces the
	// settings rows use) instead of printing into the conversation
	// transcript — `/commands`, `/tools`, `/skills`, `/tasks`, `/sessions`,
	// `/checkpoints`, `/mcp` are catalog surfaces, not chat events.
	const toolsList = () =>
		openSettingsList(
			'Tools',
			listTools().map(tool => ({label: tool})),
		);
	const skillsList = () =>
		openSettingsList(
			'Skills',
			loadSkills().map(skill => ({
				label: skill.name,
				value: skill.description || skill.source,
			})),
		);
	const tasksList = () => {
		const current = tasks();
		openSettingsList(
			'Tasks',
			current.length === 0
				? []
				: current.map(task => ({
						label: task.title,
						value: task.status.replace('_', ' '),
					})),
		);
	};
	const versionInfo = () =>
		openInfoModal('Version', `bobonyo ${VERSION} · OpenTUI rewrite`);
	const credits = () =>
		openInfoModal(
			'Credits',
			'bobonyo — NanoCollective OpenTUI terminal agent.\n' +
				'Rooted in Nano-Collective/nanocoder (MIT).',
		);
	const doctor = () =>
		openInfoModal(
			'Doctor',
			`Doctor\n` +
				`  └ config dir: ${configDir()}\n` +
				`  └ providers: ${listProviders().length}\n` +
				`  └ tools registered: ${listTools().length}\n` +
				`  └ mcp servers: ${loadMCPConfig().length}\n` +
				`  └ active memory: ${listMemoryRecords(workspaceCwd(), sessionId()).filter(record => record.status === 'active').length}\n` +
				`  └ mode: ${mode()} · profile: ${toolProfile()}\n` +
				`  └ non-interactive: ${process.env.NANOCODER_NONINTERACTIVE ? 'yes' : 'no'}`,
		);
	const privacyInfo = () => {
		const patterns = loadSettings().privacy?.patterns ?? [];
		openInfoModal(
			'Privacy',
			patterns.length === 0
				? 'Privacy scrubbing is off (no patterns configured).'
				: `Privacy patterns:\n${patterns.map(p => `  └ ${p.pattern}`).join('\n')}`,
		);
	};
	const statuslineInfo = () =>
		openInfoModal(
			'Status line',
			`Status line: ${mode()} · ${toolProfile()} · ${activeEndpoint().model}`,
		);
	const lspInfo = () =>
		openInfoModal(
			'LSP',
			`LSP diagnostics: ${diagnosticsCount()} issue${diagnosticsCount() === 1 ? '' : 's'} (last auto-diagnostics pass).`,
		);
	const innerdaemonInfo = () => {
		const rules = steeringRef.rules.length;
		openInfoModal(
			'InnerDaemon',
			`InnerDaemon steering: ${steeringRef.enabled ? 'enabled' : 'disabled'} · ` +
				`${rules} rule${rules === 1 ? '' : 's'} loaded`,
		);
	};
	const scheduleInfo = () =>
		openInfoModal(
			'Scheduled tasks',
			'Scheduled tasks: none (no scheduler in the rewrite).',
		);
	const updateInfo = () =>
		openInfoModal(
			'Update',
			`bobonyo ${VERSION}, this rewrite is the latest local build.`,
		);
	const exportSession = () => {
		const file = join(process.cwd(), `session-export-${sessionId()}.json`);
		writeFileSync(
			file,
			`${JSON.stringify({id: sessionId(), messages: messages()}, null, 2)}\n`,
		);
		appendInfo(`Session exported to ${file}`);
	};
	const contextMax = () =>
		openInfoModal(
			'Context',
			`Context: ${maxMessages()} messages cap · auto-compact ` +
				`${autoCompactRef.enabled ? `at ${autoCompactRef.threshold}%` : 'off'}`,
		);
	const setupConfigInfo = () =>
		openInfoModal(
			'Config',
			`Config dir: ${configDir()}\nProject: ${process.cwd()}`,
		);
	const setupMcpInfo = () => {
		const servers = loadMCPConfig();
		openInfoModal(
			'MCP servers',
			servers.length === 0
				? 'No MCP servers configured.'
				: `MCP servers:\n${servers.map(s => `  └ ${s.id ?? s.command}`).join('\n')}`,
		);
	};
	const remember = (args: string) => {
		const text = args.trim();
		if (!text) {
			appendInfo('Usage: /remember [user|project|session] <guidance>');
			return;
		}
		const match = text.match(/^(user|project|session)\s+(.+)$/i);
		const scope =
			(match?.[1]?.toLowerCase() as 'user' | 'project' | 'session') ??
			'project';
		const guidance = match?.[2] ?? text;
		const path = appendMemory(guidance, scope, workspaceCwd(), sessionId());
		appendInfo(`Remembered ${scope} guidance in ${path}`);
	};
	const forget = (args: string) => {
		const selector = args.trim().toLowerCase();
		if (!selector) {
			appendInfo('Usage: /forget <memory-id|user|project|session>');
			return;
		}
		if (
			selector === 'user' ||
			selector === 'project' ||
			selector === 'session'
		) {
			const path = clearMemory(selector, workspaceCwd(), sessionId());
			appendInfo(`Cleared ${selector} memory: ${path}`);
			return;
		}
		try {
			const count = forgetMemory(selector, workspaceCwd(), sessionId());
			appendInfo(
				count ? `Forgot memory ${selector}.` : `Memory not found: ${selector}`,
			);
		} catch (error) {
			appendInfo(
				`Forget failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const preferences = () =>
		openInfoModal(
			'Preferences',
			renderPersistentMemory(workspaceCwd(), sessionId()) ||
				'No persistent memory saved.',
		);

	const usage = () => {
		const history = usageHistory();
		const monthly = currentMonthUsage(activeEndpoint().baseUrl);
		const details =
			history.length === 0 && !lastUsage()
				? 'No token usage recorded yet.'
				: `Current month: ${monthly ? formatTokens(monthly.totalTokens) : '0'} tokens\n\nUsage history:\n` +
					history
						.map(
							(snapshot, index) =>
								`  └ call ${index + 1} · ${snapshot.provider}/${snapshot.model}: ` +
								`prompt ${snapshot.prompt_tokens != null ? formatTokens(snapshot.prompt_tokens) : '?'} · completion ${snapshot.completion_tokens != null ? formatTokens(snapshot.completion_tokens) : '?'}`,
						)
						.join('\n');
		// Ship all responsive layouts. DetailsModal chooses one reactively, so
		// resizing an open modal expands/collapses calendar without reopening.
		const usageVariant = (months: number) => {
			const ranges: string[] = [];
			for (let start = 0; start < 12; start += months) {
				ranges.push(
					formatUsageCalendar(
						activeEndpoint().baseUrl,
						Date.now(),
						Math.min(months, 12 - start),
						start,
					),
				);
			}
			return ranges.join('\n---USAGE_PAGE---\n');
		};
		// Include every range size. DetailsModal measures actual rendered graph
		// width and picks largest fitting range live as terminal resizes.
		const pages = Array.from({length: 12}, (_, index) => 12 - index).map(
			months => `${usageVariant(months)}\n\n${details}`,
		);
		openInfoModal('Usage', pages.join('\n---USAGE_VARIANT---\n'));
	};

	// Guards async `/status` refresh appends (codex limits) against a newer
	// open landing after an older fetch — a stale modal must never repaint.
	let statusOpenSeq = 0;
	const status = () => {
		const openSeq = ++statusOpenSeq;
		const endpoint = activeEndpoint();
		// Event-triggered DeepSeek balance refresh: opening /status is a
		// "terminal opened" moment the user asked to refresh on. The TTL
		// cache keeps this cheap when a refresh already ran recently.
		if (isDeepSeek(endpoint)) {
			void refreshDeepSeekBalance(endpoint).then(balance => {
				if (balance) {
					setDeepSeekBalance({
						currency: balance.currency,
						total: balance.total,
						isAvailable: balance.isAvailable,
					});
				}
			});
		}
		setProviderUsage(currentMonthUsage(endpoint.baseUrl));
		const cacheLabel = cacheStats(lastUsage())
			? `${endpoint.id} · ${formatCacheHitLabel(cacheStats(lastUsage()))}`
			: 'n/a';
		// `/status` opens as a MODAL (parity: settings) listing only the
		// details NOT already visible on the status line (mode, tune, agents,
		// bg, cwd) or the input corner (model[effort], ctx ~N%).
		const baseStatusData = {
			sessionLabel: `${sessionName()} (${sessionId()})`,
			provider: providerStatusLabel(
				endpoint.id,
				endpoint.name,
				endpoint.baseUrl,
			),
			messagesLabel: `${messages().length} transcript · ${context().length} provider`,
			providerUsageLabel: isXiaomiMiMo(endpoint)
				? (() => {
						const monthly = currentMonthUsage(endpoint.baseUrl);
						return monthly
							? `${formatTokens(monthly.totalTokens)} tokens total this month · ` +
									`${formatTokens(monthly.promptTokens)} prompt · ` +
									`${formatTokens(monthly.completionTokens)} completion · ` +
									`${formatTokens(monthly.cachedTokens)} cached`
							: undefined;
					})()
				: undefined,
			checkpoints: listCheckpoints().length,
			skills: loadSkills().length,
			customCommands: loadCustomCommands().length,
			mcpServers: mcpServers(),
			mcpConfigured: loadMCPConfig().map(server => server.id),
			cacheLabel,
			// B21: auto-diagnostics refresh after EVERY tool turn, code
			// changes (write/edit) never leave the LSP stale.
			lspLabel:
				(detectLanguageServers().join(', ') || 'no language servers detected') +
				(diagnosticsCount() > 0
					? ` · ${diagnosticsCount()} issue${
							diagnosticsCount() === 1 ? '' : 's'
						}`
					: ''),
			// Exactly the file embedded in the system prompt (nearest
			// AGENTS.md walking up from the cwd), so the user always knows
			// which rules the model is running under.
			rulesFile: resolveRulesFile(process.cwd()) ?? 'none',
			steeringLabel: steeringRef.enabled
				? `enabled · ${steeringRef.rules.length} rules`
				: 'disabled',
			watchdogLabel: watchdogMsRef > 0 ? `${watchdogMsRef}ms` : 'off',
			streamGuardLabel: streamGuardRef.maxDurationMs
				? `${streamGuardRef.maxDurationMs}ms`
				: 'off',
			version: `bobonyo ${VERSION}`,
		};
		setStatusRows(
			buildStatusRows({
				...baseStatusData,
				codexLimitRows: endpoint.codexAccount
					? [{label: 'Codex limits', value: 'loading limits…'}]
					: [],
			}),
		);
		// Live codex usage limits (`GET /wham/usage`), appended when the
		// active connection is the ChatGPT-account codex backend. Same
		// auth + silent-failure contract as the codex model discovery; the
		// TTL cache keeps repeated opens cheap.
		if (endpoint.codexAccount) {
			void fetchCodexLimits(endpoint.baseUrl).then(rows => {
				if (openSeq !== statusOpenSeq) return;
				setStatusRows(
					buildStatusRows({
						...baseStatusData,
						codexLimitRows:
							rows.length > 0
								? rows
								: [{label: 'Codex limits', value: 'limits unavailable'}],
					}),
				);
			});
		}
		setStatusOpen(true);
	};

	const switchModel = (args: string) => {
		const endpoint = activeEndpoint();
		const name = args.trim();
		if (!name) {
			// `/model` with no args opens the MODEL MODAL (parity: nanocoder's
			// grouped model selector) listing the real configured providers.
			// Opening the picker is a refresh trigger for the live DeepSeek
			// catalogs (the TTL cache makes this cheap when already fresh).
			refreshModelCatalogs();
			setModelModalInherit(false);
			setModelOpen(true);
			return;
		}
		if (endpoint.models.length > 0 && !endpoint.models.includes(name)) {
			appendInfo(
				`Model '${name}' is not in ${endpoint.id}'s list. ` +
					`Available: ${endpoint.models.join(', ')}`,
			);
			return;
		}
		// Effort follows the model: switching models updates the badge to the
		// new model's catalog effort.
		setActiveEndpoint({
			...endpoint,
			model: name,
			effort: (endpoint.modelEfforts ?? {})[name],
		});
		savePreferences({lastProvider: endpoint.id, lastModel: name});
		persist();
		loadProviderFeatures(endpoint);
		showToast(`Model: ${name} · ${endpoint.id}`);
	};

	/** Apply a chosen effort (or `default`) to the ACTIVE model. */
	const applyEffort = (level: string) => {
		const endpoint = activeEndpoint();
		const effortKey = `${endpoint.id}\u0000${endpoint.model}`;
		const prefs = loadPreferences();
		const nextEfforts = {...(prefs.modelEfforts ?? {})};
		if (level === 'default') delete nextEfforts[effortKey];
		else nextEfforts[effortKey] = level;
		savePreferences({
			...prefs,
			modelEfforts: nextEfforts,
		});
		const effort =
			level === 'default'
				? (endpoint.modelEfforts ?? {})[endpoint.model]
				: level;
		setActiveEndpoint(prev => ({...prev, effort}));
		showToast(
			`Effort: ${level === 'default' ? 'default' : level} · ${endpoint.model}`,
		);
	};

	/**
	 * `/effort <minimal|low|medium|high|default>` — reasoning effort for the
	 * ACTIVE model, persisted per model (keyed provider\0model) so the model
	 * modal, the status-line badge and the next selection all agree.
	 * `default` clears the override and falls back to the catalog effort.
	 * A BARE `/effort` opens the effort picker modal instead.
	 */
	const switchEffort = (args: string) => {
		const level = args.trim().toLowerCase();
		const endpoint = activeEndpoint();
		if (!level) {
			setEffortOpen(true);
			return;
		}
		const allowed = effortLevelsForModel(endpoint.model);
		if (level !== 'default' && !allowed.includes(level)) {
			appendInfo(
				`Invalid effort '${args}'. Use default, ${allowed.join(', ')}.`,
			);
			return;
		}
		applyEffort(level);
	};

	/**
	 * Provider-specific statusline/history features load when the ACTIVE
	 * provider switches, not only at startup or on /status: DeepSeek balance
	 * (`Cred:` — TTL-cached + deduped, cheap on re-switch) and the Xiaomi
	 * MiMo monthly usage ledger (`used N.NM`). Leaving MiMo clears the
	 * ledger seed so a stale total never lingers.
	 */
	const loadProviderFeatures = (provider: {
		id?: string;
		name?: string;
		baseUrl: string;
		apiKey?: string;
	}) => {
		if (isDeepSeek(provider)) {
			void refreshDeepSeekBalance(provider).then(balance => {
				if (balance) {
					setDeepSeekBalance({
						currency: balance.currency,
						total: balance.total,
						isAvailable: balance.isAvailable,
					});
				}
			});
		}
		if (isXiaomiMiMo(provider)) {
			setProviderUsage(currentMonthUsage(provider.baseUrl));
		} else {
			setProviderUsage(undefined);
		}
	};

	/**
	 * Provider catalog shown in the model modal: the live DeepSeek discovery
	 * wins over the static config list, every other provider keeps its
	 * configured models. Pure read of the signals, so async refresh results
	 * appear as soon as they land.
	 */
	const catalog = () =>
		listProviders().map(provider => ({
			id: provider.id,
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl,
			// RESOLVED key for the account picker's MASKED display — never
			// the raw secret (maskSecret shows only first/last chars).
			apiKey: provider.apiKeyResolved || undefined,
			models: discoveredModels()[provider.id] ?? provider.models,
			modelEfforts: provider.modelEfforts,
			contextWindow: provider.contextWindow,
			modelContextWindows: modelWindows()[provider.id],
		}));

	/**
	 * Refresh every live-discoverable catalog (DeepSeek + Xiaomi MiMo,
	 * deduped + TTL-cached through the shared disk cache).
	 */
	const refreshModelCatalogs = () => {
		for (const provider of listProviders()) {
			const refresh = provider.codexAccount
				? discoverCodexAccountModels(provider.baseUrl)
				: isDeepSeek(provider)
					? refreshDeepSeekModels(provider)
					: isXiaomiMiMo(provider) && provider.modelDiscoveryUrl
						? refreshProviderModels(provider, provider.modelDiscoveryUrl)
						: provider.modelDiscoveryUrl
							? discoverModels(provider)
							: undefined;
			if (!refresh) continue;
			void refresh.then(models => {
				if (models.length > 0) {
					setDiscoveredModels(prev => ({...prev, [provider.id]: models}));
					void refreshModelWindows(provider, models);
				}
			});
		}
	};

	/** ModelModal selection: switch provider + model (+ effort override). */
	const selectModel = (providerId: string, model: string, effort?: string) => {
		// FALLBACK selection (Settings → Capabilities → Vision/Web-search
		// model): save the preference, the MAIN endpoint stays untouched.
		const target = fallbackTarget();
		if (target === 'web' || target === 'vision') {
			const prefs = loadPreferences();
			if (target === 'web') {
				savePreferences({
					...prefs,
					webSearchModel: model,
					webSearchProvider: providerId,
				});
				showToast(`Web-search fallback: ${model} · ${providerId}`);
			} else {
				savePreferences({
					...prefs,
					visionModel: model,
					visionProvider: providerId,
				});
				showToast(`Vision fallback: ${model} · ${providerId}`);
			}
			setFallbackTarget(null);
			setModelModalInherit(false);
			return;
		}
		const provider = listProviders().find(
			candidate => candidate.id === providerId,
		);
		if (!provider) return;
		setActiveEndpoint({
			...activeEndpoint(),
			id: provider.id,
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKeyResolved,
			model,
			models: discoveredModels()[provider.id] ?? provider.models,
			modelEfforts: provider.modelEfforts,
			contextWindow: effectiveContextWindow(
				provider.contextWindow,
				modelWindows()[providerId]?.[model],
			),
			sdkProvider: provider.sdkProvider,
			codexAccount: provider.codexAccount,
			providerOptions: provider.providerOptions,
			// The modal's ←/→ effort override wins; otherwise the model's
			// configured catalog effort applies.
			effort: effort ?? provider.modelEfforts[model],
			promptCacheKey: provider.promptCacheKey,
			alwaysAllow: provider.alwaysAllow,
		});
		// Persist the chosen effort as a per-model override (or clear it when
		// Default was picked) so `/effort`, the modal and the next selection
		// stay consistent across restarts.
		const effortKey = `${provider.id}\u0000${model}`;
		const prefs = loadPreferences();
		const nextEfforts = {...(prefs.modelEfforts ?? {})};
		if (effort) nextEfforts[effortKey] = effort;
		else delete nextEfforts[effortKey];
		savePreferences({
			...prefs,
			lastProvider: provider.id,
			lastModel: model,
			modelEfforts: nextEfforts,
		});
		loadProviderFeatures(provider);
		// Model belongs to conversation metadata, not only global preferences.
		// Save immediately so a crash or resume before next turn cannot restore
		// stale pre-switch model. persist() reads newly active endpoint.
		persist();
		showToast(
			`Model: ${model}${effort ? ` [${effort}]` : ''} · ${provider.id}`,
		);
		setModelOpen(false);
	};

	const listProvidersInfo = () => {
		const providers = listProviders();
		const current = activeEndpoint();
		if (providers.length === 0) {
			appendInfo('No providers configured.');
			return;
		}
		appendInfo(
			`Providers:\n` +
				providers
					.map(
						provider =>
							`  └ ${provider.id}${provider.id === current.id ? ' (active)' : ''} · ` +
							`${provider.name ?? ''} · ${provider.models.length} models`,
					)
					.join('\n'),
		);
	};

	const mcpSurface = () => {
		const servers = loadMCPConfig();
		if (servers.length === 0) {
			openSettingsList('MCP servers', []);
			return;
		}
		const byServer = new Map<string, string[]>();
		for (const tool of mcpToolsRef) {
			const list = byServer.get(tool.serverId) ?? [];
			list.push(tool.name);
			byServer.set(tool.serverId, list);
		}
		openSettingsList('MCP servers', [
			...servers.map(server => ({
				label: server.id ?? server.command,
				value: `${server.command ?? ''} · ${
					(byServer.get(server.id) ?? []).join(', ') || 'not connected'
				}`,
			})),
			...(mcpToolsRef.length === 0
				? []
				: [
						{
							label: `${mcpToolsRef.length} MCP tools loaded`,
							value: mcpToolsRef.map(tool => tool.name).join(', '),
						},
					]),
		]);
	};

	const sessionCommand = (args: string) => {
		const [sub, ref] = args.trim().split(/\s+/);
		if (sub === 'delete' && ref) {
			const target =
				ref === 'last'
					? listSessions()[0]?.id
					: /^\d+$/.test(ref)
						? listSessions()[Number(ref)]?.id
						: ref;
			if (!target) {
				appendInfo(`No session found for '${ref}'.`);
				return;
			}
			deleteSession(target);
			if (target === sessionId()) {
				clearMessages();
				startNewSession();
			}
			appendInfo(`Deleted session ${target}.`);
			return;
		}
		appendInfo('Usage: /session delete <last|N|id>');
	};

	const codexReset = async () => {
		if (!activeEndpoint().codexAccount) {
			appendInfo(
				'Codex reset is available only for ChatGPT/Codex connections.',
			);
			return;
		}
		appendInfo(await consumeCodexReset(activeEndpoint().baseUrl));
	};
	const openPRs = () => {
		const urls = prs();
		if (urls.length === 0) {
			appendInfo('No PRs captured in this session yet.');
			return;
		}
		appendInfo(
			urls.length === 1
				? `Opened PR:\n  └ ${urls[0]}`
				: `Opened ${urls.length} PRs:\n${urls
						.map(url => `  └ ${url}`)
						.join('\n')}`,
		);
		for (const url of urls) void openUrl(url);
	};

	const bold = () => createTextAttributes({bold: true});
	const dim = () => createTextAttributes({dim: true});
	// Bound the chat history to the terminal rows not occupied by the banner,
	// input box and status line, otherwise a long transcript pushes the
	// input/status off the visible pane (OpenTUI's flex doesn't shrink the
	// scrollbox below its content).
	const terminalDimensions = useTerminalDimensions();
	const terminalHeight = createMemo(() => terminalDimensions().height);
	const inputBoxRows = createMemo(() =>
		computeInputBoxHeight(
			input(),
			terminalDimensions().width ?? 80,
			busy(),
			Boolean(pendingPrompt()),
			Boolean(pendingApproval()),
			cancelling(),
		),
	);
	const visiblePendingQueueCount = createMemo(
		() => pendingQueue().filter(item => !item.source).length,
	);
	// Reactive: the App body runs once, so a plain const would freeze the
	// height at mount and a growing history/panel would push the input box
	// and status line off the visible pane. The memo re-derives on every
	// signal read below (terminal resize, busy, settings panel, …).
	// TERMINAL-LIKE INPUT PLACEMENT: the history is min(measured content,
	// cap) — on first load the banner is short, so the input sits right
	// below it; as the conversation grows the input slides down; once the
	// content reaches the cap the input sticks at the bottom (current
	// position) and the history scrolls.
	const historyHeight = createMemo(() =>
		Math.max(
			4,
			Math.min(
				historyContentHeight(),
				// The input box and status line stay visible even while a
				// modal is open (the modal overlays ONLY the history region).
				terminalHeight() -
					inputBoxRows() -
					2 -
					(running() ? 1 : 0) -
					(lineTickerVisible(thinkingMode(), busy(), thinkingActive())
						? 1
						: 0) -
					bashModeIndicatorRows(input()) -
					startupLoading().length -
					completionMessageRows(completionMessage(), completionTone()) -
					(exitConfirm() ? 1 : 0) -
					(visiblePendingQueueCount() > 0
						? visiblePendingQueueCount() + 1
						: 0) -
					completionPopupHeight(input(), terminalDimensions().width) -
					mentionPopupHeight(input()),
			),
		),
	);
	return (
		// Parity: nanocoder's root carries one column of padding; the input
		// box adds its own so the border sits at column 2.
		// Parity: root carries one column of padding; the omnicode text color
		// (#c0caf5) is the default for the whole transcript.
		<box
			flexDirection="column"
			flexGrow={1}
			flexShrink={1}
			height="100%"
			paddingX={1}
			{...({
				// COMPLETED popup idle detection: EVERY mouse move/click
				// anywhere in the app bubbles to the root — dismisses a
				// visible popup, or CANCELS an armed one (the user moved the
				// mouse after the task finished = present = never show).
				onMouseMove: () => completionPopupController.activity(),
				onMouseDown: () => completionPopupController.activity(),
			} as any)}
		>
			<History
				height={historyHeight()}
				onContentHeight={setHistoryContentHeight}
			/>
			{/* Bottom gap: the last response never sticks to the Working
			    indicator above the input. */}
			<box height={1} />
			{/* The input box and status line stay visible while a modal is
			    open, the modal only overlays the history region above. */}
			<InputBox
				onSubmit={(value, attachments) => void submit(value, attachments)}
			/>
			{/* Terminal-like layout: this spacer absorbs the empty rows below
			    the input while the conversation is short, so the status line
			    stays pinned at the bottom; it shrinks to zero once the
			    history fills the cap and the input reaches the bottom. */}
			<box flexGrow={1} />
			{/* Status Line setting (on/off) toggles the footer. */}
			<Show when={statusLineEnabled()}>
				<Status cwd={workspaceCwd()} />
			</Show>
			{/* Settings open as an modal-style MODAL: the chat stays visible
			    behind a translucent backdrop and a card container on top. */}
			<Show when={settingsOpen()}>
				<Show
					when={settingsList()}
					fallback={
						<SettingsModal
							onClose={() => setSettingsOpen(false)}
							onEdit={editSettingRow}
							onApply={applySetting}
							onModelSelect={target => {
								setSettingsOpen(false);
								setFallbackTarget(target === 'main' ? null : target);
								// "Inherit main agent model" only applies to
								// the capability fallbacks (vision/web-search),
								// never to the MAIN model picker — `/model`
								// and the settings Model row open the same
								// surface, so the inherit row must match.
								setModelModalInherit(target !== 'main');
								refreshModelCatalogs();
								setModelOpen(true);
							}}
						/>
					}
				>
					{list => (
						<SettingsListModal
							title={list().title}
							rows={list().rows}
							onEditProvider={providerId => {
								// Open the connect MODAL prefilled with the
								// provider (opencode-style edit), never the
								// input-row wizard. CLOSE the settings list
								// first: both surfaces register useKeyboard,
								// so a key aimed at the connect modal would
								// also hit the settings search behind it.
								setSettingsList(null);
								setSettingsOpen(false);
								setConnectOpen({editId: providerId});
							}}
							onInsert={text => {
								setSettingsList(null);
								setSettingsOpen(false);
								setInput(text);
							}}
							onClose={() => setSettingsList(null)}
						/>
					)}
				</Show>
			</Show>
			{/* `/status` opens as a MODAL over the history (input stays
			    visible below). */}
			<Show when={statusOpen()}>
				<StatusModal rows={statusRows()} onClose={() => setStatusOpen(false)} />
			</Show>
			{/* `/model` opens as a MODAL (parity: nanocoder's model selector). */}
			<Show when={modelOpen()}>
				<ModelModal
					providers={catalog()}
					currentProvider={activeEndpoint().id}
					currentModel={activeEndpoint().model}
					onSelect={selectModel}
					onConnectProvider={() => {
						// Close the model picker first: BOTH modals register
						// useKeyboard, so an Esc meant for the connect modal
						// would also close the picker behind it. On connect,
						// saveConnectedProvider reopens the picker fresh.
						setModelOpen(false);
						setConnectOpen({});
					}}
					onClose={() => {
						setModelOpen(false);
						setModelModalInherit(false);
						setFallbackTarget(null);
					}}
					hasMessages={messages().length > 0}
					inheritLabel={
						modelModalInherit() ? 'Inherit main agent model' : undefined
					}
					onInherit={() => {
						// Inherit = clear the fallback pref (use the main
						// agent model) OR keep the main model, then close.
						if (fallbackTarget()) {
							const prefs = loadPreferences();
							if (fallbackTarget() === 'web') {
								savePreferences({
									...prefs,
									webSearchModel: undefined,
									webSearchProvider: undefined,
								});
								showToast(
									'Web-search fallback cleared (main model handles searches)',
								);
							} else if (fallbackTarget() === 'vision') {
								savePreferences({
									...prefs,
									visionModel: undefined,
									visionProvider: undefined,
								});
								showToast(
									'Vision fallback cleared (main model handles images)',
								);
							}
						}
						setModelOpen(false);
						setModelModalInherit(false);
						setFallbackTarget(null);
						setResumeOpen(false);
					}}
				/>
			</Show>
			{/* Built-in agents (Settings → Capabilities → Agents). */}
			<Show when={agentsOpen()}>
				<AgentsModal
					providers={catalog()}
					currentProvider={activeEndpoint().id}
					currentModel={activeEndpoint().model}
					onConnectProvider={() => {
						setAgentsOpen(false);
						setConnectOpen({});
					}}
					onChanged={showToast}
					onClose={() => setAgentsOpen(false)}
				/>
			</Show>
			{/* Compact-block details (clicking an expandable tool tally). */}
			<Show when={detailsOpen()}>
				<DetailsModal
					title={detailsTitle()}
					content={detailsContent()}
					onClose={() => setDetailsOpen(false)}
				/>
			</Show>
			{/* Background-jobs modal (`/ps` or the floating notification):
			    live list of running bash tasks with tailed realtime output. */}
			<Show when={psOpen()}>
				<BackgroundJobsModal
					goal={visibleGoal()}
					initialTab={psInitialTab()}
					onClose={() => setPsOpen(false)}
				/>
			</Show>
			{/* `/resume` opens as a MODAL (parity: the reference session picker). */}
			{/* `/commands` / `/help`: grouped 2-column catalog modal. */}
			<Show when={commandsOpen()}>
				<CommandsModal
					onInsert={text => {
						setCommandsOpen(false);
						setInput(text);
					}}
					onClose={() => setCommandsOpen(false)}
				/>
			</Show>
			<Show when={resumeOpen()}>
				<ResumeModal
					cwd={process.cwd()}
					// Read version makes filesystem-backed rows refresh after saves.
					sessions={(sessionListVersion(), listSessions()).map(session => ({
						id: session.id,
						name: session.name,
						createdAt: session.createdAt,
						updatedAt: session.updatedAt,
						firstMessage: session.firstMessage,
						cwd: session.cwd,
						provider: session.provider,
						model: session.model,
					}))}
					onResume={id => {
						setResumeOpen(false);
						resumeSession(id);
					}}
					onClose={() => setResumeOpen(false)}
				/>
			</Show>
			<Show when={pendingQuestion()}>
				<QuestionModal
					header={pendingQuestion()!.header}
					question={pendingQuestion()!.question}
					options={pendingQuestion()!.options}
					multiple={pendingQuestion()!.multiple}
					onAnswer={answer => {
						const pending = pendingQuestion();
						setPendingQuestion(null);
						pending?.resolve(answer);
					}}
					onCancel={() => {
						const pending = pendingQuestion();
						setPendingQuestion(null);
						pending?.resolve('');
					}}
				/>
			</Show>
			{/* First-run TRUST dialog (codex-style modal): explicit Yes/No,
			    never the free-text prompt row. */}
			<Show when={pendingTrust()}>
				<TrustModal
					directory={pendingTrust()!.directory}
					onTrust={() => {
						pendingTrust()!.resolve(true);
						setPendingTrust(null);
					}}
					onDecline={() => {
						// Decline = EXIT (the app must not run untrusted);
						// resolve(false) triggers the exit path.
						pendingTrust()!.resolve(false);
						setPendingTrust(null);
					}}
				/>
			</Show>
			{/* Provider-connect MODAL (opencode-style picker → auth method →
			    in-modal prompts). Rendered LAST so it floats above every
			    other modal; the model/settings pickers stay open behind it
			    and refresh when the provider saves. */}
			<Show when={connectOpen()}>
				<ConnectProviderModal
					provider={connectOpen()!.provider}
					editId={connectOpen()!.editId}
					onConnect={saveConnectedProvider}
					onDelete={deleteProvider}
					onClose={() => setConnectOpen(null)}
				/>
			</Show>
			{/* Bare `/effort` opens the effort picker (opencode-style list of
			    Default + reasoning tiers for the ACTIVE model). */}
			<Show when={effortOpen()}>
				<EffortModal
					model={activeEndpoint().model}
					provider={activeEndpoint().name}
					currentEffort={
						loadPreferences().modelEfforts?.[
							`${activeEndpoint().id}\u0000${activeEndpoint().model}`
						]
					}
					defaultEffort={
						(activeEndpoint().modelEfforts ?? {})[activeEndpoint().model]
					}
					onSelect={level => {
						applyEffort(level);
						setEffortOpen(false);
					}}
					onClose={() => setEffortOpen(false)}
				/>
			</Show>
			{/* COMPLETED attention modal: a centered success card shown AFTER
			    a task finishes while the user is idle. The FIRST mouse move
			    (or key / click) dismisses it — any activity routes through
			    the controller. */}
			<Show when={completionPopup()}>
				<CompletionPopup
					message={completionMessage()}
					onDismiss={() => completionPopupController.activity()}
				/>
			</Show>
			{/* The `✦ Worked for …` line ABOVE the input stays visible while
			    the COMPLETED modal is up: the popup's full-screen backdrop
			    would dim it, and the user asked to retain the message above
			    the input. Render a bright copy at the EXACT same position
			    (the completion line is the first row of the InputBox column,
			    directly under the history + its gap) with a z-index above
			    the popup's backdrop (3000) — only while the popup is
			    visible, so nothing duplicates in normal operation. */}
			<Show when={completionPopup() && completionMessage()}>
				<box
					position="absolute"
					top={historyHeight() + 1}
					left={1}
					width={terminalDimensions().width ?? 80}
					zIndex={3100}
				>
					<text fg={colors().secondary}>{completionMessage()}</text>
				</box>
			</Show>
			{/* FLOATING activity notification (top-right, sticky): background
			    jobs, subagents, and active long-running goal. Click opens the
			    monitor on the goal when present, otherwise the active process
			    section. Hidden while any modal is up. */}
			<Show
				when={
					(activeBgCount() > 0 ||
						activeAgents() > 0 ||
						visibleGoal()?.status === 'active') &&
					!anyModalOpen()
				}
			>
				<ActivityIndicator
					backgroundCount={activeBgCount()}
					agentCount={activeAgents()}
					goalActive={visibleGoal()?.status === 'active'}
					onOpen={() => {
						setPsInitialTab(
							visibleGoal()?.status === 'active'
								? 'goal'
								: activeBgCount() > 0
									? 'jobs'
									: 'agents',
						);
						setPsOpen(true);
					}}
				/>
			</Show>
			{/* Transient TOAST at the top of the screen (parity: the reference
			    "copied to clipboard" toast), setting changes (model /
			    fallback / mode) appear here and auto-dismiss; they NEVER
			    pollute the chat history. */}
			<Show when={toast()}>
				<box
					position="absolute"
					top={1}
					left={Math.max(
						1,
						Math.floor(
							((terminalDimensions().width ?? 80) - toast().length) / 2,
						),
					)}
					backgroundColor={colors().base}
					paddingX={2}
					paddingY={0}
					zIndex={4000}
				>
					<text
						fg={colors().primary}
						attributes={createTextAttributes({bold: true})}
					>
						{toast()}
					</text>
				</box>
			</Show>
		</box>
	);
}

function usageSignal(usage: Record<string, unknown> | undefined):
	| {
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
			promptCacheHitTokens?: number;
			promptCacheMissTokens?: number;
	  }
	| undefined {
	if (!usage) return undefined;
	// ANY provider can feed the cache rate: DeepSeek's explicit split, the
	// OpenAI-style `cached_tokens` (miss derived from prompt_tokens), or
	// Anthropic's `cache_read_input_tokens`. Fields stay undefined until the
	// provider actually reports cache info, so the ledger/status line never
	// fabricate a 0% rate.
	const cache = extractCacheTokens(usage);
	const reportedCache = cache.hit > 0 || cache.miss > 0;
	return {
		prompt_tokens: finiteNumber(usage.prompt_tokens),
		completion_tokens: finiteNumber(usage.completion_tokens),
		total_tokens: finiteNumber(usage.total_tokens),
		promptCacheHitTokens: reportedCache ? cache.hit : undefined,
		promptCacheMissTokens: reportedCache ? cache.miss : undefined,
	};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Compact tool row fallback content (history re-formats from `message.tool`).
 */
function toolRow(call: MockToolCall, content: string): string {
	const name = displayToolName(call.name);
	const args = toolArgsSummary(call);
	const header = args ? `✦ ${name}(${args})` : `✦ ${name}`;
	const tail = toolResultTail(content);
	return tail ? `${header}\n  └ ${tail}` : header;
}

const PR_URL_RE =
	/https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s)]+\/pull\/\d+/g;

/** Session-scoped PR capture (parity: /tool:open-prs finds these). */
function capturePRs(text: string): void {
	for (const url of text.match(PR_URL_RE) ?? []) addPR(url);
}

/** Best-effort open in the default browser, detached so the TUI never waits. */
function openUrl(url: string): void {
	const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
	try {
		Bun.spawn([cmd, url], {
			detached: true,
			stdout: 'ignore',
			stderr: 'ignore',
		});
	} catch {
		// No browser/command available, the rendered list is the fallback.
	}
}

/**
 * B4: message capping, send only the newest N messages, never splitting a
 * tool-call/result pair (a leading tool result without its assistant call is
 * dropped). The system block is prepended client-side and never counted.
 */
/**
 * Resolve models.dev context windows for a provider's catalog (async,
 * catalog-cached; NEVER throws — entries models.dev doesn't know stay
 * unknown). The model modal's size column reads this map per model.
 */
async function refreshModelWindows(
	provider: ResolvedProvider,
	models: string[],
): Promise<void> {
	const windows: Record<string, number> = {};
	await Promise.all(
		models.map(async model => {
			const window = await resolveContextWindow(model, undefined, provider.id);
			if (window && window > 0) windows[model] = window;
		}),
	);
	setModelWindows(prev => ({...prev, [provider.id]: windows}));
}

/**
 * Context committed when a turn is INTERRUPTED (Esc / watchdog). The turn's
 * FULL history — including the user message that started it — must reach the
 * provider, or every interrupted turn silently vanishes from the next
 * request: after a few Esc'd turns the context is empty and the model (or a
 * freshly switched one) reports "no previous context". A partial assistant
 * reply rides on top when one streamed. Pure, unit-tested.
 */
export function interruptedContext(
	history: ChatMessageLike[],
	partial: string,
): ChatMessageLike[] {
	return partial.trim()
		? [...history, {role: 'assistant' as const, content: partial}]
		: [...history];
}

/**
 * Rebuild the arrow-up prompt history from a session's transcript (used on
 * resume so ↑ recalls the prompts this conversation actually sent). Pure,
 * unit-tested: user messages only, `command.original` (the typed command)
 * wins over the injected body, errors skipped, consecutive duplicates
 * collapsed, newest last, capped at 100 like the live per-turn history.
 */
export function promptHistoryFromMessages(messages: ChatMessage[]): string[] {
	const history: string[] = [];
	for (const message of messages) {
		if (message.role !== 'user' || message.error) continue;
		const prompt = message.command?.original ?? message.content ?? '';
		if (!prompt) continue;
		if (history[history.length - 1] === prompt) continue;
		history.push(prompt);
	}
	return history.slice(-100);
}

/**
 * `/undo` cut points (pure, unit-tested).
 *
 * Reverts the LAST exchange: both the transcript and the provider context
 * truncate at the last user message, and the undone prompt is returned so
 * the input can be restored for editing.
 *
 * CACHE INVARIANT: truncation makes the next request's message list a
 * STRICT PREFIX of the previous one, so the provider's prefix cache for
 * the retained history stays warm — undo must NEVER mutate earlier
 * messages in place (that would change the head and miss the whole cache).
 */
export function undoExchange(
	messages: ChatMessage[],
	context: ChatMessageLike[],
): {
	keptMessages: ChatMessage[];
	keptContext: ChatMessageLike[];
	undonePrompt: string | null;
} {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === 'user' && !messages[i]!.error) {
			lastUser = i;
			break;
		}
	}
	if (lastUser === -1) {
		return {keptMessages: messages, keptContext: context, undonePrompt: null};
	}
	let ctxCut = context.length;
	for (let i = context.length - 1; i >= 0; i--) {
		if (context[i]?.role === 'user') {
			ctxCut = i;
			break;
		}
	}
	const keptMessages = messages.slice(0, lastUser);
	// healResumedContext keeps the truncation when the user counts align and
	// rebuilds from the transcript when the context ever lagged (resume-heal
	// safety) — either way the result is a strict prefix of the old list.
	const keptContext = healResumedContext(
		context.slice(0, ctxCut),
		keptMessages,
	);
	return {
		keptMessages,
		keptContext,
		undonePrompt: messages[lastUser]!.content ?? null,
	};
}

/** Rewind immediately before selected non-error user exchange. */
export function rewindExchangeAt(
	messages: ChatMessage[],
	context: ChatMessageLike[],
	userIndex: number,
): {
	keptMessages: ChatMessage[];
	keptContext: ChatMessageLike[];
	undonePrompt: string | null;
} {
	const users = messages
		.map((message, index) => ({message, index}))
		.filter(({message}) => message.role === 'user' && !message.error);
	const target = users[userIndex];
	if (!target)
		return {keptMessages: messages, keptContext: context, undonePrompt: null};
	let ctxCut = context.length;
	let seenUsers = 0;
	for (let index = 0; index < context.length; index++) {
		if (context[index]?.role !== 'user') continue;
		if (seenUsers === userIndex) {
			ctxCut = index;
			break;
		}
		seenUsers++;
	}
	const keptMessages = messages.slice(0, target.index);
	return {
		keptMessages,
		keptContext: healResumedContext(context.slice(0, ctxCut), keptMessages),
		undonePrompt: target.message.content ?? null,
	};
}

function capMessages(
	history: ChatMessageLike[],
	cap: number,
): ChatMessageLike[] {
	if (history.length <= cap) return history;
	const sliced = history.slice(-cap);
	let start = 0;
	while (start < sliced.length && sliced[start]?.role === 'tool') start++;
	return sliced.slice(start);
}

/**
 * Select the user messages kept verbatim under a compaction summary (parity:
 * codex `collect_user_messages` + `build_compacted_history_with_limit`).
 * The NEWEST messages are kept first up to COMPACT_USER_MESSAGE_MAX_TOKENS;
 * when an OLD message would exceed the remaining budget it is TRUNCATED to
 * fit (never dropped whole, so a giant single user message still leaves a
 * usable trace). The summary itself is appended after these by the caller.
 */
/**
 * Drop oldest complete user turn for context-overflow retry. Never leave a
 * leading tool result detached from its assistant tool call.
 */
export function trimOldestCompactionTurn(
	messages: ChatMessageLike[],
): ChatMessageLike[] {
	const userStarts = messages
		.map((message, index) =>
			message.role === 'user' && !isCompactionControlMessage(message.content)
				? index
				: -1,
		)
		.filter(index => index >= 0);
	if (userStarts.length < 2) return messages;
	const baseline = messages
		.slice(0, userStarts[0])
		.filter(message => isCompactionMergeBaseline(message.content));
	return [...baseline, ...messages.slice(userStarts[1])];
}

/** Post-compaction guard may drop even the final preserved turn. */
export function dropOldestPreservedTurn(
	messages: ChatMessageLike[],
): ChatMessageLike[] {
	const userStarts = messages
		.map((message, index) =>
			message.role === 'user' && !isCompactionControlMessage(message.content)
				? index
				: -1,
		)
		.filter(index => index >= 0);
	if (userStarts.length === 0) return [];
	return userStarts.length === 1 ? [] : messages.slice(userStarts[1]);
}

export function partitionCompactionHistory(
	ctx: ChatMessageLike[],
	maxTokens = COMPACT_RECENT_TAIL_MAX_TOKENS,
	model = activeEndpoint().model,
): CompactionPartition {
	if (ctx.length === 0 || maxTokens <= 0) {
		return {summarize: ctx, preserve: [], preservedTurns: 0};
	}
	const starts = ctx
		.map((message, index) =>
			message.role === 'user' && !isCompactionControlMessage(message.content)
				? index
				: -1,
		)
		.filter(index => index >= 0);
	let cut = ctx.length;
	let preservedTurns = 0;
	for (let i = starts.length - 1; i >= 0; i--) {
		const candidate = starts[i]!;
		// Compaction must remove something. Preserving from index 0 would make
		// a costly summary request that installs the original history unchanged.
		if (candidate === 0) break;
		const tokens = ctx.slice(candidate).reduce((total, message) => {
			const calls = (message.tool_calls ?? [])
				.map(call => `${call.name}\n${call.arguments}`)
				.join('\n');
			return (
				total + estimateTokens(`${message.content ?? ''}\n${calls}`, model)
			);
		}, 0);
		if (tokens > maxTokens) break;
		cut = candidate;
		preservedTurns += 1;
	}
	return {
		summarize: ctx.slice(0, cut),
		preserve: ctx.slice(cut),
		preservedTurns,
	};
}

/** Remove drafting wrappers some models emit despite text-only instructions. */
export function normalizeCompactionSummary(raw: string): string {
	let summary = raw
		.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
		.replace(/^```(?:markdown|md|text)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
	const wrapped = /<summary>([\s\S]*?)<\/summary>/i.exec(summary);
	if (wrapped) summary = wrapped[1]!.trim();
	return summary;
}

export function collectCompactedUserMessages(
	ctx: ChatMessageLike[],
	maxTokens = COMPACT_USER_MESSAGE_MAX_TOKENS,
): ChatMessageLike[] {
	// Skip previous compaction summaries (parity: codex `is_summary_message`
	// in collect_user_messages) so a second compaction never re-summarizes an
	// old summary — only the real user prompts are candidates.
	const users = ctx.filter(
		message =>
			message.role === 'user' && !isCompactionControlMessage(message.content),
	);
	if (users.length === 0 || maxTokens <= 0) return [];
	const selected: ChatMessageLike[] = [];
	let remaining = maxTokens;
	for (let i = users.length - 1; i >= 0; i--) {
		const message = users[i]!;
		const content = message.content ?? '';
		const tokens = estimateTokens(content, activeEndpoint().model);
		if (tokens <= remaining) {
			selected.unshift(message);
			remaining -= tokens;
			continue;
		}
		// Oldest oversized message: keep a truncated trace so the pair
		// survives instead of being dropped whole (codex truncate_text).
		if (remaining > 8 && content.length > 32) {
			// ~4 chars/token for the default model family; the exact bound is
			// only a budget heuristic, keep it comfortably under `remaining`.
			const chars = Math.max(32, Math.floor(remaining * 4));
			selected.unshift({
				role: 'user',
				content: `${content.slice(0, chars)}\n… [truncated]`,
			});
		}
		break;
	}
	return selected;
}

/**
 * The DISPLAY transcript after a compaction: the old wall of messages is
 * replaced by the NEWEST kept user prompt + its recent tail (the last
 * exchange), with the compaction summary notice appended on top by the
 * caller. This is what gets persisted, so a later /resume shows the
 * COMPACTED conversation instead of the pre-compaction history. Pure,
 * unit-tested.
 */
export function compactedDisplayMessages(
	messages: ChatMessage[],
	userPromptCount: number,
): ChatMessage[] {
	if (userPromptCount <= 0) return [];
	// Keep same number of complete recent turns as provider context. Cutting
	// only at newest user message made transcript disagree with retained
	// context and hid useful tool procedure immediately after compaction.
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== 'user' || message.kind === 'info') continue;
		seen += 1;
		if (seen === userPromptCount) return messages.slice(i);
	}
	return messages;
}

/**
 * Is this error a context-window overflow we can recover from during
 * compaction by trimming the oldest history item (parity: codex's
 * `ContextWindowExceeded` handling)? OpenAI-compatible providers report the
 * window breach as 400 ("context length exceeded") or 413 (payload too
 * large); anything else fails compaction immediately.
 */
export function isCompactOverflowError(error: unknown): boolean {
	if (
		error instanceof ProviderError &&
		(error.status === 400 || error.status === 413)
	) {
		return true;
	}
	if (!(error instanceof Error)) return false;
	return /(?:input exceeds|exceeds? (?:the )?context window|context (?:length|window).*(?:exceed|limit)|maximum context length|too many (?:input )?tokens)/i.test(
		error.message,
	);
}

const COMPLETION_ADJECTIVES = [
	'brisk',
	'swift',
	'breezy',
	'thoughtful',
	'steady',
	'snappy',
	'crisp',
	'diligent',
	'nimble',
	'spirited',
	'keen',
	'zippy',
	'lively',
	'focused',
	'peppy',
	'resolute',
	'deft',
	'plucky',
	'hearty',
	'jaunty',
	'sprightly',
	'tenacious',
	'chipper',
];

function getRandomAdjective(): string {
	const index = Math.floor(Math.random() * COMPLETION_ADJECTIVES.length);
	return COMPLETION_ADJECTIVES[index] ?? 'brisk';
}

function formatElapsedTime(startedAt: number): string {
	const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	return formatElapsed(elapsed);
}

/** Quote-aware argument split (double/single/backtick + bare tokens). */
function quoteAwareSplit(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input))) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
	}
	return tokens;
}

/**
 * B22: outgoing privacy scrub with response rehydration. Configured patterns
 * become `<REDACTED:n>` placeholders before the request leaves; replies get
 * the originals back so the transcript never shows the placeholders.
 */
function createScrubber(
	patterns: Array<{pattern: string; placeholder?: string}>,
) {
	const map = new Map<string, string>();
	let counter = 0;
	const scrub = (text: string): string => {
		let output = text;
		for (const entry of patterns) {
			try {
				const re = new RegExp(entry.pattern, 'g');
				output = output.replace(re, match => {
					const placeholder = entry.placeholder ?? `<REDACTED:${++counter}>`;
					map.set(placeholder, match);
					return placeholder;
				});
			} catch {
				// invalid pattern, skip
			}
		}
		return output;
	};
	const rehydrate = (text: string): string => {
		let output = text;
		for (const [placeholder, original] of map) {
			output = output.split(placeholder).join(original);
		}
		return output;
	};
	return {scrub, rehydrate};
}

function firstLine(content: string, max: number): string {
	const line = content.split('\n')[0] ?? '';
	return line.length > max ? `${line.slice(0, max)}…` : line;
}
