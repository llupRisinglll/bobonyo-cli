import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	commandSandboxSettings,
	loadSettings,
	resumeCwdDecision,
	saveModeSettings,
	saveSettings,
} from './settings';
import {buildSandboxCommand} from './sandbox';
import {cliMode} from './cli-mode';

const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;
const ORIGINAL_CWD = process.cwd();
const MODE_ENV_KEYS = [
	'BOBONYO_CONFIG_DIR',
	'BOBONYO_MODE',
	'NANOCODER_MODE',
] as const;
let originalModeEnv: Record<string, string | undefined> = {};
let root = '';

beforeEach(() => {
	originalModeEnv = Object.fromEntries(
		MODE_ENV_KEYS.map(key => [key, process.env[key]]),
	);
	for (const key of MODE_ENV_KEYS) delete process.env[key];
	root = mkdtempSync(join(tmpdir(), 'bobonyo-settings-'));
	process.env.NANOCODER_CONFIG_DIR = root;
	process.chdir(root);
});

afterEach(() => {
	for (const key of MODE_ENV_KEYS) {
		if (originalModeEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalModeEnv[key];
	}
	process.chdir(ORIGINAL_CWD);
	if (ORIGINAL_CONFIG_DIR === undefined)
		delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	rmSync(root, {recursive: true, force: true});
});

describe('thinkingMode default (hidden / show / line)', () => {
	test('no settings file: defaults to hidden (legacy hide-thinking-on default)', () => {
		expect(loadSettings().thinkingMode).toBe('hidden');
	});

	test('existing settings file without the field: defaults to hidden', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({mode: 'normal'}),
		);
		expect(loadSettings().thinkingMode).toBe('hidden');
	});

	test('migrates the legacy hideThinking flag: true → hidden, false → show', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({hideThinking: false}),
		);
		expect(loadSettings().thinkingMode).toBe('show');
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({hideThinking: true}),
		);
		expect(loadSettings().thinkingMode).toBe('hidden');
	});

	test('thinkingMode wins over the legacy flag', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({thinkingMode: 'line', hideThinking: true}),
		);
		expect(loadSettings().thinkingMode).toBe('line');
	});

	test('show and line are respected', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({thinkingMode: 'show'}),
		);
		expect(loadSettings().thinkingMode).toBe('show');
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({thinkingMode: 'line'}),
		);
		expect(loadSettings().thinkingMode).toBe('line');
	});
	test('an invalid saved mode falls back to hidden (never garbage)', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({thinkingMode: 'bogus'}),
		);
		expect(loadSettings().thinkingMode).toBe('hidden');
	});
});

describe('cavemanMode default', () => {
	test('no settings file: defaults ON', () => {
		expect(loadSettings().cavemanMode).toBe(true);
	});

	test('existing settings file without the field (pre-default files): defaults ON', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({mode: 'normal'}),
		);
		expect(loadSettings().cavemanMode).toBe(true);
	});

	test('explicit off is respected', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({cavemanMode: false}),
		);
		expect(loadSettings().cavemanMode).toBe(false);
	});
});

describe('resumeCwd (codex ResumeCwdMode parity)', () => {
	test('defaults to session (cache-friendly resume)', () => {
		expect(loadSettings().resumeCwd).toBe('session');
	});

	test('a saved mode is respected and invalid values fall back', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({resumeCwd: 'ask'}),
		);
		expect(loadSettings().resumeCwd).toBe('ask');
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({resumeCwd: 'bogus'}),
		);
		expect(loadSettings().resumeCwd).toBe('session');
	});
});

describe('autoCompact default (cache-head protection)', () => {
	test('defaults ON so long conversations compact before the cap trims', () => {
		expect(loadSettings().autoCompact.enabled).toBe(true);
		expect(loadSettings().autoCompact.threshold).toBe(80);
	});

	test('an explicit off is respected', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({autoCompact: {enabled: false, threshold: 80}}),
		);
		expect(loadSettings().autoCompact.enabled).toBe(false);
		expect(loadSettings().autoCompact.threshold).toBe(80);
	});
});

describe('resumeCwdDecision (which directory a resumed session uses)', () => {
	test('session mode always restores the session directory', () => {
		expect(resumeCwdDecision('session', '/a', '/b')).toBe('session');
		expect(resumeCwdDecision('session', '/a', '/a')).toBe('session');
	});

	test('current mode keeps the launch directory even when they differ', () => {
		expect(resumeCwdDecision('current', '/a', '/b')).toBe('current');
		expect(resumeCwdDecision('current', '/a', undefined)).toBe('current');
	});

	test('ask defers to the user ONLY when the directories differ', () => {
		expect(resumeCwdDecision('ask', '/a', '/b')).toBe('ask');
		expect(resumeCwdDecision('ask', '/a', '/a')).toBe('session');
	});

	test('a missing session directory always keeps the current one', () => {
		expect(resumeCwdDecision('session', '/a', undefined)).toBe('current');
		expect(resumeCwdDecision('ask', '/a', undefined)).toBe('current');
	});
});

describe('model fallback default', () => {
	test('defaults OFF and respects explicit ON', () => {
		expect(loadSettings().modelFallback).toBe(false);
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({modelFallback: true}),
		);
		expect(loadSettings().modelFallback).toBe(true);
	});
});

describe('command sandbox defaults', () => {
	test('fresh default keeps bubblewrap isolation when available', () => {
		const settings = loadSettings();
		expect(settings.mode).toBe('default');
		const sandbox = buildSandboxCommand(
			'true',
			root,
			commandSandboxSettings(settings),
			true,
			root,
		);
		expect(sandbox.active).toBe(true);
		expect(sandbox.argv).toContain('--ro-bind');
	});
	test('legacy saved yolo migrates without disabling its sandbox', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({
				mode: 'yolo',
				sandbox: {mode: 'workspace-write', network: false, writablePaths: []},
			}),
		);
		const settings = loadSettings();
		expect(settings.mode).toBe('default');
		expect(commandSandboxSettings(settings).mode).toBe('workspace-write');
		saveSettings(settings);
		expect(loadSettings().mode).toBe('default');
	});
	test('--yolo disables even read-only sandbox without erasing saved preferences', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({
				mode: 'normal',
				sandbox: {mode: 'read-only', network: false, writablePaths: []},
			}),
		);
		process.env.BOBONYO_MODE = cliMode(['--yolo']);
		const settings = loadSettings();
		expect(settings.mode).toBe('yolo');
		expect(settings.sandbox?.mode).toBe('read-only');
		expect(
			buildSandboxCommand(
				'true',
				root,
				commandSandboxSettings(settings),
				true,
				root,
			),
		).toMatchObject({
			active: false,
			backend: 'none',
			argv: ['bash', '-c', 'true'],
		});
		saveSettings(settings);
		delete process.env.BOBONYO_MODE;
		expect(loadSettings().mode).toBe('yolo');
		expect(commandSandboxSettings().mode).toBe('off');
		saveModeSettings('default');
		expect(commandSandboxSettings().mode).toBe('read-only');
	});
	test('switching modes supersedes a launch override and restores sandbox', () => {
		process.env.BOBONYO_MODE = 'yolo';
		saveModeSettings('default');
		expect(loadSettings().mode).toBe('default');
		expect(commandSandboxSettings().mode).toBe('auto');
	});
	test('defaults to portable workspace-write isolation with network', () => {
		expect(loadSettings().sandbox).toEqual({
			mode: 'auto',
			network: true,
			writablePaths: [],
		});
	});

	test('validates mode and writable path entries', () => {
		writeFileSync(
			join(root, 'settings.json'),
			JSON.stringify({
				sandbox: {
					mode: 'bogus',
					network: false,
					writablePaths: ['/cache', 7, ''],
				},
			}),
		);
		expect(loadSettings().sandbox).toEqual({
			mode: 'auto',
			network: false,
			writablePaths: ['/cache'],
		});
	});
});
