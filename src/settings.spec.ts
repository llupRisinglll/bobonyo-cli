import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSettings} from './settings';

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
	if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	rmSync(root, {recursive: true, force: true});
});

describe('hideThinking default', () => {
	test('no settings file: defaults ON', () => {
		expect(loadSettings().hideThinking).toBe(true);
	});

	test('existing settings file without the field (pre-default files): defaults ON', () => {
		writeFileSync(join(root, 'settings.json'), JSON.stringify({mode: 'normal'}));
		expect(loadSettings().hideThinking).toBe(true);
	});

	test('explicit off is respected', () => {
		writeFileSync(join(root, 'settings.json'), JSON.stringify({hideThinking: false}));
		expect(loadSettings().hideThinking).toBe(false);
	});

	test('explicit on is respected', () => {
		writeFileSync(join(root, 'settings.json'), JSON.stringify({hideThinking: true}));
		expect(loadSettings().hideThinking).toBe(true);
	});
});

describe('cavemanMode default', () => {
	test('no settings file: defaults ON', () => {
		expect(loadSettings().cavemanMode).toBe(true);
	});

	test('existing settings file without the field (pre-default files): defaults ON', () => {
		writeFileSync(join(root, 'settings.json'), JSON.stringify({mode: 'normal'}));
		expect(loadSettings().cavemanMode).toBe(true);
	});

	test('explicit off is respected', () => {
		writeFileSync(join(root, 'settings.json'), JSON.stringify({cavemanMode: false}));
		expect(loadSettings().cavemanMode).toBe(false);
	});
});
