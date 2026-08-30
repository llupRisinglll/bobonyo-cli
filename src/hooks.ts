import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {configSearchDirs} from './project-paths';

export type HookEvent =
	| 'SessionStart'
	| 'SessionEnd'
	| 'UserPromptSubmit'
	| 'PreToolUse'
	| 'PostToolUse'
	| 'PreCompact'
	| 'PostCompact'
	| 'PermissionRequest'
	| 'SubagentStart'
	| 'SubagentStop'
	| 'Stop'
	| 'Notification';
interface HookAction {
	type?: 'command' | 'http' | 'prompt' | 'agent';
	command?: string;
	url?: string;
	prompt?: string;
	if?: string;
	timeout?: number;
	headers?: Record<string, string>;
	async?: boolean;
}
interface HookGroup {
	matcher?: string;
	hooks?: HookAction[];
}
interface HookSettings {
	hooks?: Partial<Record<HookEvent, HookGroup[]>>;
}
export interface HookInput {
	event: HookEvent;
	matcher?: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	prompt?: string;
	sessionSource?: 'startup' | 'resume' | 'clear' | 'compact';
	agentName?: string;
	message?: string;
	data?: Record<string, unknown>;
}
export interface HookResult {
	denied?: string;
	updatedInput?: Record<string, unknown>;
	additionalContext: string[];
	messages: string[];
}

interface HookSource {
	file: string;
	settings: HookSettings;
}

/** Bobonyo-owned hook sources using the shared Claude/Codex JSON shape. */
function hookFiles(cwd: string): string[] {
	return configSearchDirs(cwd).flatMap(dir => [
		join(dir, 'settings.json'),
		join(dir, 'hooks.json'),
	]);
}
function sources(): HookSource[] {
	const result: HookSource[] = [];
	for (const file of hookFiles(process.cwd())) {
		try {
			const settings = JSON.parse(readFileSync(file, 'utf8')) as HookSettings;
			result.push({file, settings});
		} catch {
			// Missing/corrupt Bobonyo settings never break the harness.
		}
	}
	return result;
}
function groups(event: HookEvent): Array<HookGroup & {source: string}> {
	return sources().flatMap(({file, settings}) =>
		(settings.hooks?.[event] ?? []).map(group => ({...group, source: file})),
	);
}
function regexMatches(pattern: string | undefined, value: string): boolean {
	if (!pattern) return true;
	try {
		return new RegExp(`^(?:${pattern})$`, 'i').test(value);
	} catch {
		return pattern
			.split('|')
			.some(entry => entry.toLowerCase() === value.toLowerCase());
	}
}
function conditionAccepts(
	condition: string | undefined,
	input: HookInput,
): boolean {
	if (!condition) return true;
	const match = /^([^()]+)\((.*)\)$/.exec(condition.trim());
	if (!match || !regexMatches(match[1], input.toolName ?? input.matcher ?? ''))
		return !match;
	const target =
		typeof input.toolInput?.command === 'string'
			? input.toolInput.command
			: JSON.stringify(input.toolInput ?? input.data ?? {});
	try {
		return new RegExp(match[2] ?? '', 'i').test(target);
	} catch {
		return false;
	}
}
function payload(input: HookInput): Record<string, unknown> {
	return {
		hook_event_name: input.event,
		tool_name: input.toolName,
		tool_input: input.toolInput,
		prompt: input.prompt,
		source: input.sessionSource,
		agent_name: input.agentName,
		message: input.message,
		cwd: process.cwd(),
		harness_pid: process.pid,
		...(input.data ?? {}),
	};
}
async function commandAction(
	action: HookAction,
	body: Record<string, unknown>,
): Promise<{text: string; exitCode: number}> {
	const proc = Bun.spawn(['bash', '-lc', action.command ?? 'true'], {
		cwd: process.cwd(),
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: process.env,
	});
	proc.stdin.write(JSON.stringify(body));
	proc.stdin.end();
	const timer = setTimeout(
		() => proc.kill('SIGTERM'),
		Math.max(100, (action.timeout ?? 10) * 1000),
	);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return {text: stdout.trim() || stderr.trim(), exitCode};
	} finally {
		clearTimeout(timer);
	}
}
async function httpAction(
	action: HookAction,
	body: Record<string, unknown>,
): Promise<{text: string; exitCode: number}> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		Math.max(100, (action.timeout ?? 10) * 1000),
	);
	try {
		const response = await fetch(action.url ?? '', {
			method: 'POST',
			headers: {'content-type': 'application/json', ...(action.headers ?? {})},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		return {
			text: (await response.text()).trim(),
			exitCode: response.ok ? 0 : 2,
		};
	} finally {
		clearTimeout(timer);
	}
}
function parseOutput(text: string): {
	denied?: string;
	updatedInput?: Record<string, unknown>;
	additionalContext?: string;
	message?: string;
} {
	if (!text) return {};
	try {
		const parsed = JSON.parse(text) as Record<string, any>;
		const output = parsed.hookSpecificOutput ?? parsed;
		return {
			...(output.permissionDecision === 'deny' || output.decision === 'block'
				? {
						denied:
							output.permissionDecisionReason ??
							output.reason ??
							'Blocked by hook.',
					}
				: {}),
			...(output.updatedInput && typeof output.updatedInput === 'object'
				? {updatedInput: output.updatedInput}
				: {}),
			...(typeof output.additionalContext === 'string'
				? {additionalContext: output.additionalContext}
				: {}),
			...(typeof output.message === 'string' ? {message: output.message} : {}),
		};
	} catch {
		return {message: text};
	}
}

export interface HookSummary {
	event: HookEvent;
	matcher: string;
	type: string;
	target: string;
	async: boolean;
	source: string;
}
export function listHooks(): HookSummary[] {
	const events: HookEvent[] = [
		'SessionStart',
		'SessionEnd',
		'UserPromptSubmit',
		'PreToolUse',
		'PostToolUse',
		'PreCompact',
		'PostCompact',
		'PermissionRequest',
		'SubagentStart',
		'SubagentStop',
		'Stop',
		'Notification',
	];
	return events.flatMap(event =>
		groups(event).flatMap(group =>
			(group.hooks ?? []).map(action => ({
				event,
				matcher: group.matcher ?? '*',
				type: action.type ?? 'command',
				target: action.command ?? action.url ?? action.prompt ?? '',
				async: action.async === true,
				source: group.source,
			})),
		),
	);
}

/** Run every Bobonyo hook for one lifecycle event. */
export async function runHooks(input: HookInput): Promise<HookResult> {
	const result: HookResult = {additionalContext: [], messages: []};
	const subject =
		input.toolName ??
		input.agentName ??
		input.sessionSource ??
		input.matcher ??
		input.event;
	for (const group of groups(input.event)) {
		if (!regexMatches(group.matcher, subject)) continue;
		for (const action of group.hooks ?? []) {
			if (!conditionAccepts(action.if, input)) continue;
			if (action.async) {
				void (
					action.type === 'http'
						? httpAction(action, payload(input))
						: commandAction(action, payload(input))
				).catch(() => {});
				continue;
			}
			let execution: {text: string; exitCode: number};
			if (action.type === 'http')
				execution = await httpAction(action, payload(input));
			else if (action.type === 'prompt' || action.type === 'agent') {
				// Prompt/agent hooks inject instructions into the next relevant model
				// context. This stays deterministic and avoids recursive hook-driven LLM calls.
				execution = {
					text: JSON.stringify({additionalContext: action.prompt ?? ''}),
					exitCode: 0,
				};
			} else execution = await commandAction(action, payload(input));
			const output = parseOutput(execution.text);
			if (output.updatedInput) result.updatedInput = output.updatedInput;
			if (output.additionalContext)
				result.additionalContext.push(output.additionalContext);
			if (output.message) result.messages.push(output.message);
			if (output.denied) result.denied = output.denied;
			if (execution.exitCode === 2 && !result.denied) {
				result.denied = execution.text || `Blocked by ${input.event} hook.`;
			}
			if (result.denied) return result;
		}
	}
	return result;
}

export async function runBashPreHooks(command: string): Promise<{
	command: string;
	description?: string;
}> {
	const result = await runHooks({
		event: 'PreToolUse',
		toolName: 'Bash',
		toolInput: {command},
	});
	if (result.denied) throw new Error(result.denied);
	return {
		command:
			typeof result.updatedInput?.command === 'string'
				? result.updatedInput.command
				: command,
		description:
			typeof result.updatedInput?.description === 'string'
				? result.updatedInput.description
				: undefined,
	};
}
export async function runBashPostHooks(
	command: string,
	toolResult?: string,
): Promise<void> {
	await runHooks({
		event: 'PostToolUse',
		toolName: 'Bash',
		toolInput: {command},
		data: toolResult === undefined ? undefined : {tool_result: toolResult},
	});
}
