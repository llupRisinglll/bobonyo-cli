import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	evaluateSteering,
	evaluateToolConstraint,
	loadSteeringConfig,
} from './steering';

const ORIGINAL_CONFIG = process.env.BOBONYO_CONFIG_DIR;
const ORIGINAL_CWD = process.cwd();
let root = '';

function setup(): string {
	root = mkdtempSync(join(tmpdir(), 'bobonyo-steering-'));
	process.env.BOBONYO_CONFIG_DIR = root;
	mkdirSync(join(root, 'steering'), {recursive: true});
	return root;
}

afterEach(() => {
	process.chdir(ORIGINAL_CWD);
	if (ORIGINAL_CONFIG === undefined) delete process.env.BOBONYO_CONFIG_DIR;
	else process.env.BOBONYO_CONFIG_DIR = ORIGINAL_CONFIG;
	if (root) rmSync(root, {recursive: true, force: true});
	root = '';
});

describe('markdown steering rules', () => {
	test('loads announce .steer.md rules from config steering dir', () => {
		const dir = setup();
		writeFileSync(
			join(dir, 'steering', 'screenshots.steer.md'),
			`---
id: hilinga-screenshots
mode: announce
condition:
  intentClass: playwright-ui
---
Screenshot rule body.
`,
		);
		const config = loadSteeringConfig();
		expect(config.enabled).toBe(true);
		expect(config.rules).toHaveLength(1);
		expect(config.rules[0]).toMatchObject({
			id: 'hilinga-screenshots',
			action: 'inject',
			match: {intent: 'playwright-ui'},
			inject: 'Screenshot rule body.',
		});
	});

	test('injectSkill .steer.md rules load the named skill body', () => {
		const dir = setup();
		mkdirSync(join(dir, 'skills'), {recursive: true});
		writeFileSync(join(dir, 'skills', 'frontend-discipline.md'), 'UI rules.');
		writeFileSync(
			join(dir, 'steering', 'frontend.steer.md'),
			`---
id: hilinga-frontend-preferences
mode: announce
injectSkill: frontend-discipline
condition:
  intentClass: frontend-edit
---
<!-- no literal body -->
`,
		);
		const match = evaluateSteering(
			'edit this SolidJS .tsx component',
			loadSteeringConfig(),
			{
				intent: 'unknown',
				model: 'mimo',
				budgetTurns: 0,
				totalBudget: 10,
				backgroundTasksRunning: false,
			},
		);
		expect(match?.rule.id).toBe('hilinga-frontend-preferences');
		expect(match?.rule.inject).toContain('UI rules.');
	});

	test('pathMatches .steer.md rules match tool path arguments', () => {
		const dir = setup();
		writeFileSync(
			join(dir, 'steering', 'manifest.steer.md'),
			`---
id: hilinga-manifest-tier
mode: announce
condition:
  pathMatches: '**/plugin.manifest.json'
---
Manifest tier reminder.
`,
		);
		const match = evaluateToolConstraint('write_file', loadSteeringConfig(), {
			intent: 'unknown',
			model: 'mimo',
			budgetTurns: 1,
			totalBudget: 10,
			backgroundTasksRunning: false,
			toolInput: {path: 'kplugin_counter/plugin.manifest.json'},
		});
		expect(match?.rule.id).toBe('hilinga-manifest-tier');
		expect(match?.rule.inject).toBe('Manifest tier reminder.');
	});
});
