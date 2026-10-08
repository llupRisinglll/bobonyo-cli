/**
 * Tool registry (parity: nanocoder's tool-registry contract, doc D1).
 * Tools register a handler (plus shared display metadata); `executeTool`
 * resolves by name, pairs results 1:1, and surfaces validation/execution
 * errors without crashing the loop.
 */

import {readFileSync, realpathSync, statSync, unlinkSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {
	streamChat,
	type ChatMessageLike,
	type MockToolCall,
	type ToolCatalogEntry,
} from './client';
import {normalizeBashCommand, runBash} from './bash';
import {
	commitMessagesFromCommand,
	gitCommitMessagesViolation,
	ghPrMessagesViolation,
} from './commit-guard';
import {
	buildCommandInvocationPrompt,
	expandCommandPrompt,
	lintBody,
	loadCustomCommands,
	loadSkills,
	parseCommandArguments,
} from './custom';
import {
	loadSubagents,
	subagentEndpoint,
	subagentSystemPrompt,
} from './subagents';
import {
	activeAgentRuns,
	activeEndpoint,
	appendInfo,
	appendMessage,
	setActiveAgents,
	setActiveAgentRuns,
	setTasks,
	tasks,
} from './state';
import {snapshotFileBeforeMutation, snapshotMutationTargets} from './file-undo';
import {createWorkGraph, recordWorkEvent, upsertWorkNode} from './work-graph';
import {appendMemory, clearMemory, forgetMemory} from './memory';
import {executeNativeWebSearch, resolveWebSearchFallback} from './web-search';
import {
	runBashPostHooks,
	runBashPreHooks,
	runHooks,
	withHookContext,
	hookSessionId,
} from './hooks';
import {loadSettings} from './settings';
import {autoApprovesTools} from './modes';
import {
	listMCPResources,
	listMCPResourceTemplates,
	readMCPResource,
} from './mcp';
import {projectRoot} from './project-paths';
import {
	changedReviewFiles,
	findReviewRoutingConfig,
	planReviewers,
	scopeReviewPaths,
	type ReviewRoutingPlan,
} from './review-routing';
import {logSubagentEvent} from './subagent-logs';
import {
	formatSubagentResults,
	loadSubagentResults,
	archiveSubagentResponse,
	subagentResultText,
} from './subagent-results';
import {
	boundedResearchText,
	findResearchMemory,
	researchMemoryKey,
	researchInputHash,
	saveResearchMemory,
} from './work-graph';
import {nextAgentDisplayLabel} from './agent-label';
import {pathInsideWorkspace} from './bash-removal-guard';
import {
	enterWorktree,
	exitWorktree,
	inspectWorktrees,
	removeWorktree,
} from './worktree-tools';
import {executeLspOperation} from './lsp-tool';
import {fetchPublicText} from './public-web-fetch';
import {validateToolArguments} from './tool-schema';
import {AGENT_TASK_DESCRIPTION, taskOwnershipError} from './task-ownership';
import {
	applyPatchDisplayChanges,
	applyPatchPaths,
	executeApplyPatch,
} from './apply-patch';
import {globWorkspace, grepWorkspace} from './search-tools';
import {inspectWorkspaceImage} from './vision';
import {
	persistentProcessStatus,
	reserveProcessStatusPoll,
	startPersistentProcess,
	stopPersistentProcess,
	writePersistentProcess,
} from './persistent-process';
import {
	checkManagedServiceSupervisor,
	managedServiceLogs,
	managedServiceStatus,
	restartManagedService,
	startManagedService,
	stopManagedService,
} from './managed-service';
import type {Mode, ToolProfile} from './settings';
import {contextTaskDisplayArgs, contextTasks} from './task-checklist-state';
import {registerTaskTools} from './task-tools';
import {normalizeTaskList} from './task-list-normalize';
export {normalizeTaskList} from './task-list-normalize';
import {
	displayToolName,
	isFileWriteTool,
	resolveToolName,
	toolArgsSummary,
	toolDisplayDetail,
	toolResultTail,
} from './tool-display-helpers';
export {
	displayToolName,
	isFileWriteTool,
	resolveToolName,
	toolArgsSummary,
	toolDisplayDetail,
	toolResultTail,
} from './tool-display-helpers';

export interface ToolResult {
	tool_call_id: string;
	content: string;
	/** Display-only arguments; never sent back to model. */
	displayArgs?: Record<string, unknown>;
}

export interface ToolContext {
	hookContextId?: string;
	hookSessionId?: string;
	/** Checklist owner. Omit only for the main conversation. */
	agentId?: string;
	/** Reject checklist writes from superseded agent attempts. */
	agentGeneration?: number;
	/** Current session id for session-scoped persistence. */
	sessionId?: string;
	/** Durable orchestration graph for this parent turn. */
	workGraphId?: string;
	/** Live output callback (bash streams lines as they arrive). */
	onProgress?: (content: string) => void;
	/** Parent tool-call id, used by fan-out tools for child rows. */
	toolCallId?: string;
	/** Abort signal: the turn's AbortController, so long-running tools
	 * (bash, MCP) can be killed when the user presses Esc. */
	signal?: AbortSignal;
	/** Workspace CWD used by shell tools. */
	cwd?: string;
	/** Stable sandbox boundary. Unlike cwd, shell `cd` never changes it. */
	workspaceRoot?: string;
	/** Called when a shell command changes its working directory. */
	onCwdChange?: (cwd: string) => void;
	/** Owner used to clean up autonomous background work safely. */
	backgroundOwner?: 'user' | 'goal' | 'loop';
	/** Harness-backed user interaction for model-facing question tools. */
	askUser?: (
		question: string,
		options?: Array<{label: string; description?: string}>,
		multiple?: boolean,
	) => Promise<string>;
	/** Persist asynchronous state changes such as background-agent progress. */
	onStateChange?: () => void;
	/** Debounced persistence hook for high-frequency agent stream updates. */
	onAgentProgress?: () => void;
	/** PreToolUse-rewritten args already checked by caller. */
	preprocessedArgs?: Record<string, unknown>;
	/** Tell the parent turn that detached work now owns execution. */
	onDetachedWork?: (kind: 'bash' | 'agent', id: string) => void;
	/** Notify caller when detached work reaches a terminal state. */
	onDetachedComplete?: (
		kind: 'bash' | 'agent',
		id: string,
		status: 'completed' | 'failed' | 'cancelled' | 'incomplete',
		output: string,
		owner: 'user' | 'goal' | 'loop',
		graphId?: string,
	) => void;
}

interface ToolDef {
	execute: (
		args: Record<string, unknown>,
		ctx: ToolContext,
	) => Promise<string> | string;
	/** Read-only tools never require approval (B16/D4 default). */
	readOnly?: boolean;
	/** Model-facing description (the provider sees this in the tools array). */
	description?: string;
	/** Model-facing JSON schema for the arguments (empty schema by default). */
	parameters?: Record<string, unknown>;
	/** Registration owner for collision diagnostics. */
	source?: 'builtin' | 'custom' | 'mcp' | 'runtime';
	/** Force approval even if tool is otherwise classified read-only. */
	approvalRequired?: boolean;
}

const toolRegistry = new Map<string, ToolDef>();
const activatedDeferredTools = new Set<string>();
const sessionPermissionGrants = new Set<string>();
const sessionExternalWriteGrants = new Set<string>();
const sessionExternalDeleteGrants = new Set<string>();
const NON_PARALLEL_TOOLS = new Set([
	'question',
	'request_permissions',
	'agent_message',
	'agent_cancel',
]);
const activeAgentControllers = new Map<string, AbortController>();
const activeAgentGenerations = new Map<string, number>();
const activeAgentMessages = new Map<string, string[]>();
const agentStatusWaiters = new Map<string, Set<() => void>>();
const reviewBatchPromises = new Map<string, Promise<string>>();

export function reviewBatchKey(input: {
	graphId?: string;
	sessionId?: string;
	root: string;
	base: string;
	reviewers: string[];
	changedFiles?: string[];
}): string {
	return [
		input.graphId ?? `session:${input.sessionId ?? 'unknown'}`,
		input.root,
		input.base,
		input.reviewers
			.map(name => name.toLowerCase())
			.sort()
			.join(','),
		(input.changedFiles ?? []).join('\n'),
	].join('|');
}
export const MAX_SUBAGENT_TOOL_ROUNDS = 24;
/** Hard stop for detached work. A child must not own a shell or provider
 * stream forever when it picked a server command or the provider wedged. */
export const MAX_SUBAGENT_DURATION_MS = 15 * 60 * 1000;
export const SUBAGENT_FINALIZATION_PROMPT =
	'Provide your final response now. Do not call tools. Summarize verified findings, ' +
	'completed work, blockers, and unresolved items using the evidence already in your history.';

export function subagentResultIsIncomplete(result: string): boolean {
	return result.startsWith('Subagent ') && result.includes('tool-round budget');
}
/** Cancel every delegated agent shown in `/ps` Agents tab. */
export function cancelActiveAgents(): number {
	const controllers = [...activeAgentControllers.values()];
	for (const controller of controllers) controller.abort();
	return controllers.length;
}
/** Cancel one delegated agent by stable run id. */
export function cancelActiveAgent(id: string): boolean {
	const controller = activeAgentControllers.get(id);
	if (!controller) return false;
	controller.abort();
	return true;
}
function notifyAgentStatus(id: string): void {
	for (const wake of agentStatusWaiters.get(id) ?? []) wake();
	agentStatusWaiters.delete(id);
}
function queueAgentMessage(id: string, message: string): void {
	activeAgentMessages.set(id, [
		...(activeAgentMessages.get(id) ?? []),
		message,
	]);
}
function drainAgentMessages(id: string): string[] {
	const messages = activeAgentMessages.get(id) ?? [];
	activeAgentMessages.delete(id);
	return messages;
}
function agentSignal(
	id: string,
	parent?: AbortSignal,
): {signal: AbortSignal; generation: number; dispose: () => void} {
	const controller = new AbortController();
	const generation = (activeAgentGenerations.get(id) ?? 0) + 1;
	activeAgentGenerations.set(id, generation);
	activeAgentControllers.set(id, controller);
	const abortFromParent = () => controller.abort();
	if (parent?.aborted) controller.abort();
	else parent?.addEventListener('abort', abortFromParent, {once: true});
	const timer = setTimeout(() => controller.abort(), MAX_SUBAGENT_DURATION_MS);
	timer.unref?.();
	return {
		signal: controller.signal,
		generation,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener('abort', abortFromParent);
		},
	};
}

export function registerTool(
	name: string,
	def: ToolDef,
	options: {replace?: boolean} = {},
): void {
	if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
		throw new Error(`Invalid tool name: ${name}`);
	}
	const existing = toolRegistry.get(name);
	if (existing && !options.replace) {
		throw new Error(
			`Tool name collision: ${name} (${existing.source ?? 'builtin'} vs ${def.source ?? 'runtime'})`,
		);
	}
	toolRegistry.set(name, {...def, source: def.source ?? 'runtime'});
}

export function listTools(): string[] {
	return [...toolRegistry.keys()];
}

/**
 * Model-facing tool catalog: the registry names plus the optional
 * descriptions/schemas each tool declares. The request head uses THIS (a
 * bare name list leaves the model guessing what each tool does — the
 * `skill` tools were unusable until they got descriptions + schemas).
 */
export function toolCatalog(): ToolCatalogEntry[] {
	return [...toolRegistry.entries()].map(([name, def]) => ({
		name,
		description: def.description ?? '',
		parameters: def.parameters,
	}));
}

export function searchDeferredTools(
	query: string,
	limit = 10,
): ToolCatalogEntry[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return [...toolRegistry.entries()]
		.filter(([, def]) => def.source === 'custom' || def.source === 'mcp')
		.map(([name, def]) => ({
			name,
			description: def.description ?? '',
			parameters: def.parameters,
			score: terms.reduce(
				(total, term) =>
					total +
					(name.toLowerCase().includes(term) ? 3 : 0) +
					((def.description ?? '').toLowerCase().includes(term) ? 1 : 0),
				0,
			),
		}))
		.filter(tool => terms.length === 0 || tool.score > 0)
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, Math.max(1, Math.min(50, limit)))
		.map(({score: _score, ...tool}) => tool);
}

export function resetDeferredToolActivation(): void {
	activatedDeferredTools.clear();
}
export function resetSessionPermissionGrants(): void {
	sessionPermissionGrants.clear();
	sessionExternalWriteGrants.clear();
	sessionExternalDeleteGrants.clear();
}
/** OpenCode-style model capability gate for patch-oriented GPT models. */
export function modelUsesApplyPatch(model: string): boolean {
	const id = model.toLowerCase();
	return id.includes('gpt-') && !id.includes('oss') && !id.includes('gpt-4');
}
/** Model-facing catalog: eligible GPT models get apply_patch instead of overlapping edit/write tools. */
export function toolCatalogForModel(model: string): ToolCatalogEntry[] {
	const usePatch = modelUsesApplyPatch(model);
	return toolCatalog().filter(tool => {
		const def = toolRegistry.get(tool.name);
		if (
			(def?.source === 'custom' || def?.source === 'mcp') &&
			!activatedDeferredTools.has(tool.name)
		)
			return false;
		if (tool.name === 'apply_patch') return usePatch;
		if (['string_replace', 'diff_edit'].includes(tool.name)) return false;
		if (usePatch && ['edit_file', 'write_file'].includes(tool.name))
			return false;
		return true;
	});
}

/** Mutation tools require approval in `normal` mode (B16). */
const READ_ONLY_TOOLS = new Set([
	'read_file',
	'glob',
	'grep',
	'web_search',
	'fetch_url',
	'skill',
	'command',
	'check_skill',
	'agent',
	'request_permissions',
]);

export function requiresApproval(
	name: string,
	mode: Mode,
	alwaysAllow: string[] = [],
	externalPathGranted = false,
): boolean {
	if (autoApprovesTools(mode)) return false;
	if (externalPathGranted) return false;
	if (
		alwaysAllow.includes(name) ||
		alwaysAllow.includes(resolveToolName(name)) ||
		sessionPermissionGrants.has(name) ||
		sessionPermissionGrants.has(resolveToolName(name))
	) {
		return false;
	}
	if (toolRegistry.get(resolveToolName(name))?.approvalRequired) return true;
	if (READ_ONLY_TOOLS.has(name)) return false;
	if (toolRegistry.get(name)?.readOnly) return false;
	return true;
}

/** Read-only tools never mutate state (B17 parallel batch eligibility). */
export function isReadOnlyTool(name: string): boolean {
	const canonical = resolveToolName(name);
	return (
		READ_ONLY_TOOLS.has(canonical) ||
		toolRegistry.get(canonical)?.readOnly === true
	);
}
/** Interactive/session tools execute sequentially even when read-only. */
export function isParallelSafeTool(name: string): boolean {
	return !NON_PARALLEL_TOOLS.has(resolveToolName(name));
}

/** Plan mode excludes mutation tools (D3 MODE_EXCLUDED_TOOLS). */
const PLAN_EXCLUDED = new Set([
	'write_file',
	'edit_file',
	'string_replace',
	'diff_edit',
	'apply_patch',
	'delete_file',
	'execute_bash',
	'process_start',
	'process_input',
	'process_stop',
	'service_start',
	'service_restart',
	'service_stop',
	'enter_worktree',
	'exit_worktree',
	'remove_worktree',
	'write_tasks',
	'task_create',
	'task_update',
]);

const sleep = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms));
async function streamLines(
	content: string,
	ctx: ToolContext,
	delayMs = 35,
): Promise<string> {
	const lines = content.split('\n');
	if (lines.length <= 1) return content;
	let acc = '';
	for (const line of lines) {
		if (ctx.signal?.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		acc = acc ? `${acc}\n${line}` : line;
		ctx.onProgress?.(acc);
		await sleep(delayMs);
	}
	return content;
}
/** Tool profiles (D7): nano = 7, minimal = 10 core tools. */
const NANO_TOOLS = new Set([
	'read_file',
	'edit_file',
	'apply_patch',
	'write_file',
	'delete_file',
	'execute_bash',
	'web_search',
	'command',
	'remember',
	'forget',
]);

const MINIMAL_TOOLS = new Set([
	'execute_bash',
	'read_file',
	'write_file',
	'edit_file',
	'delete_file',
	'web_search',
	'agent',
	'command',
	'remember',
	'forget',
]);

export function resolveProfile(
	profile: ToolProfile,
	model: string,
): Exclude<ToolProfile, 'auto'> {
	if (profile !== 'auto') return profile;
	const id = model.toLowerCase();
	if (id.includes('nano')) return 'nano';
	if (id.includes('mini') || id.includes('minimal')) return 'minimal';
	return 'full';
}

export function toolAvailability(
	name: string,
	profile: ToolProfile,
	mode: Mode,
	model: string,
): {available: boolean; reason?: string} {
	if (mode === 'plan' && PLAN_EXCLUDED.has(name)) {
		return {available: false, reason: 'not available in plan mode'};
	}
	const usePatch = modelUsesApplyPatch(model);
	if (name === 'apply_patch' && !usePatch) {
		return {
			available: false,
			reason: 'is only available to supported GPT models',
		};
	}
	if (
		usePatch &&
		['write_file', 'edit_file', 'string_replace', 'diff_edit'].includes(name)
	) {
		return {
			available: false,
			reason: 'is replaced by apply_patch for this GPT model',
		};
	}
	const resolved = resolveProfile(profile, model);
	if (resolved === 'nano' && !NANO_TOOLS.has(name)) {
		return {available: false, reason: `not available in nano profile`};
	}
	if (resolved === 'minimal' && !MINIMAL_TOOLS.has(name)) {
		return {available: false, reason: `not available in minimal profile`};
	}
	return {available: true};
}

export function isSingleToolProfile(
	profile: ToolProfile,
	model: string,
): boolean {
	const resolved = resolveProfile(profile, model);
	return resolved === 'nano' || resolved === 'minimal';
}

function text(args: Record<string, unknown>, key: string): string {
	return typeof args[key] === 'string' ? (args[key] as string) : '';
}
function pathWithinWorkspace(path: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), resolve(path));
	return (
		rel === '' ||
		(rel !== '..' &&
			!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
			!isAbsolute(rel))
	);
}

function externalGrantRoot(path: string): string {
	const target = resolve(path);
	const parent = dirname(target);
	const gitRoot = projectRoot(parent);
	return pathWithinWorkspace(target, gitRoot) ? gitRoot : dirname(target);
}
/** Folder grants bypass normal-mode approval only for direct file paths. */
export function hasSessionExternalWriteGrant(path: string): boolean {
	const target = resolve(path);
	return [...sessionExternalWriteGrants].some(granted =>
		pathWithinWorkspace(target, granted),
	);
}
/**
 * Only handlers which recheck effective (post-hook) paths may skip generic
 * approval. Shell and patch payloads remain separately approved.
 */
export function callUsesGrantedExternalWritePath(
	call: MockToolCall,
	cwd: string,
	workspaceRoot: string,
): boolean {
	const name = resolveToolName(call.name);
	if (!['write_file', 'edit_file'].includes(name)) return false;
	const path = call.arguments.path;
	if (typeof path !== 'string' || !path.trim()) return false;
	const target = resolve(cwd, path);
	return (
		!pathWithinWorkspace(target, workspaceRoot) &&
		hasSessionExternalWriteGrant(target)
	);
}
/** Approval policy with path context. Do not apply folder grants tool-wide. */
export function requiresCallApproval(
	call: MockToolCall,
	mode: Mode,
	alwaysAllow: string[],
	cwd: string,
	workspaceRoot: string,
): boolean {
	return requiresApproval(
		call.name,
		mode,
		alwaysAllow,
		callUsesGrantedExternalWritePath(call, cwd, workspaceRoot),
	);
}

/**
 * Resolve PreToolUse rewrites before path-scoped approval. Callers pass the
 * result back to executeTool so a hook cannot redirect a folder grant after
 * approval. Undefined means execution must run the hook normally.
 */
export async function preprocessToolInput(
	call: MockToolCall,
	contextId = 'main',
	sessionId = hookSessionId(),
): Promise<Record<string, unknown> | undefined> {
	const name = resolveToolName(call.name);
	if (name === 'execute_bash') return undefined;
	const pre = await withHookContext(
		contextId,
		() =>
			runHooks({
				contextId,
				event: 'PreToolUse',
				toolName: name,
				toolInput: call.arguments,
			}),
		sessionId,
	);
	if (pre.denied) return undefined;
	return pre.updatedInput ?? call.arguments;
}

async function requestExternalWriteAccess(
	path: string,
	ctx: ToolContext,
	operation: string,
): Promise<string | null> {
	const target = resolve(path);
	if (loadSettings().mode === 'yolo') return externalGrantRoot(target);
	const workspaceRoot = resolve(ctx.workspaceRoot || ctx.cwd || process.cwd());
	if (pathWithinWorkspace(target, workspaceRoot)) return workspaceRoot;
	for (const granted of sessionExternalWriteGrants) {
		if (pathWithinWorkspace(target, granted)) return granted;
	}
	if (!ctx.askUser || process.env.NANOCODER_NONINTERACTIVE) return null;
	const folder = externalGrantRoot(target);
	const answer = await ctx.askUser(
		`Allow external workspace access?\nTool: ${operation}\nTarget: ${target}\nFolder: ${folder}`,
		[
			{label: 'Allow once', description: 'Allow this operation only.'},
			{
				label: 'Allow folder for session',
				description: 'Allow later edits under this folder until session ends.',
			},
			{label: 'Deny', description: 'Keep folder read-only.'},
		],
	);
	if (answer === 'Allow folder for session')
		sessionExternalWriteGrants.add(folder);
	return answer === 'Allow once' || answer === 'Allow folder for session'
		? folder
		: null;
}

export function readonlyFailurePath(content: string): string | null {
	const patterns = [
		/read-only file system, (?:open|rename|mkdir|unlink) ['"]([^'"]+)['"]/i,
		/(?:cannot (?:create|touch|open|move|remove)[^'"\n]*):?\s*['"]([^'"]+)['"]\s*:\s*Read-only file system/i,
		/['"]([^'"]+)['"]\s*:\s*Read-only file system/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(content);
		if (match?.[1]) return match[1];
	}
	return null;
}

export function executeTool(
	call: MockToolCall,
	ctx: ToolContext = {},
): Promise<ToolResult> {
	return withHookContext(
		ctx.agentId ? `agent:${ctx.agentId}` : (ctx.hookContextId ?? 'main'),
		() => executeScopedTool(call, ctx),
		ctx.hookSessionId,
	);
}
async function executeScopedTool(
	call: MockToolCall,
	ctx: ToolContext = {},
): Promise<ToolResult> {
	const canonicalName = resolveToolName(call.name);
	const canonicalCall = {...call, name: canonicalName};
	if (call.arguments._malformed) {
		// Invalid JSON arguments: surface a validation error instead of
		// silently executing with defaults (parity: tool-schema error).
		return {
			tool_call_id: call.id,
			content: `Error: Invalid tool arguments: ${call.rawArguments}`,
		};
	}
	const def = toolRegistry.get(canonicalName);
	if (!def) {
		return {tool_call_id: call.id, content: `Unknown tool: ${call.name}`};
	}
	const validation = validateToolArguments(
		canonicalCall.arguments,
		def.parameters,
	);
	if (!validation.valid) {
		return {
			tool_call_id: call.id,
			content: `Error: Invalid tool arguments for ${canonicalName}: ${validation.errors.join('; ')}${canonicalName === 'execute_bash' ? '. Bash accepts only command. To intentionally use another directory, put cd "<directory>" && <command> inside command. Nothing was executed.' : ''}`,
		};
	}
	try {
		let effectiveArgs = ctx.preprocessedArgs ?? canonicalCall.arguments;
		if (!ctx.preprocessedArgs && canonicalName !== 'execute_bash') {
			const pre = await runHooks({
				event: 'PreToolUse',
				toolName: canonicalName,
				toolInput: effectiveArgs,
			});
			if (pre.denied) throw new Error(pre.denied);
			if (pre.updatedInput) effectiveArgs = pre.updatedInput;
		}
		// /undo parity (openclaude rewind): snapshot the file(s) this
		// mutation will touch BEFORE executing, so a later undo can restore
		// them alongside the transcript truncation. Non-file tools no-op.
		snapshotMutationTargets(
			canonicalName,
			effectiveArgs,
			ctx.cwd || process.cwd(),
		);
		let displayArgs: Record<string, unknown> | undefined =
			canonicalName === 'apply_patch'
				? {
						...effectiveArgs,
						_applyPatchDisplay: applyPatchDisplayChanges(
							ctx.cwd || process.cwd(),
							text(effectiveArgs, 'patchText'),
						),
					}
				: undefined;
		const content = await def.execute(effectiveArgs, {
			...ctx,
			toolCallId: call.id,
		});
		if (
			['write_tasks', 'task_create', 'task_update', 'task_list'].includes(
				canonicalName,
			)
		) {
			displayArgs = contextTaskDisplayArgs(ctx);
		}
		if (canonicalName !== 'execute_bash') {
			await runHooks({
				event: 'PostToolUse',
				toolName: canonicalName,
				toolInput: effectiveArgs,
				data: {tool_result: content},
			});
		}
		return {tool_call_id: call.id, content, displayArgs};
	} catch (error) {
		// Cancellation must unwind the whole turn. Converting AbortError into a
		// normal tool result lets the model continue while agents still clean up.
		if (error instanceof Error && error.name === 'AbortError') throw error;
		return {
			tool_call_id: call.id,
			content: `Error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

registerTool('read_file', {
	description:
		'Read a UTF-8 text file from the current workspace. Supports an optional ' +
		'1-based line offset and line limit; output is capped to prevent oversized tool results.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or cwd-relative file path.',
			},
			offset: {
				type: 'number',
				description: 'First 1-based line to return. Defaults to 1.',
			},
			limit: {
				type: 'number',
				description: 'Maximum lines to return. Defaults to 2000, maximum 5000.',
			},
		},
		required: ['path'],
	},
	readOnly: true,
	async execute(args, ctx) {
		const requested = text(args, 'path');
		if (!requested) return 'Error: read_file requires a path.';
		const cwd = ctx.cwd || process.cwd();
		const workspaceRoot = ctx.workspaceRoot || cwd;
		const path = resolve(cwd, requested);
		if (!pathWithinWorkspace(path, workspaceRoot))
			return `Error: ${requested} is outside the current workspace.`;
		const file = Bun.file(path);
		if (!(await file.exists())) return `Error: ${requested} does not exist`;
		try {
			if (
				!pathWithinWorkspace(realpathSync(path), realpathSync(workspaceRoot))
			) {
				return `Error: ${requested} resolves outside the current workspace.`;
			}
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (file.size > 10 * 1024 * 1024) {
			return `Error: ${requested} is larger than the 10 MiB read limit.`;
		}
		const source = await file.text();
		if (source.includes('\u0000'))
			return `Error: ${requested} appears to be binary.`;
		const lines = source.replace(/\r\n/g, '\n').split('\n');
		const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
		const limit = Math.max(
			1,
			Math.min(5000, Math.floor(Number(args.limit) || 2000)),
		);
		const visible = lines.slice(offset - 1, offset - 1 + limit);
		const hidden = Math.max(0, lines.length - (offset - 1 + visible.length));
		return `${visible.join('\n')}${hidden > 0 ? `\n… +${hidden} more lines` : ''}`;
	},
});
registerTool('view_image', {
	description:
		'Inspect a workspace image with the configured vision model. Supports PNG, JPEG, GIF, and WebP up to 20 MiB; paths cannot escape the workspace.',
	parameters: {
		type: 'object',
		properties: {
			path: {type: 'string'},
			question: {type: 'string'},
		},
		required: ['path'],
	},
	readOnly: true,
	async execute(args, ctx) {
		try {
			return await inspectWorkspaceImage(
				text(args, 'path'),
				text(args, 'question'),
				ctx.cwd || process.cwd(),
			);
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('tool_search', {
	description:
		'Search deferred custom and MCP tools by capability. Matching tools become available in the next model round; use this instead of guessing hidden tool names.',
	parameters: {
		type: 'object',
		properties: {
			query: {type: 'string'},
			limit: {type: 'integer', minimum: 1, maximum: 50},
		},
		required: ['query'],
	},
	readOnly: true,
	execute(args) {
		const matches = searchDeferredTools(
			text(args, 'query'),
			Number(args.limit) || 10,
		);
		for (const match of matches) activatedDeferredTools.add(match.name);
		if (matches.length === 0) return 'No deferred tools matched.';
		return matches
			.map(
				tool =>
					`${tool.name}: ${tool.description}\n${JSON.stringify(tool.parameters ?? {})}`,
			)
			.join('\n\n');
	},
});
registerTool('lsp', {
	description:
		'Query code intelligence without editing files. Supports installed server ' +
		'discovery, project diagnostics, symbol definitions, and references. ' +
		'Symbol/reference queries use a fast source search fallback when a live server is unavailable.',
	parameters: {
		type: 'object',
		properties: {
			operation: {
				type: 'string',
				enum: [
					'servers',
					'diagnostics',
					'symbols',
					'references',
					'definition',
					'hover',
				],
			},
			query: {type: 'string', description: 'Symbol or reference name.'},
			path: {
				type: 'string',
				description: 'Optional cwd-relative file or directory scope.',
			},
			line: {
				type: 'number',
				description: '1-based source line for protocol queries.',
			},
			character: {
				type: 'number',
				description: '1-based source column for protocol queries.',
			},
		},
		required: ['operation'],
	},
	readOnly: true,
	async execute(args, ctx) {
		return executeLspOperation(ctx.cwd || process.cwd(), {
			operation: text(args, 'operation'),
			query: text(args, 'query'),
			path: text(args, 'path'),
			line: Number(args.line) || undefined,
			character: Number(args.character) || undefined,
		});
	},
});

registerTool('remember', {
	description:
		'Save durable user, project, or current-session guidance. Use only for explicit preferences, corrections, or instructions that should survive later turns.',
	parameters: {
		type: 'object',
		properties: {
			text: {type: 'string', description: 'Guidance to remember.'},
			category: {
				type: 'string',
				description:
					'Optional preference category. Same-category active records are superseded.',
			},
			scope: {
				type: 'string',
				enum: ['user', 'project', 'session'],
				description: 'Persistence scope. Default: session.',
			},
		},
		required: ['text'],
	},
	readOnly: false,
	execute: (args, ctx) => {
		const text = typeof args.text === 'string' ? args.text.trim() : '';
		if (!text) return 'Error: remember requires non-empty text.';
		const rawScope = typeof args.scope === 'string' ? args.scope : 'session';
		if (!['user', 'project', 'session'].includes(rawScope)) {
			return 'Error: remember scope must be user, project, or session.';
		}
		const path = appendMemory(
			text,
			rawScope as 'user' | 'project' | 'session',
			ctx.cwd ?? process.cwd(),
			ctx.sessionId,
			{
				category: typeof args.category === 'string' ? args.category : undefined,
				source: 'model',
			},
		);
		ctx.onStateChange?.();
		return `Remembered ${rawScope} guidance in ${path}`;
	},
});

registerTool('forget', {
	description:
		'Forget one durable memory record by id, or clear an entire user, project, or current session scope. Use only when explicitly asked.',
	parameters: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description: 'Exact memory id to mark forgotten.',
			},
			scope: {
				type: 'string',
				enum: ['user', 'project', 'session'],
			},
		},
		required: [],
	},
	readOnly: false,
	execute: (args, ctx) => {
		const id = typeof args.id === 'string' ? args.id.trim() : '';
		const scope = typeof args.scope === 'string' ? args.scope : '';
		if (!id && !['user', 'project', 'session'].includes(scope)) {
			return 'Error: forget requires an exact memory id or a user, project, or session scope.';
		}
		if (id && scope) return 'Error: forget accepts id or scope, not both.';
		if (id) {
			const count = forgetMemory(id, ctx.cwd ?? process.cwd(), ctx.sessionId);
			ctx.onStateChange?.();
			return count ? `Forgot memory ${id}.` : `Memory not found: ${id}`;
		}
		const path = clearMemory(
			scope as 'user' | 'project' | 'session',
			ctx.cwd ?? process.cwd(),
			ctx.sessionId,
		);
		ctx.onStateChange?.();
		return `Cleared ${scope} memory: ${path}`;
	},
});

registerTool('question', {
	description:
		'Ask the user one or more focused questions when required information ' +
		'cannot be inferred safely. Each question may include suggested options; ' +
		'the user can still type a custom answer. Do not use for routine confirmation.',
	parameters: {
		type: 'object',
		properties: {
			questions: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						header: {type: 'string'},
						question: {type: 'string'},
						options: {
							type: 'array',
							items: {
								oneOf: [
									{type: 'string'},
									{
										type: 'object',
										properties: {
											label: {type: 'string'},
											description: {type: 'string'},
										},
										required: ['label'],
									},
								],
							},
						},
						multi_select: {type: 'boolean'},
					},
					required: ['question'],
				},
			},
		},
		required: ['questions'],
	},
	readOnly: true,
	async execute(args, ctx) {
		if (!ctx.askUser) return 'Error: user interaction is unavailable.';
		const questions = Array.isArray(args.questions) ? args.questions : [];
		if (questions.length === 0)
			return 'Error: question requires at least one question.';
		const answers: string[] = [];
		for (const [index, value] of questions.entries()) {
			if (!value || typeof value !== 'object') continue;
			const row = value as Record<string, unknown>;
			const prompt = String(row.question ?? '').trim();
			if (!prompt) continue;
			const header = String(row.header ?? '').trim();
			const options = Array.isArray(row.options)
				? row.options.flatMap(option => {
						if (typeof option === 'string') {
							const label = option.trim();
							return label ? [{label}] : [];
						}
						if (!option || typeof option !== 'object') return [];
						const value = option as Record<string, unknown>;
						const label = String(value.label ?? '').trim();
						return label
							? [
									{
										label,
										description:
											String(value.description ?? '').trim() || undefined,
									},
								]
							: [];
					})
				: [];
			const rendered = header ? `[${header}] ${prompt}` : prompt;
			const answer = await ctx.askUser(
				rendered,
				options,
				row.multi_select === true,
			);
			answers.push(`${index + 1}. ${answer || '(cancelled)'}`);
			if (!answer) break;
		}
		return `User answers:\n${answers.join('\n')}`;
	},
});

registerTool('request_permissions', {
	description:
		'Request session-scoped approval for specific tool names. Include exact command and external paths when needed. Granted external access is limited to listed paths; dynamic, recursive, and unlisted deletion remain blocked.',
	parameters: {
		type: 'object',
		properties: {
			permissions: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						tool: {type: 'string'},
						reason: {type: 'string'},
						operation: {type: 'string'},
						paths: {type: 'array', items: {type: 'string'}},
					},
					required: ['tool', 'reason'],
				},
			},
		},
		required: ['permissions'],
	},
	readOnly: true,
	async execute(args, ctx) {
		const unrestricted = loadSettings().mode === 'yolo';
		if (!unrestricted && !ctx.askUser)
			return 'Error: user interaction is unavailable.';
		const requested = Array.isArray(args.permissions)
			? args.permissions.flatMap(value => {
					if (!value || typeof value !== 'object') return [];
					const row = value as Record<string, unknown>;
					const tool = String(row.tool ?? '').trim();
					const reason = String(row.reason ?? '').trim();
					const operation = String(row.operation ?? '').trim();
					const paths = Array.isArray(row.paths)
						? row.paths
								.filter((path): path is string => typeof path === 'string')
								.map(path => resolve(path))
						: [];
					return tool && reason
						? [{tool: resolveToolName(tool), reason, operation, paths}]
						: [];
				})
			: [];
		if (requested.length === 0) return 'Error: no valid permissions requested.';
		const unknown = requested.filter(row => !toolRegistry.has(row.tool));
		if (unknown.length)
			return `Error: unknown tools: ${unknown.map(row => row.tool).join(', ')}`;
		const answer = unrestricted
			? 'Grant'
			: await ctx.askUser!(
					`Grant these tools for this session?\n${requested
						.map(row => {
							const operation = row.operation
								? `\n  Command: ${row.operation}`
								: '';
							const paths = row.paths.length
								? `\n  External paths: ${row.paths.join(', ')}`
								: '';
							return `${row.tool}: ${row.reason}${operation}${paths}`;
						})
						.join('\n')}`,
					[{label: 'Grant'}, {label: 'Deny'}],
					false,
				);
		if (answer !== 'Grant') return 'Permission denied.';
		for (const row of requested) {
			sessionPermissionGrants.add(row.tool);
			for (const path of row.paths) {
				if (row.tool === 'delete_file') sessionExternalDeleteGrants.add(path);
				else sessionExternalWriteGrants.add(externalGrantRoot(path));
			}
		}
		return `Granted for this session: ${requested.map(row => row.tool).join(', ')}. External access is limited to listed paths; recursive or dynamic deletion remains blocked.`;
	},
});

registerTool('execute_bash', {
	description:
		'Run a shell command in the terminal (builds, tests, git, process ' +
		'management, file inspection — anything no dedicated file tool ' +
		'covers; prefer edit_file/write_file or apply_patch for editing ' +
		'files and delete_file for deleting them). Commands start in the ' +
		'Current Working Directory from SYSTEM INFORMATION; do not prepend ' +
		'`cd` unless intentionally changing directories. Only command is accepted; ' +
		'workdir/cwd arguments are rejected. Use `cd "<directory>" && <command>` ' +
		'inside command when targeting another repository. ' +
		'ALWAYS write a one-line PRE-TOOL BRIEF before calling this tool — ' +
		'what you are about to run and why, ≤8 words (e.g. "run tests to ' +
		'verify") — THEN call it in the same message; this requirement ' +
		'overrides any general "no narration" style rules. The brief is ' +
		'MANDATORY when the previous bash call had no explanation, or when ' +
		'this call starts a NEW action or goal. Keep it terse ONLY when ' +
		'this exact call continues the same goal you already explained in ' +
		'the previous message. When running `git commit`, use exactly ONE ' +
		'-m with a SINGLE-LINE subject and NO AI-attribution lines ' +
		'(Co-authored-by:, Generated by:, etc.). When running `gh pr create`, ' +
		'never credit an LLM in the title/body ("Generated by:" and similar). ' +
		'Violating commands are REFUSED before they run.',
	parameters: {
		type: 'object',
		additionalProperties: false,
		properties: {
			command: {
				type: 'string',
				description:
					'The shell command to execute. `git commit` must use exactly ' +
					'ONE single-line -m with no AI attribution; `gh pr create` ' +
					'must not credit an LLM.',
			},
		},
		required: ['command'],
	},
	async execute(args, ctx) {
		let command = text(args, 'command') || 'true';
		// Capture workspace before async hooks. process.cwd() is global and can
		// change during resume/clear while hooks are running.
		const cwd = ctx.cwd || projectRoot(process.cwd());
		// Claude-compatible user + nearest project PreToolUse hooks. Hooks may
		// deny the call or rewrite input (RTK); denial happens before mutation.
		const hooked = await runBashPreHooks(command);
		command = normalizeBashCommand(hooked.command, cwd);
		// House rule (git/gh messages): validate BEFORE running so a bad
		// commit or PR never lands. Pure, unit-tested (commit-guard.ts).
		if (/\bgit\s+commit\b/i.test(command)) {
			const violation = gitCommitMessagesViolation(
				commitMessagesFromCommand(command),
			);
			if (violation) {
				return (
					`REFUSED to run — ${violation}.\n` +
					`Redo the command with exactly one single-line -m and no AI attribution.`
				);
			}
		}
		if (/\bgh\s+pr\b/i.test(command)) {
			const violation = ghPrMessagesViolation(
				commitMessagesFromCommand(command),
			);
			if (violation) {
				return (
					`REFUSED to run — ${violation}.\n` +
					`Redo the command without crediting an LLM.`
				);
			}
		}
		let result = await runBash(
			command,
			ctx.onProgress,
			ctx.signal,
			cwd,
			ctx.onCwdChange,
			ctx.backgroundOwner ?? 'user',
			ctx.workspaceRoot,
			[...sessionExternalWriteGrants],
		);
		const blockedPath = readonlyFailurePath(result.content);
		if (blockedPath) {
			const absolute = resolve(cwd, blockedPath);
			const grant = await requestExternalWriteAccess(absolute, ctx, command);
			if (!grant) {
				return `Permission denied: external folder remains read-only: ${externalGrantRoot(absolute)}`;
			}
			result = await runBash(
				command,
				ctx.onProgress,
				ctx.signal,
				cwd,
				ctx.onCwdChange,
				ctx.backgroundOwner ?? 'user',
				ctx.workspaceRoot,
				[...sessionExternalWriteGrants, grant],
			);
		}
		// Auto-backgrounded commands stay detached from the main turn. Waiting
		// here kept `busy()` true until process exit, so every user message was
		// queued even though the shell task was already running independently.
		if (result.cwd) ctx.onCwdChange?.(result.cwd);
		if (result.task?.running) {
			// Tool lifecycle owns completion delivery. Suppress runBash's legacy
			// display-only completion row so one task produces one notification.
			result.task.claimed = true;
			ctx.onDetachedWork?.('bash', result.task.id);
			void result.task.completion?.then(() =>
				ctx.onDetachedComplete?.(
					'bash',
					result.task!.id,
					result.task!.exitCode === 0 ? 'completed' : 'failed',
					result.task!.output.join('\n'),
					result.task!.owner ?? ctx.backgroundOwner ?? 'user',
					ctx.workGraphId,
				),
			);
		}
		const content = result.content;
		await runBashPostHooks(command, content);
		return content;
	},
});
registerTool('process_start', {
	description:
		'Start a persistent sandboxed process and return its id immediately. Use process_input, process_status, and process_stop for lifecycle control.',
	parameters: {
		type: 'object',
		properties: {command: {type: 'string'}},
		required: ['command'],
	},
	execute(args, ctx) {
		const row = startPersistentProcess(
			text(args, 'command'),
			ctx.cwd || process.cwd(),
			ctx.backgroundOwner ?? 'user',
			completed =>
				ctx.onDetachedComplete?.(
					'bash',
					completed.id,
					completed.exitCode === 0 ? 'completed' : 'failed',
					completed.output.join('\n'),
					completed.owner ?? 'user',
					ctx.workGraphId,
				),
		);
		return `Started ${row.id} (pid ${row.proc.pid}).`;
	},
});
registerTool('process_input', {
	description: 'Write text to a running persistent process stdin.',
	parameters: {
		type: 'object',
		properties: {process_id: {type: 'string'}, input: {type: 'string'}},
		required: ['process_id', 'input'],
	},
	execute(args) {
		return writePersistentProcess(
			text(args, 'process_id'),
			text(args, 'input'),
		);
	},
});
registerTool('process_status', {
	description:
		'Inspect one persistent process or list all persistent processes with recent output.',
	parameters: {type: 'object', properties: {process_id: {type: 'string'}}},
	readOnly: true,
	async execute(args) {
		const id = text(args, 'process_id') || undefined;
		const delay = reserveProcessStatusPoll(id);
		if (delay > 0) await Bun.sleep(delay);
		return persistentProcessStatus(id);
	},
});
registerTool('process_stop', {
	description: 'Stop one persistent process and its process group.',
	parameters: {
		type: 'object',
		properties: {process_id: {type: 'string'}},
		required: ['process_id'],
	},
	execute(args) {
		return stopPersistentProcess(text(args, 'process_id'));
	},
});

registerTool('service_check', {
	description:
		'Check whether a permission-scoped host supervisor bridge is available for managed services.',
	parameters: {type: 'object', properties: {}},
	readOnly: true,
	execute() {
		return checkManagedServiceSupervisor();
	},
});
registerTool('service_start', {
	description:
		'Start or replace one named workspace-scoped service under the host user manager. The service survives tool return and uses systemd restart and cgroup cleanup. Command runs inside the workspace sandbox.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Stable service name within this workspace.',
			},
			command: {type: 'string'},
			cwd: {
				type: 'string',
				description: 'Optional working directory inside workspace root.',
			},
			restart: {
				type: 'string',
				enum: ['always', 'on-failure', 'no'],
			},
		},
		required: ['name', 'command'],
	},
	execute(args, ctx) {
		const root = ctx.workspaceRoot || projectRoot(ctx.cwd || process.cwd());
		const cwd = text(args, 'cwd')
			? resolve(ctx.cwd || root, text(args, 'cwd'))
			: ctx.cwd || root;
		const restart = text(args, 'restart');
		return startManagedService({
			name: text(args, 'name'),
			command: text(args, 'command'),
			cwd,
			workspaceRoot: root,
			restart:
				restart === 'always' || restart === 'no' ? restart : 'on-failure',
		});
	},
});
registerTool('service_status', {
	description:
		'Inspect one named workspace-scoped managed service, including exact invocation id, main pid, and cgroup.',
	parameters: {
		type: 'object',
		properties: {name: {type: 'string'}},
		required: ['name'],
	},
	readOnly: true,
	execute(args, ctx) {
		return managedServiceStatus(
			text(args, 'name'),
			ctx.workspaceRoot || projectRoot(ctx.cwd || process.cwd()),
		);
	},
});
registerTool('service_logs', {
	description:
		'Read recent output from one named workspace-scoped managed service log.',
	parameters: {
		type: 'object',
		properties: {
			name: {type: 'string'},
			lines: {type: 'integer', minimum: 1, maximum: 1000},
		},
		required: ['name'],
	},
	readOnly: true,
	execute(args, ctx) {
		const rawLines = args.lines;
		const lines =
			typeof rawLines === 'number' && Number.isFinite(rawLines)
				? rawLines
				: 100;
		return managedServiceLogs(
			text(args, 'name'),
			ctx.workspaceRoot || projectRoot(ctx.cwd || process.cwd()),
			lines,
		);
	},
});
registerTool('service_restart', {
	description:
		'Restart the exact named workspace-scoped managed service without touching other workspaces.',
	parameters: {
		type: 'object',
		properties: {name: {type: 'string'}},
		required: ['name'],
	},
	execute(args, ctx) {
		return restartManagedService(
			text(args, 'name'),
			ctx.workspaceRoot || projectRoot(ctx.cwd || process.cwd()),
		);
	},
});
registerTool('service_stop', {
	description:
		'Stop the exact named workspace-scoped managed service and its complete systemd control group.',
	parameters: {
		type: 'object',
		properties: {name: {type: 'string'}},
		required: ['name'],
	},
	execute(args, ctx) {
		return stopManagedService(
			text(args, 'name'),
			ctx.workspaceRoot || projectRoot(ctx.cwd || process.cwd()),
		);
	},
});

registerTool('enter_worktree', {
	description:
		'Create and enter an isolated git worktree, or enter an existing registered ' +
		'worktree. New worktrees stay under the repository .bobonyo/worktrees directory.',
	parameters: {
		type: 'object',
		properties: {
			name: {type: 'string', description: 'New branch/worktree name.'},
			path: {
				type: 'string',
				description:
					'Existing worktree path, or optional path for the new worktree.',
			},
			base: {
				type: 'string',
				description:
					'Git revision used as the new branch base. Defaults to HEAD.',
			},
		},
	},
	async execute(args, ctx) {
		const result = enterWorktree(ctx.cwd || process.cwd(), {
			name: text(args, 'name'),
			path: text(args, 'path'),
			base: text(args, 'base'),
		});
		if (result.cwd) ctx.onCwdChange?.(result.cwd);
		return result.content;
	},
});
registerTool('exit_worktree', {
	description:
		'Leave the current linked worktree and return to the repository main worktree. ' +
		'This does not delete the linked worktree or its branch.',
	parameters: {type: 'object', properties: {}},
	async execute(_args, ctx) {
		const result = exitWorktree(ctx.cwd || process.cwd());
		if (result.cwd) ctx.onCwdChange?.(result.cwd);
		return result.content;
	},
});

registerTool('list_worktrees', {
	description:
		'Inspect registered git worktrees, showing current location, branch, clean/dirty state, and lock/prune status.',
	parameters: {type: 'object', properties: {}},
	readOnly: true,
	execute(_args, ctx) {
		return inspectWorktrees(ctx.cwd || process.cwd()).content;
	},
});
registerTool('remove_worktree', {
	description:
		'Remove a registered non-main git worktree only when it is clean and its branch is merged into HEAD. ' +
		'Optionally delete the merged branch. Never forces removal or discards changes.',
	parameters: {
		type: 'object',
		properties: {
			path: {type: 'string', description: 'Registered worktree path.'},
			delete_branch: {
				type: 'boolean',
				description: 'Also delete the merged local branch.',
			},
		},
		required: ['path'],
	},
	execute(args, ctx) {
		return removeWorktree(ctx.cwd || process.cwd(), {
			path: text(args, 'path'),
			deleteBranch: args.delete_branch === true,
		}).content;
	},
});

registerTool('apply_patch', {
	description:
		'Apply one atomic file-oriented patch. Patch text must use *** Begin Patch / ' +
		'*** End Patch with Add File, Update File, Delete File, and optional Move to sections. ' +
		'All changes are verified before writing and rolled back if application fails.',
	parameters: {
		type: 'object',
		properties: {
			patchText: {
				type: 'string',
				description:
					'Complete apply_patch text including Begin Patch and End Patch markers.',
			},
		},
		required: ['patchText'],
	},
	execute(args, ctx) {
		const patchText = text(args, 'patchText');
		if (!patchText) return 'Error: apply_patch requires patchText.';
		const cwd = ctx.cwd || process.cwd();
		try {
			for (const path of applyPatchPaths(cwd, patchText)) {
				snapshotFileBeforeMutation(path);
			}
			return executeApplyPatch(cwd, patchText);
		} catch (error) {
			return `Error: apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});

registerTool('write_file', {
	description:
		'Create or fully overwrite a file with new content. For small edits prefer edit_file so the change stays targeted and visible as a diff.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or cwd-relative path of the file to write.',
			},
			content: {
				type: 'string',
				description: 'The full new file content.',
			},
		},
		required: ['path', 'content'],
	},
	async execute(args, ctx) {
		const requested = text(args, 'path') || 'scratch/mock-write.txt';
		const cwd = ctx.cwd || process.cwd();
		const path = resolve(cwd, requested);
		if (
			!(await requestExternalWriteAccess(path, ctx, `write_file ${requested}`))
		) {
			return `Permission denied: external folder remains read-only: ${externalGrantRoot(path)}`;
		}
		const body = text(args, 'content') ?? '';
		await Bun.write(path, body);
		return `Wrote ${body.length} chars to ${requested}\n${body}`;
	},
});

registerTool('string_replace', {
	description:
		'Replace one exact substring in a file with new text (a targeted edit, ' +
		'keeps the rest of the file intact).',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or cwd-relative path of the file to edit.',
			},
			old_string: {
				type: 'string',
				description:
					'The exact existing text to replace (must match verbatim).',
			},
			new_string: {
				type: 'string',
				description: 'The replacement text.',
			},
		},
		required: ['path', 'old_string', 'new_string'],
	},
	async execute(args) {
		const path = text(args, 'path') || 'scratch/mock-edit.txt';
		const oldString = text(args, 'old_string') ?? '';
		const newString = text(args, 'new_string') ?? '';
		const exists = await Bun.file(path).exists();
		let current = exists ? await Bun.file(path).text() : oldString;
		if (!current.includes(oldString)) {
			// Empty/legacy target (a previous mock run deleted the content):
			// seed from old_string so the replacement is deterministic.
			if (current.trim() === '') current = oldString;
			else {
				return `Error: '${oldString}' not found in ${path}`;
			}
		}
		const count = current.split(oldString).length - 1;
		const updated = current.split(oldString).join(newString);
		await Bun.write(path, updated);
		// Report the ABSOLUTE line of the FIRST occurrence in the OLD file so
		// the preview can number the diff against the real file, never the
		// snippet-relative 1..N the raw old/new strings would produce.
		const baseLine = current.split(oldString, 1)[0]?.split('\n').length ?? 1;
		return `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${path} (at line ${baseLine})\n${updated}`;
	},
});

registerTool('edit_file', {
	description:
		'Replace one exact, unique substring in a workspace file. Fails when the target is missing or ambiguous; use write_file only for full-file replacement.',
	parameters: {
		type: 'object',
		properties: {
			path: {type: 'string'},
			old_string: {type: 'string'},
			new_string: {type: 'string'},
		},
		required: ['path', 'old_string', 'new_string'],
	},
	async execute(args, ctx) {
		const requested = text(args, 'path');
		const cwd = ctx.cwd || process.cwd();
		const workspaceRoot = ctx.workspaceRoot || cwd;
		const path = resolve(cwd, requested);
		if (
			!pathWithinWorkspace(path, workspaceRoot) &&
			!(await requestExternalWriteAccess(
				path,
				ctx,
				`string_replace ${requested}`,
			))
		) {
			return `Permission denied: external folder remains read-only: ${externalGrantRoot(path)}`;
		}
		const file = Bun.file(path);
		if (!(await file.exists())) return `Error: ${requested} does not exist`;
		const current = await file.text();
		const oldString = text(args, 'old_string');
		const newString = text(args, 'new_string');
		const count = oldString ? current.split(oldString).length - 1 : 0;
		if (count !== 1)
			return `Error: old_string matched ${count} times in ${requested}; expected exactly 1.`;
		const baseLine = current.split(oldString, 1)[0]?.split('\n').length ?? 1;
		const updated = current.replace(oldString, newString);
		await Bun.write(path, updated);
		return `Replaced 1 occurrence in ${requested} (at line ${baseLine})\n${updated}`;
	},
});

registerTool('diff_edit', {
	description:
		'Apply a unified diff (patch -p1 --forward) to the repository. Use for ' +
		'multi-hunk edits where the change should be shown as a diff.',
	parameters: {
		type: 'object',
		properties: {
			diff: {
				type: 'string',
				description:
					'A unified diff (---/+++ headers with @@ hunks) applied with patch -p1.',
			},
			cwd: {
				type: 'string',
				description: 'Working directory to apply the patch in (default: cwd).',
			},
		},
		required: ['diff'],
	},
	async execute(args) {
		const diff = text(args, 'diff') ?? '';
		const cwd = text(args, 'cwd') || process.cwd();
		const result = Bun.spawnSync(['patch', '-p1', '--forward'], {
			cwd,
			stdin: new TextEncoder().encode(diff),
		});
		const out = (result.stdout?.toString() ?? '').trim();
		const err = (result.stderr?.toString() ?? '').trim();
		return `EXIT_CODE: ${result.exitCode}\n${out}${err ? `\n${err}` : ''}\n${diff}`;
	},
});

registerTool('delete_file', {
	description:
		'Permanently delete a single file. Prefer this over `rm` in bash: ' +
		'deletions flow through the harness (approval in normal mode, and ' +
		'the hook point for file-protection rules) instead of a raw shell ' +
		'command. Directories are NOT supported — use bash for those.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute or cwd-relative path of the file to delete.',
			},
		},
		required: ['path'],
	},
	async execute(args, ctx) {
		const path = text(args, 'path') || 'scratch/mock-delete.txt';
		const cwd = ctx.cwd || process.cwd();
		const workspaceRoot = ctx.workspaceRoot || cwd;
		const absolute = resolve(cwd, path);
		if (!pathInsideWorkspace(absolute, workspaceRoot)) {
			if (!sessionExternalDeleteGrants.has(absolute)) {
				const grant = await requestExternalWriteAccess(
					absolute,
					ctx,
					`delete_file ${path}`,
				);
				if (!grant) {
					return `Permission denied: external folder remains read-only: ${externalGrantRoot(absolute)}`;
				}
			}
		}
		try {
			const stat = statSync(absolute);
			if (stat.isDirectory()) {
				return `Error: ${path} is a directory — delete_file only removes files (use bash for directories).`;
			}
			unlinkSync(absolute);
			return `Deleted ${path}`;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return `Error: ${path} does not exist`;
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});

registerTool('glob', {
	description:
		'Find files recursively in the workspace using a glob pattern. Results are sorted, bounded, skip symlinks, and hide .git/node_modules by default.',
	parameters: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'Glob pattern, for example *.ts or a recursive pattern.',
			},
			path: {
				type: 'string',
				description: 'Optional workspace-relative search root.',
			},
			include_hidden: {
				type: 'boolean',
				description: 'Include hidden files and directories. Defaults to false.',
			},
			include_directories: {type: 'boolean'},
			limit: {type: 'integer', minimum: 1, maximum: 5000},
		},
		required: ['pattern'],
	},
	readOnly: true,
	execute(args, ctx) {
		try {
			return globWorkspace({
				cwd: ctx.cwd || process.cwd(),
				pattern: text(args, 'pattern'),
				path: text(args, 'path') || undefined,
				includeHidden: args.include_hidden === true,
				includeDirectories: args.include_directories === true,
				limit: Number(args.limit) || undefined,
			});
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('grep', {
	description:
		'Search text recursively in workspace files using a regular expression or literal pattern. Supports glob filtering, context lines, bounded results, and skips binary/oversized files.',
	parameters: {
		type: 'object',
		properties: {
			pattern: {type: 'string'},
			path: {
				type: 'string',
				description: 'Optional workspace-relative search root.',
			},
			file_pattern: {
				type: 'string',
				description: 'Optional file glob, for example *.ts.',
			},
			literal: {type: 'boolean'},
			case_sensitive: {type: 'boolean'},
			include_hidden: {type: 'boolean'},
			context: {type: 'integer', minimum: 0, maximum: 10},
			limit: {type: 'integer', minimum: 1, maximum: 5000},
		},
		required: ['pattern'],
	},
	readOnly: true,
	execute(args, ctx) {
		try {
			return grepWorkspace({
				cwd: ctx.cwd || process.cwd(),
				pattern: text(args, 'pattern'),
				path: text(args, 'path') || undefined,
				filePattern: text(args, 'file_pattern') || undefined,
				literal: args.literal === true,
				caseSensitive: args.case_sensitive === true,
				includeHidden: args.include_hidden === true,
				context: Number(args.context) || 0,
				limit: Number(args.limit) || undefined,
			});
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('web_search', {
	description:
		'Search the public web for current information. Returns source titles, URLs, ' +
		'and concise excerpts when the configured provider supports native web search.',
	parameters: {
		type: 'object',
		properties: {
			query: {type: 'string', description: 'Focused search query.'},
		},
		required: ['query'],
	},
	readOnly: true,
	async execute(args) {
		const query = text(args, 'query').trim();
		if (!query) return 'Error: web_search requires a query.';
		try {
			const results = await executeNativeWebSearch(query);
			if (results !== null) {
				const fallback = resolveWebSearchFallback();
				if (fallback) {
					appendInfo(
						`  ✦ WebSearch fallback: ${fallback.model} searched → ` +
							`${activeEndpoint().model} responds`,
					);
				}
				return results;
			}
			return 'Error: no native web-search provider is configured. Configure Settings → Capabilities → Web search model.';
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('fetch_url', {
	description:
		'Fetch one public HTTP(S) URL and return bounded text content. Redirects are ' +
		'followed, binary bodies are rejected, and responses are capped at 2 MiB.',
	parameters: {
		type: 'object',
		properties: {
			url: {type: 'string', description: 'Absolute http:// or https:// URL.'},
		},
		required: ['url'],
	},
	readOnly: true,
	async execute(args) {
		const raw = text(args, 'url').trim();
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return 'Error: fetch_url requires a valid absolute URL.';
		}
		try {
			return await fetchPublicText(url);
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('list_mcp_resources', {
	description: 'List resources exposed by configured MCP servers.',
	parameters: {type: 'object', properties: {server_id: {type: 'string'}}},
	readOnly: true,
	async execute(args) {
		try {
			return await listMCPResources(text(args, 'server_id') || undefined);
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('list_mcp_resource_templates', {
	description:
		'List parameterized resource templates exposed by configured MCP servers.',
	parameters: {type: 'object', properties: {server_id: {type: 'string'}}},
	readOnly: true,
	async execute(args) {
		try {
			return await listMCPResourceTemplates(
				text(args, 'server_id') || undefined,
			);
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('read_mcp_resource', {
	description:
		'Read one MCP resource by server id and URI. Text is returned directly; binary blobs are summarized.',
	parameters: {
		type: 'object',
		properties: {server_id: {type: 'string'}, uri: {type: 'string'}},
		required: ['server_id', 'uri'],
	},
	readOnly: true,
	async execute(args) {
		try {
			return await readMCPResource(text(args, 'server_id'), text(args, 'uri'));
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	},
});
registerTool('command', {
	description:
		'Load a custom slash command as adaptable workflow guidance. Use when the ' +
		'user asks you to run /command-name now or later in a broader request. ' +
		'Read and interpret the command before acting; user intent and repository ' +
		'context override conflicting defaults. This tool does not execute the ' +
		'workflow itself.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Command name without leading slash.',
			},
			arguments: {
				type: 'string',
				description: 'Raw user arguments or purpose for this invocation.',
			},
		},
		required: ['name'],
	},
	readOnly: true,
	execute(args) {
		const name = text(args, 'name').replace(/^\//, '');
		const rawArgs = text(args, 'arguments');
		const command = loadCustomCommands().find(
			candidate => candidate.name.toLowerCase() === name.toLowerCase(),
		);
		if (!command) return `Command /${name} not found.`;
		const tokens = parseCommandArguments(rawArgs);
		const guidance = expandCommandPrompt({
			body: command.body,
			rawArgs,
			spec: command.arguments,
			tokens,
		});
		return buildCommandInvocationPrompt({
			name: command.name,
			description: command.description,
			userRequest: rawArgs,
			guidance,
		});
	},
});

registerTool('skill', {
	description:
		'Load a skill (a markdown instruction bundle) into context. Skills are ' +
		'listed in the SYSTEM prompt under AVAILABLE SKILLS — pick the one that ' +
		'matches the task (e.g. hilinga-prod-ops for production server work) and ' +
		'call this with its exact name before acting on that domain. Before calling, ' +
		'check conversation context: if the same skill instructions are already ' +
		'present, reuse them and do not call this tool again. Reload only after ' +
		'compaction removed those instructions, in a new conversation, or when fresh ' +
		'file contents are required.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Exact skill name from the AVAILABLE SKILLS list.',
			},
			arguments: {
				type: 'string',
				description: 'Raw user purpose or arguments for this skill.',
			},
		},
		required: ['name'],
	},
	execute(args) {
		const name = text(args, 'name') || 'unknown';
		const path = text(args, 'path') || `<${name}>`;
		const rawArgs = text(args, 'arguments');
		const skill = loadSkills().find(
			candidate => candidate.name.toLowerCase() === name.toLowerCase(),
		);
		if (skill) {
			return buildCommandInvocationPrompt({
				name: skill.name,
				description: skill.description,
				userRequest: rawArgs,
				guidance: expandCommandPrompt({
					body: skill.body,
					rawArgs,
					spec: [],
					tokens: parseCommandArguments(rawArgs),
				}),
			});
		}
		// Path-based fallback: read the md file directly when it exists.
		try {
			if (path.startsWith('<')) throw new Error('no path');
			const content = readFileSync(path, 'utf8');
			return `Loaded skill ${name} from ${path}\n${content.trim()}`;
		} catch {
			return `Loaded skill ${name} from ${path}`;
		}
	},
});

registerTool('check_skill', {
	description:
		'Check whether a skill exists and is valid (no undeclared template ' +
		'variables). Use only when availability or validity is uncertain. Do not ' +
		'call routinely before or after loading a known skill, and do not use it to ' +
		'reload instructions already present in conversation context.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Skill name to validate.',
			},
		},
		required: ['name'],
	},
	execute(args) {
		const name = text(args, 'name') || 'unknown';
		const skill = loadSkills().find(
			candidate => candidate.name.toLowerCase() === name.toLowerCase(),
		);
		if (!skill) {
			return `Skill ${name} not found.`;
		}
		const issues = lintBody(skill.body, []);
		return issues.length === 0
			? `Skill ${name} is valid (${skill.source}).`
			: `Skill ${name} has undeclared template vars: ${issues.join(', ')}`;
	},
});

registerTool('review_changes', {
	description:
		'Run parallel read-only review subagents before creating or releasing a PR. ' +
		'Use diff-aware project routing when configured; `all` runs every review-* agent.',
	parameters: {
		type: 'object',
		properties: {
			reviewers: {
				type: 'array',
				items: {type: 'string'},
				description:
					'Reviewer agent names; overrides project diff-aware routing when set.',
			},
			base: {type: 'string', description: 'Base ref, for example origin/main.'},
			all: {
				type: 'boolean',
				description:
					'Run every configured reviewer, bypassing project routing.',
			},
		},
	},
	readOnly: true,
	async execute(args, ctx) {
		const configured = loadSubagentNames();
		const base = text(args, 'base') || 'origin/main';
		const requested = Array.isArray(args.reviewers)
			? args.reviewers.map(String).filter(Boolean)
			: undefined;
		const cwd = ctx.cwd ?? process.cwd();
		const root = projectRoot(cwd);
		const changedFiles = requested ? [] : changedReviewFiles(root, base);
		const routing = requested ? undefined : findReviewRoutingConfig(cwd);
		const plan: Pick<ReviewRoutingPlan, 'reviewers' | 'mode'> = requested
			? {
					reviewers: [...new Set(requested)].filter(name =>
						configured.includes(name),
					),
					mode: 'all',
				}
			: changedFiles
				? planReviewers(
						configured,
						routing
							? scopeReviewPaths(changedFiles, root, routing.configDir)
							: changedFiles,
						routing?.config,
						args.all === true,
					)
				: {reviewers: configured, mode: 'all'};
		const reviewers = plan.reviewers;
		if (reviewers.length === 0) {
			return 'REVIEW_UNAVAILABLE: no review-* agents configured.';
		}
		const planText = requested
			? `REVIEW_PLAN: explicit reviewers: ${reviewers.join(', ')}`
			: changedFiles
				? `REVIEW_PLAN: ${plan.mode} reviewers: ${reviewers.join(', ')}\nChanged files: ${changedFiles.join(', ') || '(none)'}`
				: `REVIEW_PLAN: all reviewers (could not resolve diff against ${base})`;
		const batchKey = reviewBatchKey({
			graphId: ctx.workGraphId,
			sessionId: ctx.sessionId,
			root,
			base,
			reviewers,
			changedFiles,
		});
		const existingBatch = reviewBatchPromises.get(batchKey);
		if (existingBatch) return existingBatch;
		let resolveBatch!: (value: string) => void;
		let rejectBatch!: (reason?: unknown) => void;
		const batchPromise = new Promise<string>((resolve, reject) => {
			resolveBatch = resolve;
			rejectBatch = reject;
		});
		reviewBatchPromises.set(batchKey, batchPromise);
		if (reviewBatchPromises.size > 100) {
			reviewBatchPromises.delete(reviewBatchPromises.keys().next().value!);
		}
		try {
			const live = new Map<string, string>();
			const render = () =>
				[...live.entries()]
					.map(([name, output]) => {
						const status = output.startsWith('@@DONE@@')
							? 'completed'
							: 'running';
						const text =
							output.replace(/^@@DONE@@\n?/, '').trim() || 'Working…';
						return `✦ Ran agent:${name}(review ${name} findings) ${status}\n  └  ${text}`;
					})
					.join('\n');
			const results = await Promise.all(
				reviewers.map(async name => {
					const id = `review:${name}:${Date.now()}:${Math.random()}`;
					logSubagentEvent({
						event: 'started',
						sessionId: ctx.sessionId,
						agentId: id,
						agentName: name,
						detail: 'review current git diff',
					});
					const attempt = agentSignal(id, ctx.signal);
					const signal = attempt.signal;
					const generation = attempt.generation;
					setActiveAgents(prev => prev + 1);
					live.set(name, '');
					setActiveAgentRuns(prev => {
						const run = {
							id,
							generation,
							graphId: ctx.workGraphId,
							name,
							description: `Review ${name} findings in current diff`,
							displayLabel: nextAgentDisplayLabel(
								`Review ${name} findings in current diff`,
								prev.filter(row => row.status === 'running'),
							),
							output: '',
							transcript: [],
							streaming: '',
							history: [],
							tasks: [],
							status: 'running' as const,
							startedAt: Date.now(),
							tokensUsed: 0,
							lastProgressAt: Date.now(),
						};
						return [...prev, run];
					});
					ctx.onProgress?.(render());
					let incomplete = false;
					try {
						const result = await runSubagent(
							name,
							`Review current git diff against ${base}. Read-only. Return ` +
								'REVIEW_PASSED if no blockers, otherwise REVIEW_FINDINGS with every ' +
								'finding including file and line. Do not edit, commit, push, or create a PR.',
							update => {
								live.set(name, update.tail);
								setActiveAgentRuns(prev =>
									prev.map(row =>
										row.id === id
											? {
													...row,
													graphId: ctx.workGraphId,
													output: update.tail,
													transcript: update.transcript,
													streaming: update.streaming,
													history: update.history ?? row.history,
													tokensUsed: update.tokensUsed,
													lastProgressAt: Date.now(),
												}
											: row,
									),
								);
								ctx.onProgress?.(render());
							},
							signal,
							undefined,
							undefined,
							ctx,
							id,
						);
						incomplete = subagentResultIsIncomplete(result);
						logSubagentEvent({
							event: 'finished',
							sessionId: ctx.sessionId,
							agentId: id,
							agentName: name,
							status: incomplete ? 'incomplete' : 'completed',
						});
						if (incomplete) {
							setActiveAgentRuns(prev =>
								prev.map(row =>
									row.id === id
										? {...row, status: 'incomplete', finishedAt: Date.now()}
										: row,
								),
							);
						}
						live.set(name, `@@DONE@@\n${result}`);
						ctx.onProgress?.(render());
						appendMessage({
							role: 'tool',
							content: result,
							toolId: `${ctx.toolCallId ?? 'review'}:${name}`,
							tool: {
								name: 'agent',
								detail: `agent:${name}(review current git diff)`,
								output: result,
							},
						});
						return `## ${name}\n${result}`;
					} catch (error) {
						const detail =
							error instanceof Error ? error.message : String(error);
						logSubagentEvent({
							event: 'error',
							sessionId: ctx.sessionId,
							agentId: id,
							agentName: name,
							detail,
						});
						live.set(name, `@@DONE@@\nREVIEW_ERROR: ${detail}`);
						ctx.onProgress?.(render());
						setActiveAgentRuns(prev =>
							prev.map(row =>
								row.id === id
									? {...row, status: 'error', finishedAt: Date.now()}
									: row,
							),
						);
						return `## ${name}\nREVIEW_ERROR: ${detail}`;
					} finally {
						attempt.dispose();
						activeAgentControllers.delete(id);
						setActiveAgentRuns(prev =>
							prev.slice(-20).map(row =>
								row.id === id && row.status === 'running'
									? {
											...row,
											status: incomplete ? 'incomplete' : 'completed',
											finishedAt: Date.now(),
										}
									: row,
							),
						);
						setActiveAgents(prev => Math.max(0, prev - 1));
					}
				}),
			);
			const output = `${planText}\n\n${results.join('\n\n')}`;
			resolveBatch(output);
			return output;
		} catch (error) {
			reviewBatchPromises.delete(batchKey);
			rejectBatch(error);
			throw error;
		}
	},
});
async function executeAgentRun(
	id: string,
	subagentType: string,
	description: string,
	history: ChatMessageLike[] | undefined,
	prompt: string,
	ctx: ToolContext,
	retrieved: boolean,
	detached = false,
): Promise<string> {
	logSubagentEvent({
		event: history ? 'followup_started' : 'started',
		sessionId: ctx.sessionId,
		agentId: id,
		agentName: subagentType,
		detail: description,
	});
	// Background agents outlive the model turn that launched them. Inherit
	// session metadata, not its AbortSignal; Esc on the main turn must not
	// silently kill detached work.
	const attempt = agentSignal(id, detached ? undefined : ctx.signal);
	const signal = attempt.signal;
	const generation = attempt.generation;
	const graphId =
		ctx.workGraphId ?? `session:${ctx.sessionId ?? 'unknown'}:agents`;
	const nodeId = `agent-node:${id}:${generation}`;
	createWorkGraph(graphId, ctx.sessionId ?? 'unknown', description);
	upsertWorkNode({
		id: nodeId,
		graphId,
		kind: 'subagent',
		status: 'running',
		title: description,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
	recordWorkEvent(`${nodeId}:started`, graphId, 'started', nodeId, {
		agentId: id,
		subagentType,
	});
	let finalStatus: 'completed' | 'incomplete' | 'cancelled' | 'error' =
		'completed';
	let finalOutput = '';
	setActiveAgents(prev => prev + 1);
	if (history) {
		setActiveAgentRuns(prev =>
			prev.map(row =>
				row.id === id
					? {
							...row,
							generation,
							status: 'running',
							startedAt: Date.now(),
							tokensUsed: 0,
							streaming: '',
							output: `Follow-up: ${prompt}`,
							retrieved,
						}
					: row,
			),
		);
	} else {
		setActiveAgentRuns(prev => {
			const run = {
				id,
				graphId,
				generation,
				name: subagentType,
				description,
				displayLabel: nextAgentDisplayLabel(
					description,
					prev.filter(row => row.status === 'running'),
				),
				output: '',
				transcript: [],
				streaming: '',
				history: [],
				tasks: [],
				status: 'running' as const,
				startedAt: Date.now(),
				tokensUsed: 0,
				lastProgressAt: Date.now(),
				retrieved,
			};
			return [...prev, run];
		});
	}
	(ctx.onAgentProgress ?? ctx.onStateChange)?.();
	try {
		const memoryKey =
			subagentType === 'general'
				? undefined
				: `${ctx.cwd ?? process.cwd()}:${subagentType}:${researchMemoryKey(description)}`;
		const inputHash = ctx.cwd ? researchInputHash(ctx.cwd) : undefined;
		const priorFinding = memoryKey
			? findResearchMemory('project', memoryKey, inputHash)
			: undefined;
		const effectivePrompt = priorFinding
			? `${prompt}\n\nPrior durable exploration finding from this project:\n${priorFinding.text}\n\nUse it as a starting point. Verify only changed or unresolved parts; do not repeat unchanged exploration.`
			: prompt;
		const result = await runSubagent(
			subagentType,
			description,
			update => {
				setActiveAgentRuns(prev =>
					prev.map(row => {
						if (row.id !== id || row.generation !== generation) return row;
						return {
							...row,
							output: update.tail,
							transcript: update.transcript,
							streaming: update.streaming,
							history: update.history ?? row.history,
							tokensUsed: update.tokensUsed,
							lastProgressAt: Date.now(),
						};
					}),
				);
				(ctx.onAgentProgress ?? ctx.onStateChange)?.();
			},
			signal,
			history,
			effectivePrompt,
			ctx,
			id,
		);
		if (memoryKey && result.trim()) {
			saveResearchMemory({
				id: `research:${memoryKey}`,
				scope: 'project',
				key: memoryKey,
				text: boundedResearchText(result),
				sourceNodeId: nodeId,
				inputHash,
				createdAt: priorFinding?.createdAt ?? Date.now(),
				updatedAt: Date.now(),
			});
		}
		if (subagentResultIsIncomplete(result)) finalStatus = 'incomplete';
		finalOutput = result;
		return result;
	} catch (error) {
		const status =
			error instanceof Error && error.name === 'AbortError'
				? 'cancelled'
				: 'error';
		finalStatus = status;
		finalOutput = error instanceof Error ? error.message : String(error);
		setActiveAgentRuns(prev =>
			prev.map(row =>
				row.id === id && row.generation === generation ? {...row, status} : row,
			),
		);
		logSubagentEvent({
			event: status,
			sessionId: ctx.sessionId,
			agentId: id,
			agentName: subagentType,
			detail: error instanceof Error ? error.message : String(error),
		});
		ctx.onStateChange?.();
		notifyAgentStatus(id);
		throw error;
	} finally {
		attempt.dispose();
		if (activeAgentGenerations.get(id) === generation) {
			activeAgentControllers.delete(id);
		}
		setActiveAgentRuns(prev =>
			prev.slice(-20).map(row =>
				row.id === id &&
				row.generation === generation &&
				row.status === 'running'
					? {
							...row,
							status: finalStatus,
							streaming: '',
							finishedAt: Date.now(),
						}
					: row,
			),
		);
		logSubagentEvent({
			event: 'finished',
			sessionId: ctx.sessionId,
			agentId: id,
			agentName: subagentType,
			status: finalStatus,
		});
		upsertWorkNode({
			id: nodeId,
			graphId,
			kind: 'subagent',
			status:
				finalStatus === 'error'
					? 'failed'
					: finalStatus === 'cancelled'
						? 'cancelled'
						: 'completed',
			title: description,
			result: finalOutput,
			metadata: {finalStatus},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		recordWorkEvent(`${nodeId}:finished`, graphId, 'finished', nodeId, {
			status: finalStatus,
		});
		setActiveAgents(prev => Math.max(0, prev - 1));
		ctx.onStateChange?.();
		notifyAgentStatus(id);
		if (detached) {
			ctx.onDetachedComplete?.(
				'agent',
				id,
				finalStatus === 'error' ? 'failed' : finalStatus,
				finalOutput,
				ctx.backgroundOwner ?? 'user',
				ctx.workGraphId,
			);
		}
	}
}
registerTool('agent', {
	description:
		'Spawn a delegated subagent with its own conversation history. Foreground agents return their final response; background agents return an id and keep running in /ps. Use agent_message to continue an existing agent.',
	parameters: {
		type: 'object',
		properties: {
			description: {type: 'string', description: 'Task for the subagent.'},
			subagent_type: {
				type: 'string',
				description:
					'Defaults to general. Use explore only when explicitly requesting read-only research; otherwise choose a custom agent name.',
				default: 'general',
			},
			background: {
				type: 'boolean',
				description: 'Run asynchronously and return the agent id immediately.',
			},
		},
		required: ['description'],
	},
	readOnly: true,
	async execute(args, ctx) {
		const description =
			text(args, 'description') || 'investigate the repository';
		const background = args.background !== false;
		const requestedType = text(args, 'subagent_type');
		const subagentType =
			!requestedType || requestedType === 'explore' ? 'general' : requestedType;
		const id = `agent:${subagentType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const task = executeAgentRun(
			id,
			subagentType,
			description,
			undefined,
			description,
			ctx,
			!background,
			background,
		);
		if (background) {
			ctx.onDetachedWork?.('agent', id);
			void task.catch(() => {});
			return `Started background agent ${id}. Continue launching every agent requested in this batch. Do not report results until all launched agents settle; completion notifications will resume the parent once the batch is done.`;
		}
		return task;
	},
});
registerTool('agent_message', {
	description:
		'Send a revision to an existing subagent without replacing its task context. Running agents receive the message at the next safe model boundary; settled agents resume their preserved history and original work graph.',
	parameters: {
		type: 'object',
		properties: {
			agent_id: {type: 'string'},
			message: {type: 'string'},
			background: {type: 'boolean'},
		},
		required: ['agent_id', 'message'],
	},
	readOnly: true,
	async execute(args, ctx) {
		const id = text(args, 'agent_id');
		const message = text(args, 'message');
		const background = args.background !== false;
		const run = activeAgentRuns().find(row => row.id === id);
		if (!run) return `Error: agent ${id} not found.`;
		if (!message) return 'Error: agent_message requires a message.';
		if (run.status === 'running') {
			queueAgentMessage(id, message);
			return `Queued message for running agent ${id}. It will be delivered before the next model round.`;
		}
		const task = executeAgentRun(
			id,
			run.name,
			run.description,
			structuredClone(run.history),
			message,
			{...ctx, workGraphId: run.graphId ?? ctx.workGraphId},
			!background,
			background,
		);
		if (background) {
			void task.catch(() => {});
			return (
				`Continued background agent ${id}. ` +
				'Continue independent coordinator work. This message does not complete the user request; ' +
				"wait only for work that depends on this agent's result."
			);
		}
		return task;
	},
});
registerTool('agent_status', {
	description:
		'List up to twenty bounded delegated-agent status summaries, or provide agent_id for one agent status and full settled response. Use agent_history to retrieve older responses after resume, compaction, or pruning.',
	parameters: {type: 'object', properties: {agent_id: {type: 'string'}}},
	readOnly: true,
	execute(args) {
		const id = text(args, 'agent_id');
		const runs = id
			? activeAgentRuns().filter(row => row.id === id)
			: activeAgentRuns();
		if (runs.length === 0)
			return id ? `Agent ${id} not found.` : 'No delegated agents.';
		if (!id) {
			return [
				...runs
					.slice(-20)
					.map(
						run =>
							`${shortText(run.id, 160)} · ${run.status} · agent:${shortText(run.name, 80)}(${shortText(run.description, 120)})\n  └  ${shortText(run.output, 120) || 'No output yet.'}`,
					),
				`${runs.length > 20 ? `Showing latest 20 of ${runs.length} agents. ` : ''}Use agent_history to list saved agents or retrieve full responses by agent_id.`,
			].join('\n');
		}
		const observedIds = new Set(runs.map(run => run.id));
		setActiveAgentRuns(previous =>
			previous.map(run =>
				observedIds.has(run.id) && run.status !== 'running'
					? {...run, retrieved: true}
					: run,
			),
		);
		return runs
			.map(
				run =>
					`${run.id} · ${run.status} · agent:${run.name}(${run.description})\n  └  ${subagentResultText(run).trim() || 'Working…'}`,
			)
			.join('\n');
	},
});
registerTool('agent_history', {
	description:
		'Retrieve saved delegated-agent responses from this session without rerunning agents. Omit agent_id to list saved agents; provide it for full responses, including earlier follow-ups. Survives resume, compaction, and live-row pruning. Responses are historical evidence, not proof that the current diff passes review. Use offset/limit character pagination for long reports.',
	parameters: {
		type: 'object',
		properties: {
			agent_id: {type: 'string'},
			offset: {
				type: 'integer',
				minimum: 0,
				description: 'Zero-based character offset; defaults to 0.',
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 24000,
				description: 'Maximum characters; defaults to 12000.',
			},
		},
	},
	readOnly: true,
	execute(args, ctx) {
		const warnings: string[] = [];
		const output = formatSubagentResults(
			loadSubagentResults(ctx.sessionId, activeAgentRuns(), warnings),
			text(args, 'agent_id'),
			Number(args.offset),
			Number(args.limit),
		);
		return [output, ...warnings.map(warning => `[${warning}]`)].join('\n');
	},
});
registerTool('agent_wait', {
	description:
		'Wait efficiently for one delegated agent to leave its current status. ' +
		'Returns immediately if the agent is already settled; never poll agent_status in a loop.',
	parameters: {
		type: 'object',
		properties: {
			agent_id: {type: 'string'},
			timeout_ms: {
				type: 'number',
				description:
					'Maximum wait in milliseconds. Defaults to 30000, maximum 300000.',
			},
		},
		required: ['agent_id'],
	},
	readOnly: true,
	async execute(args) {
		const id = text(args, 'agent_id');
		const initial = activeAgentRuns().find(row => row.id === id);
		if (!initial) return `Agent ${id} not found.`;
		if (initial.status !== 'running') {
			setActiveAgentRuns(previous =>
				previous.map(row => (row.id === id ? {...row, retrieved: true} : row)),
			);
			return `${id} · ${initial.status}\n  └  ${subagentResultText(initial).trim() || 'No output.'}`;
		}
		const timeout = Math.max(
			1,
			Math.min(300_000, Math.floor(Number(args.timeout_ms) || 30_000)),
		);
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				agentStatusWaiters.get(id)?.delete(wake);
				resolve();
			}, timeout);
			const wake = () => {
				clearTimeout(timer);
				resolve();
			};
			const waiters = agentStatusWaiters.get(id) ?? new Set<() => void>();
			waiters.add(wake);
			agentStatusWaiters.set(id, waiters);
			const current = activeAgentRuns().find(row => row.id === id);
			if (current && current.status !== 'running') wake();
		});
		const run = activeAgentRuns().find(row => row.id === id);
		if (run && run.status !== 'running') {
			setActiveAgentRuns(previous =>
				previous.map(row => (row.id === id ? {...row, retrieved: true} : row)),
			);
		}
		return run
			? `${id} · ${run.status}\n  └  ${subagentResultText(run).trim() || 'Working…'}`
			: `Agent ${id} no longer exists.`;
	},
});

registerTool('agent_cancel', {
	description: 'Cancel one running delegated agent by id.',
	parameters: {
		type: 'object',
		properties: {agent_id: {type: 'string'}},
		required: ['agent_id'],
	},
	readOnly: true,
	execute(args) {
		const id = text(args, 'agent_id');
		if (!cancelActiveAgent(id)) return `Agent ${id} is not running.`;
		return `Cancelled agent ${id}.`;
	},
});
/** Default subagent personalities (parity: the reference/openclaude). */
export const SUBAGENT_TYPES: Record<
	string,
	{label: string; instruction: string}
> = {
	general: {
		label: 'General',
		instruction:
			'You are a general-purpose worker. Complete the assigned task using ' +
			'the available tools. Handle multi-step research, implementation, tests, commands, and verification. Read first, then act, and report concise results and blockers. Do not delegate again.',
	},
	explore: {
		label: 'Explore',
		instruction:
			'You are a read-only exploration agent. Investigate the repository and report ' +
			'findings concisely; cite files and lines you actually read. Do not edit, run mutating commands, or delegate again.',
	},
};

registerTaskTools(registerTool, text);
function loadSubagentNames(): string[] {
	return loadSubagents()
		.map(agent => agent.name)
		.filter(name => /^review(?:-|$)/i.test(name))
		.sort();
}
export interface SubagentProgressUpdate {
	tail: string;
	transcript: string[];
	streaming: string;
	history?: ChatMessageLike[];
	tokensUsed?: number;
}

export const SUBAGENT_PROGRESS_INTERVAL_MS = 500;

export function subagentTranscriptTail(lines: string[], maxLines = 6): string {
	return lines.slice(-Math.max(1, maxLines)).join('\n');
}

function firstUsefulLine(text: string): string {
	return (
		text
			.split('\n')
			.map(line => line.trim())
			.find(Boolean) ?? ''
	);
}

function shortText(text: string, max = 120): string {
	const line = firstUsefulLine(text).replace(/\s+/g, ' ');
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object'
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function formatSubagentToolCall(call: {
	id: string;
	name: string;
	arguments: string;
}): string {
	const args = safeParseToolArgs(call.arguments);
	const mockCall: MockToolCall = {
		id: call.id,
		name: call.name,
		arguments: args,
		rawArguments: call.arguments,
	};
	const detail = toolArgsSummary(mockCall);
	return detail
		? `${displayToolName(call.name)} ${detail}`
		: displayToolName(call.name);
}

export function formatSubagentStatusMessage(
	message: ChatMessageLike,
): string | null {
	if (message.role === 'tool') {
		const summary = shortText(message.content);
		return /^(?:Error:|REFUSED|EXIT_CODE:\s*[1-9])/i.test(summary)
			? `Failed: ${summary}`
			: null;
	}
	if (message.tool_calls?.length) {
		return message.tool_calls.map(formatSubagentToolCall).join('\n');
	}
	const text = shortText(message.content);
	if (!text) return null;
	return message.role === 'assistant' ? text : `Task: ${text}`;
}
async function runSubagent(
	subagentType: string,
	description: string,
	onProgress?: (update: SubagentProgressUpdate) => void,
	signal?: AbortSignal,
	initialHistory?: ChatMessageLike[],
	followupPrompt?: string,
	toolContext: ToolContext = {},
	agentId?: string,
): Promise<string> {
	// Custom agents (`.bobonyo/agents/*.md` or legacy `.nanocoder`, user
	// agents) carry their own
	// system prompt; built-ins fall back to the registry instructions.
	const agentGeneration = activeAgentRuns().find(
		row => row.id === agentId,
	)?.generation;
	const startHook = await runHooks({
		event: 'SubagentStart',
		agentName: subagentType,
		data: {description},
	});
	if (startHook.denied) throw new Error(startHook.denied);
	const customPrompt = subagentSystemPrompt(subagentType);
	const endpoint = subagentEndpoint(subagentType);
	const subagentModel =
		typeof endpoint === 'string'
			? endpoint
			: (endpoint?.model ?? activeEndpoint().model);
	let history: ChatMessageLike[] = initialHistory
		? [
				...initialHistory,
				{role: 'user', content: followupPrompt || description},
			]
		: [
				{
					role: 'user',
					content:
						`${
							customPrompt ||
							(SUBAGENT_TYPES[subagentType]?.instruction ??
								SUBAGENT_TYPES.general!.instruction)
						}

` + `Task: ${description}`,
				},
			];
	let transcript = initialHistory
		? [`Follow-up: ${followupPrompt || description}`]
		: [`Task: ${description}`];
	let tokensUsed = 0;
	let lastStreamingPublishAt = 0;
	const publish = (streamingText = '', force = true) => {
		const now = Date.now();
		if (
			!force &&
			streamingText.trim() &&
			now - lastStreamingPublishAt < SUBAGENT_PROGRESS_INTERVAL_MS
		) {
			return;
		}
		if (streamingText.trim()) lastStreamingPublishAt = now;
		const lines = streamingText.trim()
			? [...transcript, shortText(streamingText.trim())]
			: transcript;
		onProgress?.({
			tail: subagentTranscriptTail(lines),
			transcript: lines,
			streaming: streamingText.trim(),
			history: force ? structuredClone(history) : undefined,
			tokensUsed,
		});
	};
	publish();
	for (let round = 0; round < MAX_SUBAGENT_TOOL_ROUNDS; round++) {
		if (agentId) {
			logSubagentEvent({
				event: 'round_started',
				sessionId: toolContext.sessionId,
				agentId,
				agentName: subagentType,
				data: {round: round + 1},
			});
		}
		if (agentId) {
			const queued = drainAgentMessages(agentId);
			if (queued.length > 0) {
				history = [
					...history,
					...queued.map(content => ({role: 'user' as const, content})),
				];
				transcript = [
					...transcript,
					...queued.map(content => `Message: ${shortText(content)}`),
				];
				publish();
			}
		}
		const result = await streamChat(
			history,
			{
				// C10: stream the subagent's reasoning/text into the running row so
				// its per-call progress is visible while it works.
				onText: text => publish(text, false),
				onReasoning: () => {},
			},
			signal,
			toolCatalogForModel(subagentModel),
			undefined,
			undefined,
			undefined,
			endpoint,
		);
		tokensUsed += Number(result.usage?.total_tokens ?? 0) || 0;
		if (result.toolCalls.length === 0) {
			let finalText = result.text.trim() || 'Subagent produced no output.';
			if (agentId) {
				logSubagentEvent({
					event: 'round_finished',
					sessionId: toolContext.sessionId,
					agentId,
					agentName: subagentType,
					data: {round: round + 1, toolCalls: 0, final: true},
				});
			}
			transcript = [...transcript, shortText(finalText)];
			history = [...history, {role: 'assistant', content: finalText}];
			publish();
			const queued = agentId ? drainAgentMessages(agentId) : [];
			if (queued.length > 0) {
				history = [
					...history,
					...queued.map(content => ({role: 'user' as const, content})),
				];
				transcript = [
					...transcript,
					...queued.map(content => `Message: ${shortText(content)}`),
				];
				publish();
				continue;
			}
			await runHooks({
				event: 'SubagentStop',
				agentName: subagentType,
				data: {description, result: finalText},
			});
			if (agentId)
				finalText = archiveSubagentResponse(toolContext.sessionId, {
					id: agentId,
					name: subagentType,
					description,
					status: 'completed',
					output: finalText,
				});
			history = [
				...history.slice(0, -1),
				{role: 'assistant', content: finalText},
			];
			publish();
			if (agentId) {
				logSubagentEvent({
					event: 'final_response',
					sessionId: toolContext.sessionId,
					agentId,
					agentName: subagentType,
					detail: finalText,
				});
			}
			return finalText;
		}
		const assistantMessage: ChatMessageLike = {
			role: 'assistant',
			content: result.text,
			tool_calls: result.toolCalls.map(call => ({
				id: call.id,
				name: call.name,
				arguments: call.rawArguments,
			})),
		};
		const assistantSummary = formatSubagentStatusMessage(assistantMessage);
		if (assistantSummary) transcript = [...transcript, assistantSummary];
		history = [...history, assistantMessage];
		publish();
		for (const call of result.toolCalls) {
			if (agentId) {
				logSubagentEvent({
					event: 'tool_started',
					sessionId: toolContext.sessionId,
					agentId,
					agentName: subagentType,
					detail: call.name,
				});
			}
			const toolResult = await executeTool(call, {
				...toolContext,
				agentId,
				agentGeneration,
				signal,
				// A subagent's detached shell belongs to the subagent, not the
				// parent's foreground turn. Do not let its handoff callback break
				// the parent loop after the first long-running child command.
				onDetachedWork: undefined,
			});
			const toolMessage: ChatMessageLike = {
				role: 'tool',
				content: toolResult.content,
				tool_call_id: toolResult.tool_call_id,
			};
			const toolSummary = formatSubagentStatusMessage(toolMessage);
			if (toolSummary) transcript = [...transcript, toolSummary];
			history = [...history, toolMessage];
			publish();
			if (agentId) {
				logSubagentEvent({
					event: 'tool_finished',
					sessionId: toolContext.sessionId,
					agentId,
					agentName: subagentType,
					detail: call.name,
					data: {result: toolResult.content},
				});
			}
		}
		if (agentId) {
			logSubagentEvent({
				event: 'round_finished',
				sessionId: toolContext.sessionId,
				agentId,
				agentName: subagentType,
				data: {round: round + 1, toolCalls: result.toolCalls.length},
			});
		}
	}
	// Tool-heavy reviewers often spend more than one round on bookkeeping and
	// inspection. Do not manufacture a fake final response when the tool-round
	// budget is reached. Force one last tool-free report instead.
	if (agentId) {
		logSubagentEvent({
			event: 'finalization_started',
			sessionId: toolContext.sessionId,
			agentId,
			agentName: subagentType,
			data: {maxToolRounds: MAX_SUBAGENT_TOOL_ROUNDS},
		});
	}
	history = [...history, {role: 'user', content: SUBAGENT_FINALIZATION_PROMPT}];
	let finalization = '';
	try {
		const result = await streamChat(
			history,
			{
				onText: text => {
					finalization += text;
					publish(finalization, false);
				},
				onReasoning: () => {},
			},
			signal,
			[],
			undefined,
			undefined,
			undefined,
			endpoint,
		);
		finalization = result.text.trim() || finalization.trim();
	} catch (error) {
		if (agentId) {
			logSubagentEvent({
				event: 'finalization_error',
				sessionId: toolContext.sessionId,
				agentId,
				agentName: subagentType,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	let finalText =
		finalization ||
		`Subagent ${subagentType} reached its tool-round budget without a final report. ` +
			'Review the latest tool output and continue with agent_message.';
	if (agentId)
		finalText = archiveSubagentResponse(toolContext.sessionId, {
			id: agentId,
			name: subagentType,
			description,
			status: finalization ? 'completed' : 'incomplete',
			output: finalText,
		});
	transcript = [...transcript, shortText(finalText)];
	history = [...history, {role: 'assistant', content: finalText}];
	publish();
	if (agentId) {
		logSubagentEvent({
			event: 'finalization_finished',
			sessionId: toolContext.sessionId,
			agentId,
			agentName: subagentType,
			status: finalization ? 'completed' : 'incomplete',
			detail: finalText,
		});
	}
	return finalText;
}
