/** @jsxImportSource @opentui/solid */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {useKeyboard, useRenderer, useTerminalDimensions} from '@opentui/solid';
import {createTextAttributes} from '@opentui/core';
import {createMemo, createSignal, Show} from 'solid-js';
import {
	looksLikeToolCallText,
	parseArguments,
	parseToolCalls,
	ProviderError,
	setFallbackEndpoints,
	streamChat,
	type ChatMessageLike,
	type MockToolCall,
} from './client';
import {
	discoverModels,
	configDir,
	listProviders,
	loadConfig,
	loadPreferences,
	resolveContextWindow,
	resolveProvider,
	saveConfig,
	savePreferences,
} from './config';
import {resolveRulesFile} from './rules-file';
import {
	loadCustomCommands,
	loadCustomTools,
	loadSkills,
	substituteTemplateVariables,
} from './custom';
import {
	displayToolName,
	executeTool,
	isReadOnlyTool,
	isSingleToolProfile,
	listTools,
	registerTool,
	requiresApproval,
	toolDisplayDetail,
	toolAvailability,
	toolArgsSummary,
	toolResultTail,
} from './tools';
import {activeBgCount, bgTasks, runBash} from './bash';
import {
	COMMAND_DESCRIPTIONS,
	findCustomCommand,
	runCommand,
} from './commands';
import {loadSettings, saveSettings, type Mode, type ToolProfile} from './settings';
import {estimateTokens} from './tokenize';
import {
	classifyIntent,
	evaluateSteering,
	evaluateToolConstraint,
	formatInnerDaemonRow,
	loadSteeringConfig,
	type SteeringConfig,
} from './steering';
import {connectMCPServer, loadMCPConfig, type MCPTool} from './mcp';
import {
	deleteSession,
	firstMessagePreview,
	listCheckpoints,
	loadCheckpoint,
	listSessions,
	newSessionId,
	resolveSession,
	saveCheckpoint,
	saveSession,
	type SessionData,
} from './session';
import {History} from './components/history';
import {
	computeInputBoxHeight,
	completionPopupHeight,
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
import {Status} from './components/status';
import {StatusModal, type StatusRow} from './components/status-modal';
import {ModelModal, type ModelProvider} from './components/model-modal';
import {ResumeModal, type ResumeSession} from './components/resume-modal';
import {AgentsModal} from './components/agents-modal';
import {DetailsModal} from './components/details-modal';
import {buildStatusRows} from './status-rows';
import {analyzeImageWithFallback, resolveVisionFallback} from './vision';
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
	formatTokens,
	recordProviderUsage,
} from './provider-usage';
import {buildBannerBox} from './banner';
import {colors, selectTheme, setThemeName, THEMES} from './theme';
import {TrustModal} from './components/trust-modal';

const VERSION = '0.1.0';
import {
	addPR,
	activeAgents,
	activeEndpoint,
	appendAssistantMessage,
	appendError,
	appendInfo,
	appendMessage,
	appendWarning,
	showToast,
	toast,
	formatElapsed,
	busy,
	cancelling,
	clearMessages,
	context,
	contextPercent,
	completionMessage,
	deepSeekBalance,
	diagnosticsCount,
	discoveredModels,
	exitConfirm,
	input,
	lastUsage,
	maxMessages,
	messages,
	mode,
	pendingQueue,
	pendingApproval,
	pendingPrompt,
	pendingTrust,
	prs,
	providerUsage,
	reasoning,
	retrySnapshot,
	running,
	setBusy,
	setCancelling,
	setActiveEndpoint,
	setContextPercent,
	setContext,
	setCompletionMessage,
	setDeepSeekBalance,
	setDiscoveredModels,
	setStartupLoading,
	setMcpServers,
	setDiagnosticsCount,
	setExitConfirm,
	setHistoryIndex,
	setInput,
	setLastUsage,
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
	statusLineEnabled,
	titleShape,
	toolProfile,
	usageHistory,
	workingTipVisible,
} from './state';

const MAX_TURN_ROUNDS = 8;
const MAX_EMPTY_TURNS = 2;
const MAX_REPEATED_TOOL_CALLS = 3;
const MAX_MALFORMED_RETRIES = 2;
// Codex-style LLM compaction (port of codex-rs/core/src/compact.rs): the old
// context is sent to the model in a SEPARATE summarization request; the
// returned handoff summary REPLACES the history (prefixed + recent user
// prompts kept). The main conversation's provider prefix stays short, so the
// next turn starts a fresh cache head instead of resending the old blob.
const SUMMARIZATION_PROMPT =
	'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n' +
	'Include:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n' +
	'- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\n' +
	'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.';
export const SUMMARY_PREFIX =
	'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary:';
/**
 * Cap on USER messages kept verbatim under the compaction summary (parity:
 * codex COMPACT_USER_MESSAGE_MAX_TOKENS). The newest user messages are kept
 * first; an oversized OLDEST message is truncated to fit the remaining
 * budget (codex `build_compacted_history_with_limit`). The summary itself is
 * never part of this budget.
 */
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

/**
 * App shell, routing (A5), the agent turn loop, sessions (A8) and the
 * slash-command surface (F1-F3). Command output is display-only: it goes to
 * the transcript as info rows, never to the provider context, never
 * persisted.
 */
export function App() {
	const renderer = useRenderer();
	const [statusRows, setStatusRows] = createSignal<StatusRow[]>([]);
	const [settingsList, setSettingsList] = createSignal<{
		title: string;
		rows: SettingsListRow[];
	} | null>(null);
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
	let currentSession: SessionData | null = null;
	let interruptedRef = false;
	// CACHE HEAD GATE: the tool catalog is part of the request prefix
	// (parity: codex + nanocoder tool-filter). Lazy MCP/custom-tool loading
	// can still be registering tools when the app paints, so the FIRST LLM
	// request must wait for loading to finish — otherwise the tool array
	// grows between turn 1 and turn 2 and busts the whole prefix cache.
	let startupReadyRef = false;
	let watchdogRef = false;
	const autoCompactRef: {enabled: boolean; threshold: number} = {
		enabled: false,
		threshold: 75,
	};
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
	setInterval(() => {
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
	}, 5 * 60 * 1000);

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
						: catalog[0] ?? 'mock-model-1';
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
					providerOptions: provider.providerOptions,
					// EFFORT IS PER MODEL: the badge comes from the SELECTED
					// model's catalog entry, never an env var.
					effort: (provider.modelEfforts ?? {})[preferredModel],
					promptCacheKey: provider.promptCacheKey,
					alwaysAllow: provider.alwaysAllow,
				});
				savePreferences({lastProvider: provider.id, lastModel: preferredModel});
				// Seed the monthly usage indicator from the DISK ledger so
				// the status line shows `used N.NM` immediately on a warm
				// ledger (even before the first turn of this session).
				if (isXiaomiMiMo(provider)) {
					setProviderUsage(currentMonthUsage(provider.baseUrl));
				}
				// E6: no declared context window → resolve from models.dev
				// (cached, async; the ctx% indicator updates when it lands).
				if (!provider.contextWindow) {
					void resolveContextWindow(preferredModel).then(window => {
						if (window && window > 0) {
							setActiveEndpoint(prev => ({...prev, contextWindow: window}));
						}
					});
				}
				if (provider.modelDiscoveryUrl) {
					void discoverModels(provider).then(models => {
						if (models.length > 0) {
							setActiveEndpoint(prev => ({...prev, models}));
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
				listProviders()
					.filter(provider => provider.id !== activeEndpoint().id)
					.map(provider => ({
						id: provider.id,
						baseUrl: provider.baseUrl,
						apiKey: provider.apiKeyResolved,
						model: provider.models[0] ?? 'mock-model-1',
						sdkProvider: provider.sdkProvider,
						providerOptions: provider.providerOptions,
						promptCacheKey: provider.promptCacheKey,
					})),
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
		autoCompactRef.enabled = settings.autoCompact.enabled;
		autoCompactRef.threshold = settings.autoCompact.threshold;
		watchdogMsRef = settings.watchdogMs ?? 0;
		streamGuardRef = settings.streamGuard ?? {};
		scrubberRef = createScrubber(settings.privacy?.patterns ?? []);
		steeringRef = loadSteeringConfig();
	}
	// A2: first-run trust gate. Only prompts when using the DEFAULT config dir
	//, isolated configs (parity runs, tests) are implicitly trusted.
	if (!process.env.NANOCODER_CONFIG_DIR) {
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
							trustedDirs: [
								...(loadSettings().trustedDirs ?? []),
								cwd,
							],
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
				() =>
					setStartupLoading(prev =>
						prev.filter(item => item.id !== id),
					),
				wait,
			);
		};
		try {
			for (const tool of loadCustomTools()) {
				registerTool(tool.name, {
					readOnly: tool.readOnly,
					execute: async () => {
						if (tool.command) {
							const result = await runBash(tool.command);
							return `${result.content}\n${tool.body.trim()}`;
						}
						return tool.body.trim();
					},
				});
			}
			finish('skills');
			for (const server of loadMCPConfig()) {
				try {
					const tools = await connectMCPServer(server);
					for (const tool of tools) {
						mcpToolsRef.push(tool);
						registerTool(tool.name, {
							readOnly: true,
							execute: args => tool.call(args),
						});
					}
					setMcpServers(prev =>
						prev.includes(server.id)
							? prev
							: [...prev, server.id],
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
			process.env.NANOCODER_DIAG_FIXTURE ??
			'Diagnostics: no issues found.',
	});
	setTimeout(() => void startupInit(), 0);

	const persist = () => {
		if (!currentSession) return;
		currentSession = {
			...currentSession,
			updatedAt: Date.now(),
			firstMessage: firstMessagePreview(messages()),
			messages: messages().filter(message => message.kind !== 'info'),
			context: context(),
		};
		saveSession(currentSession);
	};

	const exit = () => {
		persist();
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
		process.exit(0);
	};

	const clear = () => {
		abortRef?.abort();
		setInput('');
		setCompletionMessage('');
		setTasks([]);
		setSettingsOpen(false);
		setStatusOpen(false);
		setModelOpen(false);
		setModelModalInherit(false);
		clearMessages();
		startNewSession();
		persist();
	};

	const startNewSession = (resumeRef?: string) => {
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
			setMessages(resumed.messages);
			setContext(resumed.context);
			setSessionId(resumed.id);
			setSessionName(resumed.name);
			setUsageHistory([]);
			currentSession = {...resumed};
			appendInfo(`Resumed session ${resumed.id} (${resumed.name}).`);
			return;
		}
		const id = newSessionId();
		currentSession = {
			id,
			name: 'New conversation',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			firstMessage: '',
			// Record the folder the conversation was created in so /resume can
			// filter to the current cwd by default.
			cwd: process.cwd(),
			messages: [],
			context: [],
		};
		setSessionId(id);
		setSessionName('New conversation');
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
		const openSettingsList = (
			title: string,
			rows: SettingsListRow[],
		) => {
			setSettingsList({title, rows});
		};
		switch (row.key) {
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
			default:
				if (row.key.startsWith('provider:')) {
					openSettingsList(
						row.label,
						listProviders()
							.filter(provider => provider.id === row.key.slice(9))
							.map(provider => ({
								label: provider.id,
								value: provider.baseUrl,
							})),
					);
					return;
				}
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
			statusOpen() ||
			modelOpen() ||
			agentsOpen() ||
			detailsOpen() ||
			resumeOpen()
		) {
			// All modal keys (tabs/rows/search/Enter/Esc) are owned by the
			// modal's own useKeyboard, nothing may leak to the app outside.
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
				exitConfirmTimer = setTimeout(
					() => setExitConfirm(false),
					6000,
				);
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
				exitConfirmTimer = setTimeout(
					() => setExitConfirm(false),
					6000,
				);
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
		if (pendingQueue().length === 0) return;
		const next = pendingQueue()[0]!;
		setPendingQueue(prev => prev.slice(1));
		void submit(next.value, next.attachments);
	};

	/** B16: one confirmation per call; the input row resolves y/n. */
	const approvalGate = (name: string, detail: string): Promise<boolean> =>
		new Promise(resolve => {
			// B16: non-interactive stdin (piped/CI) auto-DECLINES mutations.
			if (process.env.NANOCODER_NONINTERACTIVE) {
				resolve(false);
				return;
			}
			setPendingApproval({name, detail, resolve});
		});

	const refreshContextPercent = () => {
		const allText = context().reduce(
			(total, message) => total + (message.content ?? ''),
			'',
		);
		const tokens = estimateTokens(allText, activeEndpoint().model);
		const window = activeEndpoint().contextWindow;
		setContextPercent(
			window > 0 ? Math.min(100, Math.round((tokens / window) * 100)) : 0,
		);
	};

	/** B11: LLM auto-compact when ctx% crosses the threshold (codex-style). */
	const triggerAutoCompact = () => {
		// The LLM compaction is a separate summarization request; it runs in
		// the background AFTER the current turn settles (busy flips false in
		// the turn's finally block) and the next prompt AUTO-RESUMES from the
		// short summary, the compaction never interrupts the conversation.
		setTimeout(() => void compact(), 0);
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
					.map(arg => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
					.join(' ')}`,
			);
			return;
		}
		const values: Record<string, string> = {};
		spec.forEach((arg, index) => {
			values[arg.name] = tokens[index] ?? '';
		});
		const prompt = substituteTemplateVariables(command.body, values).trim();
		if (!prompt) {
			appendInfo(`Custom command /${name} has an empty prompt.`);
			return;
		}
		void submit(prompt);
	};

	/** B15: consecutive identical noop traces collapse into one `×N` row. */
	const appendNoopRow = (row: string) => {
		const current = messages();
		for (let i = current.length - 1; i >= 0; i--) {
			const message = current[i]!;
			if (message.kind === 'info' && message.content.startsWith('InnerDaemon')) {
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
			appendInfo(`Tool profile: ${toolProfile()}\nAvailable: ${PROFILES.join(', ')}`);
			return;
		}
		if (!PROFILES.includes(name as ToolProfile)) {
			appendInfo(`Unknown profile '${name}'. Available: ${PROFILES.join(', ')}`);
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
		const tabBar = `Settings [${TABS.map(tab => tab === current ? `*${tab}*` : tab).join(' | ')}]`;
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
						`Set a value: /settings set <mode|profile|maxMessages|autoCompactThreshold> <value>`,
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
			case 'autoCompactThreshold': {
				const num = Math.max(50, Math.min(95, Number(value)));
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
					appendInfo(`Invalid title shape '${value}'. Available: powerline-angled, tiny, none`);
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
			default:
				appendInfo(
					`Unknown setting '${key}'. Available: mode, profile, maxMessages, autoCompactThreshold, theme, watchdog, streamGuard, titleShape, statusLine`,
				);
		}
	};

	const setupProviders = async (args: string) => {
		if (busy()) {
			appendInfo('Cannot run the wizard while a turn is running.');
			return;
		}
		const [action, idArg] = args.trim().split(/\s+/);
		const ask = (question: string) =>
			new Promise<string>(resolve =>
				// Esc cancels the wizard step with an empty value instead of
				// leaving the promise dangling forever.
				setPendingPrompt({
					question,
					resolve,
					onCancel: () => resolve(''),
				}),
			);
		if (action === 'delete' && idArg) {
			const config = loadConfig();
			config.providers = config.providers.filter(
				provider => provider.id.toLowerCase() !== idArg.toLowerCase(),
			);
			saveConfig(config);
			appendInfo(`Provider '${idArg}' deleted.`);
			return;
		}
		if (action === 'edit' && idArg) {
			// F8: guided edit form, values are prefilled by showing the
			// current value in the question; an empty answer keeps it.
			const existing = listProviders().find(
				provider => provider.id.toLowerCase() === idArg.toLowerCase(),
			);
			const id = existing?.id ?? idArg;
			const baseUrl =
				(await ask(`Base URL (current: ${existing?.baseUrl ?? '-'})`)) ||
				existing?.baseUrl;
			if (!baseUrl) {
				appendInfo('Edit cancelled.');
				return;
			}
			const apiKey = await ask(
				`API key (current: ${existing?.apiKeyResolved ? 'set' : '-'})`,
			);
			const modelsRaw = await ask(
				`Models, comma-separated (current: ${existing?.models.join(',') ?? '-'})`,
			);
			const config = loadConfig();
			config.providers = config.providers.filter(
				provider => provider.id.toLowerCase() !== id.toLowerCase(),
			);
			config.providers.push({
				id,
				baseUrl,
				...(apiKey ? {apiKey} : existing?.apiKey ? {apiKey: existing.apiKey} : {}),
				models: modelsRaw
					? modelsRaw.split(',').map(model => model.trim()).filter(Boolean)
					: existing?.models ?? [],
			});
			saveConfig(config);
			appendInfo(`Provider '${id}' updated.`);
			return;
		}
		const id = await ask('Provider id');
		if (!id) {
			appendInfo('Setup cancelled.');
			return;
		}
		const baseUrl = await ask('Base URL');
		const apiKey = await ask('API key (or env:VAR)');
		const modelsRaw = await ask('Models (comma-separated)');
		const config = loadConfig();
		config.providers = config.providers.filter(
			provider => provider.id.toLowerCase() !== id.toLowerCase(),
		);
		config.providers.push({
			id,
			baseUrl,
			...(apiKey ? {apiKey} : {}),
			models: modelsRaw
				.split(',')
				.map(model => model.trim())
				.filter(Boolean),
		});
		saveConfig(config);
		appendInfo(
			`Provider '${id}' saved. /providers to list, /model to switch.`,
		);
	};

	/** `/codex` — scaffold the Codex (OpenAI) provider smoothly (one key). */
	const connectCodex = async () => {
		if (busy()) {
			appendInfo('Cannot connect while a turn is running.');
			return;
		}
		const existing = listProviders().find(
			provider => provider.id.toLowerCase() === 'codex',
		);
		if (existing) {
			appendInfo(
				`Codex is already connected (${existing.baseUrl}). Edit via /setup-providers edit codex.`,
			);
			return;
		}
		const ask = (question: string) =>
			new Promise<string>(resolve =>
				setPendingPrompt({
					question,
					resolve,
					onCancel: () => resolve(''),
				}),
			);
		const apiKey = (await ask(
			'Codex API key (sk-... or env:VAR)',
		)).trim();
		if (!apiKey) {
			appendInfo('Codex connect cancelled.');
			return;
		}
		const baseUrl = 'https://api.openai.com/v1';
		const config = loadConfig();
		config.providers = config.providers.filter(
			provider => provider.id.toLowerCase() !== 'codex',
		);
		config.providers.push({
			id: 'codex',
			name: 'Codex',
			baseUrl,
			apiKey,
			// Live model discovery keeps the Codex catalog up to date.
			modelDiscoveryUrl: `${baseUrl.replace(/\/+$/, '')}/models`,
			contextWindow: 400_000,
			models: [
				'gpt-5.5-codex',
				'gpt-5.5-codex-high',
				'gpt-5.4-codex',
				'gpt-5.4-codex-mini',
			],
		});
		saveConfig(config);
		showToast('Codex provider connected');
		appendInfo(
			'Codex provider saved. Switch to it with /model or /provider codex.',
		);
	};
	/** `/connect` — smooth provider-connect flow (Codex or custom wizard). */
	const connectProvider = async (args: string) => {
		if (busy()) {
			appendInfo('Cannot connect while a turn is running.');
			return;
		}
		const name = args.trim().toLowerCase();
		if (name === 'codex') {
			await connectCodex();
			return;
		}
		if (name) {
			await setupProviders(args.trim());
			return;
		}
		const ask = (question: string) =>
			new Promise<string>(resolve =>
				setPendingPrompt({
					question,
					resolve,
					onCancel: () => resolve(''),
				}),
			);
		const choice = (
			await ask('Connect provider: codex (OpenAI) or custom?')
		).trim().toLowerCase();
		if (choice === 'codex' || choice === 'c') {
			await connectCodex();
			return;
		}
		await setupProviders('');
	};

	const submit = async (
		value: string,
		attachments?: Record<string, string>,
	) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		// Vision fallback (Settings → Capabilities → Vision model): when the
		// prompt carries `[Image #N]` attachments and a vision model is
		// configured, analyze each image through THAT model and hand the
		// description to the main (possibly text-only) agent, with a chat
		// indicator mirroring the web-search fallback line.
		let prompt = trimmed;
		const imageTokens = [...trimmed.matchAll(/\[Image #(\d+)\]/g)];
		const visionFallback = resolveVisionFallback();
		if (imageTokens.length > 0 && visionFallback && attachments) {
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
							error instanceof Error
								? error.message
								: String(error)
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
			const result = await runBash(command);
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
			runCommand(prompt, {
				exit,
				clear,
				compact,
				submitPrompt: prompt => {
					// /mock:confirm previews the LIVE approval box, approval
					// only prompts in `normal` mode, so switch first.
					if (prompt === 'confirm' && mode() !== 'normal') {
						setMode('normal');
						saveSettings({...loadSettings(), mode: 'normal'});
						appendInfo('Switched to normal mode for the confirmation preview.');
					}
					void submit(prompt);
				},
				retry: retryLast,
				resume: resumeSession,
				rename,
				usage,
				sessions: listSessionsInfo,
				openPRs,
				status,
				model: switchModel,
				providers: listProvidersInfo,
				custom: runCustomCommand,
				modeSwitch,
				settings: settingsSurface,
				setupProviders,
				connectCodex,
				connectProvider,
				providerSwitch: switchProvider,
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
			});
			return;
		}

		// Chat while busy → queued (submitted when the turn settles).
		// CACHE HEAD GATE: never fire the first LLM request while lazy
		// MCP/custom-tool loading is still registering tools (the catalog is
		// the cache head; a mid-session tool arrival would change the prefix
		// and miss the provider's prompt cache for every later turn).
		if (!startupReadyRef) {
			setInput('');
			appendInfo('Still loading tools (MCP/skills)… try again in a moment.');
			return;
		}
		if (busy()) {
			setPendingQueue(prev => [
				...prev,
				{value, attachments},
			]);
			// The queued message renders as a persistent block above the
			// input (parity: nanocoder's queuedBlock), NOT a transcript row
			// that scrolls away.
			setInput('');
			return;
		}

		// The transcript shows the ORIGINAL user text; the provider sees the
		// prompt with vision-description blocks substituted for [Image #N].
		await runTurn(value, prompt, attachments);
		processQueue();
	};

	const runTurn = async (
		value: string,
		providerValue: string = value,
		attachments?: Record<string, string>,
	) => {
		// Snapshot for `/retry` BEFORE the user message lands.
		setRetrySnapshot({
			messages: [...messages()],
			context: [...context()],
			prompt: value,
		});
		setPromptHistory(prev =>
			prev[prev.length - 1] === value
				? prev
				: [...prev.slice(-99), value],
		);
		setHistoryIndex(-1);

		// B22: the transcript shows the original; the provider sees scrubbed
		// text (placeholders are rehydrated in replies).
		appendMessage({
			role: 'user',
			content: value,
			...(attachments && Object.keys(attachments).length > 0
				? {attachments}
				: {}),
		});
		const userMsg = {
			role: 'user' as const,
			content: scrubberRef.scrub(providerValue),
		};
		setInput('');
		setBusy(true);
		setStreaming('');
		setCompletionMessage('');
		setReasoning('');
		setRunning(true);
		setTurnElapsed(0);
		thinkingStartedAt = 0;
		setThinkingElapsed(0);
		const turnTimer = setInterval(
			() => {
				setTurnElapsed(prev => prev + 1);
				setThinkingElapsed(
					thinkingStartedAt > 0
						? Math.max(
								0,
								Math.floor((Date.now() - thinkingStartedAt) / 1000),
							)
						: 0,
				);
			},
			1000,
		);
		const controller = new AbortController();
		abortRef = controller;
		const startedAt = Date.now();

		let history: ChatMessageLike[] = [...context(), userMsg];
		// F4: subscribe blocks auto-trigger, a custom command whose
		// `subscribe:` keywords match the prompt injects its body.
		for (const command of loadCustomCommands()) {
			if (
				command.subscribe?.some(keyword =>
					value.toLowerCase().includes(keyword.toLowerCase()),
				)
			) {
				history = [
					...history,
					{role: 'user', content: command.body.trim()},
				];
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
				appendInfo(`Auto-triggered skill ${skill.name} (subscribe).`);
			}
		}
		history = capMessages(history, maxMessages());
		let emptyTurnCount = 0;
		let lastToolSignature: string | null = null;
		let repeatedToolCount = 0;
		let malformedRetryCount = 0;
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
				totalBudget: MAX_TURN_ROUNDS,
				backgroundTasksRunning: activeBgCount() > 0,
			});
			const steering = evaluateSteering(value, steeringRef, turnFacts());
			if (steering) {
				const {rule, intent} = steering;
				const facts = {...turnFacts(), intent};
				if (rule.action === 'block') {
					appendInfo(formatInnerDaemonRow(rule.id, 'block', facts));
					appendInfo(
						rule.message ?? `Blocked by steering rule ${rule.id}.`,
					);
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
			for (let round = 0; round < MAX_TURN_ROUNDS; round++) {
				// Settled `⚙ Thought (Ns)` reports the THINKING phase length
				// (since reasoning first streamed), not the whole turn.
				const thoughtDuration = (): number =>
					thinkingSeconds(
						thinkingStartedAt > 0 ? thinkingStartedAt : startedAt,
						Date.now(),
					);
				let result = await streamChat(
					history,
					{
						onText: delta => setStreaming(prev => prev + delta),
						onReasoning: delta => {
							// Anchor the thinking timer on the FIRST reasoning
							// chunk of this phase (reasoning() is reset at the
							// end of every round).
							if (delta && !reasoning()) {
								thinkingStartedAt = Date.now();
							}
							setReasoning(prev => prev + delta);
						},
					},
					controller.signal,
					listTools().map(name => ({name})),
					streamGuardRef,
					toolProfile(),
				);

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
							reasoning:
								result.reasoning.trim() || undefined,
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
						appendAssistantMessage(scrubberRef.rehydrate(result.text), {
							reasoning: result.reasoning.trim() || undefined,
							durationSec: thoughtDuration(),
						});
						const completionUsage = usageSignal(result.usage);
						const cacheLabel = formatCacheHitLabel(cacheStats(result.usage));
						// Static completion line ABOVE the input (diamond glyph,
						// secondary), not a transcript row. Expires after a
						// few seconds like the exit confirmation.
						setCompletionMessage(
							`✦ Worked for a ${getRandomAdjective()} ${formatElapsedTime(startedAt)}.` +
								(completionUsage?.total_tokens
									? ` · ${completionUsage.total_tokens} tokens`
									: '') +
								(cacheLabel ? ` · ${cacheLabel}` : ''),
						);
						capturePRs(result.text);
						// Keep the LOCAL history (what the provider saw) in
						// sync, the post-loop `setContext(history)` below is
						// the single source of truth for the saved session,
						// so a resumed conversation re-sends the EXACT same
						// prefix and keeps the provider's prompt cache.
						history = [
							...history,
							{role: 'assistant', content: result.text},
						];
						setContext(history);
						refreshContextPercent();
						recordUsage(result.usage);
						if (
							autoCompactRef.enabled &&
							contextPercent() >= autoCompactRef.threshold
						) {
							triggerAutoCompact();
						}
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

				// B14: repeated identical tool signature across turns → loop guard.
				const signature = result.toolCalls
					.map(call => `${call.name}:${JSON.stringify(call.arguments)}`)
					.join('|');
				const allMonitor = result.toolCalls.every(call => call.name === 'monitor');
				if (allMonitor) {
					repeatedToolCount = 0;
				} else if (signature === lastToolSignature) {
					repeatedToolCount += 1;
					if (repeatedToolCount >= MAX_REPEATED_TOOL_CALLS) {
						appendError(
							`Repeated tool call detected (${repeatedToolCount}× identical calls), stopping the loop.`,
						);
						break;
					}
				} else {
					lastToolSignature = signature;
					repeatedToolCount = 1;
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
				const toolResults: Array<{
					tool_call_id: string;
					content: string;
				}> = [];
				// B8: single-tool profiles truncate to one call per turn.
				const calls = isSingleToolProfile(toolProfile(), activeEndpoint().model)
					? result.toolCalls.slice(0, 1)
					: result.toolCalls;
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
						!evaluateToolConstraint(
							call.name,
							steeringRef,
							{
								intent: classifyIntent(value),
								model: activeEndpoint().model,
								budgetTurns: round,
								totalBudget: MAX_TURN_ROUNDS,
								backgroundTasksRunning: activeBgCount() > 0,
							},
						)
					);
				});
				// B9/C6: pre-append every running row for the read-only
				// PARALLEL batch so the compact tally streams LIVE instead of
				// appearing only after the whole batch settles.
				const batchStartedAt = Date.now();
				// A7/C9: live task progress, first pending task shows running.
				setTasks(prev =>
					prev.map((task, index) =>
						index === 0 && !task.done
							? {...task, running: true}
							: task,
					),
				);
				if (allReadOnly) {
					for (const call of calls) {
						const detail = toolDisplayDetail(call);
						appendMessage({
							role: 'tool',
							content: `✦ ${displayToolName(call.name)}${detail ? `(${detail})` : ''}`,
							running: true,
							toolId: call.id,
							tool: {name: call.name, detail, output: '', args: call.arguments},
						});
					}
				}
				const parallelResults = allReadOnly
					? await Promise.all(
							calls.map(call =>
								executeTool(call, {
									onProgress: content =>
										setLiveOutputs(prev => ({
											...prev,
											[call.id]: content,
										})),
								}),
							),
						)
					: null;
				for (const [index, call] of calls.entries()) {
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
							totalBudget: MAX_TURN_ROUNDS,
							backgroundTasksRunning: activeBgCount() > 0,
						},
					);
					if (toolConstraint) {
						const reason =
							`Blocked by steering rule ${toolConstraint.rule.id}: ` +
							`${toolConstraint.rule.message ?? 'constraint'}`;
						appendInfo(
							formatInnerDaemonRow(
								toolConstraint.rule.id,
								'block',
								{
									intent: toolConstraint.intent,
									model: activeEndpoint().model,
									budgetTurns: round,
									totalBudget: MAX_TURN_ROUNDS,
									backgroundTasksRunning: activeBgCount() > 0,
								},
							),
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
					const toolResult = parallelResults?.[index] ??
						(await executeTool(call, {
							onProgress: content =>
								setLiveOutputs(prev => ({...prev, [call.id]: content})),
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
					setMessages(prev =>
						prev.map(message =>
							message.toolId === call.id
								? {
										...message,
										running: false,
										tool: {...message.tool!, output: toolResult.content},
										toolStats: {
											durationSec: Math.max(
												0,
												Math.round((Date.now() - callStartedAt) / 1000),
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
				}
				// C9: this tool turn is done, mark the active task complete.
				setTasks(prev =>
					prev.map(task =>
						task.running ? {...task, running: false, done: true} : task,
					),
				);

				const assistantToolMsg: ChatMessageLike = {
					role: 'assistant',
					content: result.text,
					tool_calls: result.toolCalls.map((call: MockToolCall) => ({
						id: call.id,
						name: call.name,
						arguments: call.rawArguments,
					})),
				};
				history = [...history, assistantToolMsg, ...toolMessages];
				refreshContextPercent();
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
			// Completion line also shows after TOOL-only turns (the loop can
			// end on tools with no final text round, the text branch above
			// already set it; this covers the other path).
			if (!completionMessage()) {
				setCompletionMessage(
					`✦ Worked for a ${getRandomAdjective()} ${formatElapsedTime(startedAt)}.` +
						(formatCacheHitLabel(cacheStats(lastUsage())) ?? ''),
				);
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				// ESC interrupt: commit the partial stream (B20). `/clear`
				// aborts without the flag and leaves the wiped state.
				if (watchdogRef) {
					// B5: the within-turn watchdog aborted, surface the
					// InnerDaemon audit row and commit the partial.
					watchdogRef = false;
					const partial = streaming();
					if (partial.trim()) {
						appendAssistantMessage(partial);
						setContext([
							...context(),
							{role: 'assistant', content: partial},
						]);
					}
					appendInfo('Interrupted by watchdog.');
					appendInfo(
						formatInnerDaemonRow('watchdog', 'timeout', {
							intent: classifyIntent(value),
							model: activeEndpoint().model,
							budgetTurns: 0,
							totalBudget: MAX_TURN_ROUNDS,
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
								thinkingStartedAt > 0
									? thinkingStartedAt
									: startedAt,
								Date.now(),
							),
						});
						setContext([
							...context(),
							{role: 'assistant', content: partial},
						]);
						refreshContextPercent();
					}
					appendError('Interrupted by user.');
				}
				return;
			}
			appendError(error instanceof Error ? error.message : String(error));
		} finally {
			clearInterval(turnTimer);
			if (watchdogTimer) clearTimeout(watchdogTimer);
			setCancelling(false);
			setRunning(false);
			setBusy(false);
			setStreaming('');
			setReasoning('');
			thinkingStartedAt = 0;
			setThinkingElapsed(0);
			persist();
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
		// Token-plan providers (Xiaomi MiMo, DeepSeek): accumulate the turn's
		// usage into the per-provider MONTHLY ledger (`used N.NM` on the
		// status line). The disk-backed ledger survives restarts, unlike the
		// session-scoped history above.
		if (isXiaomiMiMo(activeEndpoint()) || isDeepSeek(activeEndpoint())) {
			const updated = recordProviderUsage(activeEndpoint().baseUrl, snapshot);
			if (updated) setProviderUsage(updated);
		}
		// DeepSeek prompt-cache alert: an unusually cache-miss-heavy turn is
		// exactly what drives the cost up. Toast (transient) — never a chat
		// history row, same policy as setting changes.
		if (isDeepSeek(activeEndpoint())) {
			const stats = cacheStats(usage);
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
	): Promise<string> => {
		let summary = '';
		let attempt = ctx.filter(message => message.role !== 'system');
		for (;;) {
			try {
				await streamChat(
					[
						{role: 'system', content: SUMMARIZATION_PROMPT},
						...attempt,
					],
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
				);
				break;
			} catch (error) {
				// Context-window overflow while summarizing: drop the OLDEST
				// history item and retry (codex trims from the beginning to
				// preserve the cache head). Anything else fails compaction.
				const message =
					error instanceof Error ? error.message : String(error);
				if (!isCompactOverflowError(error) || attempt.length <= 1) {
					throw error;
				}
				attempt = attempt.slice(1);
				summary = '';
				if (process.env.NODE_ENV !== 'test') {
					appendInfo(
						`Compaction request overflowed the window, trimming oldest message: ${message}`,
					);
				}
			}
		}
		return summary.trim();
	};

	const compact = async () => {
		if (busy()) {
			appendInfo('Cannot compact while a turn is running.');
			return;
		}
		const ctx = context();
		if (ctx.length <= 6) {
			appendInfo('Context is already compact (fewer than 7 messages).');
			return;
		}
		appendInfo('Compacting context (LLM summary)…');
		let summary: string;
		try {
			summary = await summarizeContext(ctx);
		} catch (error) {
			appendError(
				`Compaction failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return;
		}
		if (!summary) {
			appendError('Compaction failed: the model returned an empty summary.');
			return;
		}
		// Keep the recent USER prompts under a token budget (newest first,
		// oldest truncated to fit — codex `collect_user_messages` +
		// `build_compacted_history_with_limit`), then place the summary LAST
		// so it sits directly above the next user message (codex ordering).
		// The client prepends the system prompt on EVERY request, so the
		// compacted history must NOT carry a system message — a duplicate
		// head would change the cache prefix and persist into saved sessions.
		const userPrompts = collectCompactedUserMessages(ctx);
		const compacted: ChatMessageLike[] = [
			...userPrompts,
			{role: 'user', content: `${SUMMARY_PREFIX}\n${summary}`},
		];
		setContext(compacted);
		const reduction = Math.round(
			((ctx.length - compacted.length) / ctx.length) * 100,
		);
		appendInfo(
			`Context compacted via LLM summary (${reduction}% reduction, ` +
				`${summary.split('\n').length} line summary).`,
		);
		refreshContextPercent();
		persist();
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

	const resumeSession = (ref?: string) => {
		if (busy()) {
			appendInfo('Cannot resume while a turn is running.');
			return;
		}
		if (!ref) {
			setResumeOpen(true);
			return;
		}
		abortRef?.abort();
		clearMessages();
		startNewSession(ref);
		persist();
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
		appendInfo(`Restored checkpoint "${data.name}" (${data.messages.length} messages).`);
	};

	// F2: catalog breadth, display-only info commands.
	// `/commands` opens the SAME list modal the settings row uses: selecting
	// a command inserts it into the input box and closes the modal (parity:
	// the reference command palette) instead of printing to the transcript.
	const commandsList = () => {
		const rows: SettingsListRow[] = [
			...Object.keys(COMMAND_DESCRIPTIONS)
				.filter(name => name !== 'quit')
				.sort()
				.map(name => ({
					label: `/${name}`,
					value: COMMAND_DESCRIPTIONS[name],
					insert: `/${name} `,
				})),
			...loadCustomCommands().map(command => ({
				label: `/${command.name}`,
				value: command.description,
				insert: `/${command.name} `,
			})),
		];
		openSettingsList('Commands', rows);
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
						value: task.done
							? 'done'
							: task.running
								? 'running'
								: 'pending',
					})),
		);
	};
	const versionInfo = () =>
		openInfoModal('Version', `bobonyo ${VERSION} · OpenTUI rewrite`);
	const credits = () =>
		openInfoModal(
			'Credits',
			'bobonyo, a NanoCollective OpenTUI rewrite of nanocoder.\n' +
				'Reference: Nano-Collective/nanocoder (MIT).',
		);
	const doctor = () =>
		openInfoModal(
			'Doctor',
			`Doctor\n` +
				`  └ config dir: ${configDir()}\n` +
				`  └ providers: ${listProviders().length}\n` +
				`  └ tools registered: ${listTools().length}\n` +
				`  └ mcp servers: ${loadMCPConfig().length}\n` +
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
		writeFileSync(file, `${JSON.stringify({id: sessionId(), messages: messages()}, null, 2)}\n`);
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

	const usage = () => {
		const history = usageHistory();
		const current = lastUsage();
		if (history.length === 0 && !current) {
			const monthly = currentMonthUsage(activeEndpoint().baseUrl);
			appendInfo(
				monthly
					? `This month: ${formatTokens(monthly.totalTokens)} tokens total · ` +
							`${formatTokens(monthly.promptTokens)} prompt · ` +
							`${formatTokens(monthly.completionTokens)} completion · ` +
							`${formatTokens(monthly.cachedTokens)} cached`
					: 'No token usage recorded yet.',
			);
			return;
		}
		const monthly = currentMonthUsage(activeEndpoint().baseUrl);
		appendInfo(
			(monthly
				? `This month: ${formatTokens(monthly.totalTokens)} tokens total · ` +
					`${formatTokens(monthly.promptTokens)} prompt · ` +
					`${formatTokens(monthly.completionTokens)} completion · ` +
					`${formatTokens(monthly.cachedTokens)} cached\n\n`
				: '') +
				`Usage history:\n` +
				history
					.map(
						(snapshot, index) =>
							`  └ call ${index + 1} · ${snapshot.provider}/${snapshot.model}: ` +
							`prompt ${snapshot.prompt_tokens ?? '?'} · ` +
							`completion ${snapshot.completion_tokens ?? '?'} · ` +
							`total ${snapshot.total_tokens ?? '?'}` +
							(snapshot.promptCacheHitTokens !== undefined
								? ` · cache ${snapshot.promptCacheHitTokens}h/${snapshot.promptCacheMissTokens ?? 0}m`
								: ''),
					)
					.join('\n'),
		);
	};

	const status = () => {
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
		if (isXiaomiMiMo(endpoint)) {
			setProviderUsage(currentMonthUsage(endpoint.baseUrl));
		}
		const cacheLabel =
			isDeepSeek(endpoint) && cacheStats(lastUsage())
				? `deepseek · ${formatCacheHitLabel(cacheStats(lastUsage()))}`
				: 'n/a';
		// `/status` opens as a MODAL (parity: settings) listing only the
		// details NOT already visible on the status line (mode, tune, agents,
		// bg, cwd) or the input corner (model[effort], ctx ~N%).
		setStatusRows(
			buildStatusRows({
				sessionLabel: `${sessionName()} (${sessionId()})`,
				provider: endpoint.id,
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
					(detectLanguageServers().join(', ') ||
						'no language servers detected') +
					(diagnosticsCount() > 0
						? ` · ${diagnosticsCount()} issue${
								diagnosticsCount() === 1 ? '' : 's'
							}`
						: ''),
				// Exactly the file embedded in the system prompt (nearest
				// AGENTS.md walking up from the cwd), so the user always
				// knows which rules the model is running under.
				rulesFile: resolveRulesFile(process.cwd()) ?? 'none',
				steeringLabel: steeringRef.enabled
					? `enabled · ${steeringRef.rules.length} rules`
					: 'disabled',
				watchdogLabel: watchdogMsRef > 0 ? `${watchdogMsRef}ms` : 'off',
				streamGuardLabel: streamGuardRef.maxDurationMs
					? `${streamGuardRef.maxDurationMs}ms`
					: 'off',
				version: `bobonyo ${VERSION}`,
			}),
		);
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
		showToast(`Model: ${name} · ${endpoint.id}`);
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
			models: discoveredModels()[provider.id] ?? provider.models,
			modelEfforts: provider.modelEfforts,
			contextWindow: provider.contextWindow,
		}));

	/**
	 * Refresh every live-discoverable catalog (DeepSeek + Xiaomi MiMo,
	 * deduped + TTL-cached through the shared disk cache).
	 */
	const refreshModelCatalogs = () => {
		for (const provider of listProviders()) {
			const refresh = isDeepSeek(provider)
				? refreshDeepSeekModels(provider)
				: isXiaomiMiMo(provider) && provider.modelDiscoveryUrl
					? refreshProviderModels(provider, provider.modelDiscoveryUrl)
					: undefined;
			if (!refresh) continue;
			void refresh.then(models => {
				if (models.length > 0) {
					setDiscoveredModels(prev => ({...prev, [provider.id]: models}));
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
				showToast(
					`Web-search fallback: ${model} · ${providerId}`,
				);
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
			contextWindow: provider.contextWindow ?? 128_000,
			sdkProvider: provider.sdkProvider,
			providerOptions: provider.providerOptions,
			// The modal's ←/→ effort override wins; otherwise the model's
			// configured catalog effort applies.
			effort: effort ?? provider.modelEfforts[model],
			promptCacheKey: provider.promptCacheKey,
			alwaysAllow: provider.alwaysAllow,
		});
		savePreferences({lastProvider: provider.id, lastModel: model});
		// The status-line `used` segment follows the ACTIVE provider: seed it
		// from the MiMo ledger on switch (or clear it when leaving MiMo).
		setProviderUsage(
			isXiaomiMiMo(provider) ? currentMonthUsage(provider.baseUrl) : undefined,
		);
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

	const switchProvider = (args: string) => {
		const id = args.trim();
		const providers = listProviders();
		if (!id) {
			appendInfo(
				`Providers:\n` +
					providers
						.map(
							provider =>
								`  └ ${provider.id}${provider.id === activeEndpoint().id ? ' (active)' : ''}`,
						)
						.join('\n'),
			);
			return;
		}
		const provider = providers.find(
			candidate => candidate.id.toLowerCase() === id.toLowerCase(),
		);
		if (!provider) {
			appendInfo(
				`Provider '${id}' not found. Available: ${providers
					.map(candidate => candidate.id)
					.join(', ')}`,
			);
			return;
		}
		const model = provider.models[0] ?? 'mock-model-1';
		setActiveEndpoint({
			id: provider.id,
			name: provider.name ?? provider.id,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKeyResolved,
			model,
			models: provider.models,
			modelEfforts: provider.modelEfforts,
			contextWindow: provider.contextWindow ?? 128_000,
			sdkProvider: provider.sdkProvider,
			providerOptions: provider.providerOptions,
			effort: (provider.modelEfforts ?? {})[model],
			promptCacheKey: provider.promptCacheKey,
			alwaysAllow: provider.alwaysAllow,
		});
		savePreferences({lastProvider: provider.id, lastModel: model});
		showToast(`Provider: ${provider.id} · ${model}`);
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
			tasks().length,
			Boolean(pendingPrompt()),
			Boolean(pendingApproval()),
			cancelling(),
		),
	);
	// Reactive: the App body runs once, so a plain const would freeze the
	// height at mount and a growing history/panel would push the input box
	// and status line off the visible pane. The memo re-derives on every
	// signal read below (terminal resize, busy, settings panel, …).
	const historyHeight = createMemo(() =>
		// The input box and status line stay visible even while a modal is
		// open (the modal overlays ONLY the history region).
		Math.max(
			4,
				terminalHeight() -
				inputBoxRows() -
				2 -
				(running() ? 1 : 0) -
				startupLoading().length -
				(completionMessage() ? 1 : 0) -
				(exitConfirm() ? 1 : 0) -
				(pendingQueue().length > 0 ? pendingQueue().length + 1 : 0) -
				completionPopupHeight(input(), terminalDimensions().width) -
				mentionPopupHeight(input()),
		),
	);
	return (
		// Parity: nanocoder's root carries one column of padding; the input
		// box adds its own so the border sits at column 2.
		// Parity: root carries one column of padding; the omnicode text color
		// (#c0caf5) is the default for the whole transcript.
		<box flexDirection="column" flexGrow={1} flexShrink={1} height="100%" paddingX={1}>
			<History height={historyHeight()} />
			{/* Bottom gap: the last response never sticks to the Working
			    indicator above the input. */}
			<box height={1} />
			{/* The input box and status line stay visible while a modal is
			    open, the modal only overlays the history region above. */}
			<InputBox
				onSubmit={(value, attachments) =>
					void submit(value, attachments)
				}
			/>
			{/* Status Line setting (on/off) toggles the footer. */}
			<Show when={statusLineEnabled()}>
				<Status />
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
							onModelSelect={(target) => {
								setSettingsOpen(false);
								setFallbackTarget(target === 'main' ? null : target);
								setModelModalInherit(true);
								refreshModelCatalogs();
								setModelOpen(true);
							}}
						/>
					}
				>
					{(list) => (
						<SettingsListModal
							title={list().title}
							rows={list().rows}
							onInsert={(text) => {
								setSettingsList(null);
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
				<StatusModal
					rows={statusRows()}
					onClose={() => setStatusOpen(false)}
				/>
			</Show>
			{/* `/model` opens as a MODAL (parity: nanocoder's model selector). */}
			<Show when={modelOpen()}>
				<ModelModal
					providers={catalog()}
					currentProvider={activeEndpoint().id}
					currentModel={activeEndpoint().model}
					onSelect={selectModel}
					onConnectProvider={() => {
						// The provider wizard prompts from the input box, so
						// close the modal first; the newly saved provider is
						// picked up on the next /model (config is re-read).
						setModelOpen(false);
						void setupProviders('');
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
				<AgentsModal onClose={() => setAgentsOpen(false)} />
			</Show>
			{/* Compact-block details (clicking an expandable tool tally). */}
			<Show when={detailsOpen()}>
				<DetailsModal
					title={detailsTitle()}
					content={detailsContent()}
					onClose={() => setDetailsOpen(false)}
				/>
			</Show>
			{/* `/resume` opens as a MODAL (parity: the reference session picker). */}
			<Show when={resumeOpen()}>
				<ResumeModal
					cwd={process.cwd()}
					sessions={listSessions().map(session => ({
						id: session.id,
						name: session.name,
						createdAt: session.createdAt,
						updatedAt: session.updatedAt,
						firstMessage: session.firstMessage,
						cwd: session.cwd,
					}))}
					onResume={id => {
						setResumeOpen(false);
						resumeSession(id);
					}}
					onClose={() => setResumeOpen(false)}
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
							((terminalDimensions().width ?? 80) -
								toast().length) /
								2,
						),
					)}
					backgroundColor={colors().base}
					paddingX={2}
					paddingY={0}
					zIndex={4000}
				>
					<text fg={colors().primary} attributes={createTextAttributes({bold: true})}>
						{toast()}
					</text>
				</box>
			</Show>
		</box>
	);
}

function usageSignal(
	usage: Record<string, unknown> | undefined,
): {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	promptCacheHitTokens?: number;
	promptCacheMissTokens?: number;
} | undefined {
	if (!usage) return undefined;
	return {
		prompt_tokens: finiteNumber(usage.prompt_tokens),
		completion_tokens: finiteNumber(usage.completion_tokens),
		total_tokens: finiteNumber(usage.total_tokens),
		promptCacheHitTokens: finiteNumber(usage.prompt_cache_hit_tokens),
		promptCacheMissTokens: finiteNumber(usage.prompt_cache_miss_tokens),
	};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
export function collectCompactedUserMessages(
	ctx: ChatMessageLike[],
	maxTokens = COMPACT_USER_MESSAGE_MAX_TOKENS,
): ChatMessageLike[] {
	// Skip previous compaction summaries (parity: codex `is_summary_message`
	// in collect_user_messages) so a second compaction never re-summarizes an
	// old summary — only the real user prompts are candidates.
	const users = ctx.filter(
		message =>
			message.role === 'user' &&
			!message.content?.startsWith(`${SUMMARY_PREFIX}\n`),
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
 * Is this error a context-window overflow we can recover from during
 * compaction by trimming the oldest history item (parity: codex's
 * `ContextWindowExceeded` handling)? OpenAI-compatible providers report the
 * window breach as 400 ("context length exceeded") or 413 (payload too
 * large); anything else fails compaction immediately.
 */
export function isCompactOverflowError(error: unknown): boolean {
	return (
		error instanceof ProviderError &&
		(error.status === 400 || error.status === 413)
	);
}

const COMPLETION_ADJECTIVES = [
	'brisk', 'swift', 'breezy', 'thoughtful', 'steady', 'snappy', 'crisp',
	'diligent', 'nimble', 'spirited', 'keen', 'zippy', 'lively', 'focused',
	'peppy', 'resolute', 'deft', 'plucky', 'hearty', 'jaunty', 'sprightly',
	'tenacious', 'chipper',
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
function createScrubber(patterns: Array<{pattern: string; placeholder?: string}>) {
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
