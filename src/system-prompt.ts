import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {configDir} from './config';

/**
 * System-prompt customization (Settings → Behavior → System prompt). The
 * user picks a STYLE — the harness keeps its tool rules, the style only
 * shapes tone/workflow:
 *   default   → the built-in BoboNyo prompt
 *   opencode  → OpenCode-style: concise, small verifiable steps
 *   claudecode → Claude-Code-style: think before acting, tight replies
 *   codex     → Codex-style: blunt, verify your work
 *   custom    → reads (and seeds) a SYSTEM.md file in the config dir so the
 *               user can write their own prompt in any editor.
 */

export const SYSTEM_PROMPT_STYLES = [
	'default',
	'opencode',
	'claudecode',
	'codex',
	'custom',
] as const;
export type SystemPromptStyle = (typeof SYSTEM_PROMPT_STYLES)[number];

export function systemPromptPath(): string {
	return join(configDir(), 'SYSTEM.md');
}

export function loadCustomSystemPrompt(): string | null {
	try {
		const file = systemPromptPath();
		if (!existsSync(file)) return null;
		const body = readFileSync(file, 'utf8').trim();
		return body.length > 0 ? body : null;
	} catch {
		return null;
	}
}

/** Seed SYSTEM.md with a starting prompt when the custom style is chosen. */
export function seedCustomSystemPrompt(fallback: string): void {
	try {
		mkdirSync(configDir(), {recursive: true});
		const file = systemPromptPath();
		if (!existsSync(file)) {
			writeFileSync(file, `${fallback.trim()}\n`, 'utf8');
		}
	} catch {
		// read-only config dir: the custom option just falls back
	}
}

export const SYSTEM_PROMPT_PRESETS: Record<
	Exclude<SystemPromptStyle, 'default' | 'custom'>,
	string
> = {
	opencode:
		'You are BoboNyo, a terminal coding agent with an OpenCode-style ' +
		'workflow. Be concise and direct; prefer small, verifiable steps. ' +
		'Use tools for anything stateful (files, shell, git, web). ' +
		'Before each tool call, FIRST write one short line explaining what ' +
		'you are about to do and why; skip the text only when the call ' +
		'continues a goal you already explained.',
	claudecode:
		'You are BoboNyo, a terminal coding agent with a Claude-Code-style ' +
		'workflow. Think before acting, verify your work, and keep replies ' +
		'tight. Use tools for anything stateful (files, shell, git, web). ' +
		'Before each tool call, FIRST write one short line explaining what ' +
		'you are about to do and why; skip the text only when the call ' +
		'continues a goal you already explained.',
	codex:
		'You are BoboNyo, a terminal coding agent with a Codex-style ' +
		'workflow. Be blunt and a little snobbish — honesty matters more ' +
		'than pleasing the user, so call out weak ideas directly. Verify ' +
		'your work and use tools for anything stateful (files, shell, git, ' +
		'web). Before each tool call, FIRST write one short line explaining ' +
		'what you are about to do and why; skip the text only when the call ' +
		'continues a goal you already explained.',
};

export function resolveSystemPrompt(
	style: SystemPromptStyle,
	defaultPrompt: string,
): string {
	switch (style) {
		case 'custom':
			return loadCustomSystemPrompt() ?? defaultPrompt;
		case 'default':
			return defaultPrompt;
		default:
			return SYSTEM_PROMPT_PRESETS[style];
	}
}
