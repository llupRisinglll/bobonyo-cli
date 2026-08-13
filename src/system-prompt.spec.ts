import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	loadCustomSystemPrompt,
	resolveSystemPrompt,
	seedCustomSystemPrompt,
	SYSTEM_PROMPT_PRESETS,
	systemPromptPath,
} from './system-prompt';

const ORIGINAL_CONFIG_DIR = process.env.BOBONYO_CONFIG_DIR;
let configDir: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'bobonyo-system-prompt-spec-'));
	process.env.BOBONYO_CONFIG_DIR = configDir;
});

afterEach(() => {
	if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.BOBONYO_CONFIG_DIR;
	else process.env.BOBONYO_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	rmSync(configDir, {recursive: true, force: true});
});

const DEFAULT_PROMPT = 'You are BoboNyo, a terminal coding agent. Be concise.';

describe('system prompt styles', () => {
	test('default returns the built-in prompt untouched', () => {
		expect(resolveSystemPrompt('default', DEFAULT_PROMPT)).toBe(
			DEFAULT_PROMPT,
		);
	});

	test('presets carry the REAL tool prompts (opencode/codex/claude-code)', () => {
		// opencode: its actual verbosity + no-preamble rules.
		expect(SYSTEM_PROMPT_PRESETS.opencode).toMatch(/Minimize output tokens/);
		expect(SYSTEM_PROMPT_PRESETS.opencode).toMatch(/under 4 lines/);
		expect(SYSTEM_PROMPT_PRESETS.opencode).toMatch(/unnecessary preamble or postamble/);
		// openclaude / Claude Code: no gold-plating + diagnose-before-switching.
		expect(SYSTEM_PROMPT_PRESETS.claudecode).toMatch(/beyond what was asked/);
		expect(SYSTEM_PROMPT_PRESETS.claudecode).toMatch(/diagnose why before switching tactics/);
		expect(SYSTEM_PROMPT_PRESETS.claudecode).toMatch(/prompt injection/);
		// Codex CLI: personality + working rules.
		expect(SYSTEM_PROMPT_PRESETS.codex).toMatch(/Call out weak ideas directly/);
		expect(SYSTEM_PROMPT_PRESETS.codex).toMatch(/rg, rg --files/);
		// The harness tool rule survives in every preset.
		for (const body of Object.values(SYSTEM_PROMPT_PRESETS)) {
			expect(body).toMatch(/Before each tool call/);
		}
		expect(new Set(Object.values(SYSTEM_PROMPT_PRESETS)).size).toBe(3);
	});

	test('custom falls back to the default until SYSTEM.md exists', () => {
		expect(systemPromptPath()).toBe(join(configDir, 'SYSTEM.md'));
		expect(loadCustomSystemPrompt()).toBeNull();
		expect(resolveSystemPrompt('custom', DEFAULT_PROMPT)).toBe(
			DEFAULT_PROMPT,
		);
	});

	test('selecting custom SEEDS SYSTEM.md and it is then loaded', () => {
		seedCustomSystemPrompt(DEFAULT_PROMPT);
		expect(existsSync(systemPromptPath())).toBe(true);
		expect(readFileSync(systemPromptPath(), 'utf8')).toContain('BoboNyo');
		expect(loadCustomSystemPrompt()).toContain('BoboNyo');
		expect(resolveSystemPrompt('custom', DEFAULT_PROMPT)).toContain(
			'BoboNyo',
		);
	});
});
