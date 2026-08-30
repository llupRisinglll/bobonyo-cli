import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSettings, resumeCwdDecision} from './settings';

const ORIGINAL_CONFIG_DIR = process.env.NANOCODER_CONFIG_DIR;
const ORIGINAL_CWD = process.cwd();
let root = '';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-settings-'));
	process.env.NANOCODER_CONFIG_DIR = root;
	process.chdir(root);
});

afterEach(() => {
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
