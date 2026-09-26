import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	addPluginMarketplace,
	listPluginMarketplaces,
	installPlugin,
} from './plugins';

const originalConfigDir = process.env.NANOCODER_CONFIG_DIR;
let root = '';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-plugins-'));
	process.env.NANOCODER_CONFIG_DIR = root;
});

afterEach(() => {
	if (originalConfigDir === undefined) delete process.env.NANOCODER_CONFIG_DIR;
	else process.env.NANOCODER_CONFIG_DIR = originalConfigDir;
	rmSync(root, {recursive: true, force: true});
});

describe('plugin marketplaces', () => {
	test('adds and deduplicates GitHub marketplaces', () => {
		addPluginMarketplace('DietrichGebert/ponytail');
		addPluginMarketplace('https://github.com/DietrichGebert/ponytail.git');
		expect(listPluginMarketplaces()).toHaveLength(1);
		expect(listPluginMarketplaces()[0]?.repository).toBe(
			'DietrichGebert/ponytail',
		);
	});

	test('rejects malformed plugin specs before network access', async () => {
		await expect(installPlugin('ponytail')).rejects.toThrow(
			'Expected plugin spec like ponytail@ponytail.',
		);
	});
});
