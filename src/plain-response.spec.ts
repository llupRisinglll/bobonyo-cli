import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSystemParts} from './client';
import {cavemanMode, setCavemanMode} from './state';
import {SYSTEM_PROMPT_STYLES} from './system-prompt';

const HEADING = '## Plain, actionable responses';
let originalConfig: string | undefined;
let originalCaveman: boolean;
let configDir: string;

beforeEach(() => {
	originalConfig = process.env.BOBONYO_CONFIG_DIR;
	originalCaveman = cavemanMode();
	configDir = mkdtempSync(join(tmpdir(), 'bobonyo-plain-response-'));
	process.env.BOBONYO_CONFIG_DIR = configDir;
});

afterEach(() => {
	setCavemanMode(originalCaveman);
	if (originalConfig === undefined) delete process.env.BOBONYO_CONFIG_DIR;
	else process.env.BOBONYO_CONFIG_DIR = originalConfig;
	rmSync(configDir, {recursive: true, force: true});
});

describe('always-on plain response guidance', () => {
	test('checklist bookkeeping stays in tools, not repeated assistant prose', () => {
		const {stable} = buildSystemParts();
		expect(stable).toContain('Checklist bookkeeping is silent');
		expect(stable).toContain(
			'no prose announcement, confirmation, or task-list recap',
		);
		expect(stable).toContain(
			'actual outcome, concrete blocker, or next action',
		);
		expect(stable).toContain('explicitly asks for a task summary');
	});
	test('every tool profile includes stable guidance with caveman on or off', () => {
		for (const profile of ['full', 'minimal', 'nano', 'auto']) {
			for (const enabled of [true, false]) {
				setCavemanMode(enabled);
				const first = buildSystemParts(profile);
				expect(first.stable).toContain(HEADING);
				expect(first.volatile).not.toContain(HEADING);
				expect(buildSystemParts(profile).stable).toBe(first.stable);
				if (enabled) {
					expect(first.stable.indexOf(HEADING)).toBeGreaterThan(
						first.stable.indexOf('## CAVEMAN MODE'),
					);
				}
			}
		}
	});

	test('presets and custom SYSTEM.md cannot replace built-in clarity guidance', () => {
		writeFileSync(join(configDir, 'SYSTEM.md'), 'Custom voice: terse.');
		for (const style of SYSTEM_PROMPT_STYLES) {
			writeFileSync(
				join(configDir, 'settings.json'),
				JSON.stringify({systemPrompt: style}),
			);
			const {stable} = buildSystemParts();
			expect(stable).toContain(HEADING);
			if (style === 'custom') expect(stable).toContain('Custom voice: terse.');
		}
	});

	test('guidance prioritizes actionable clarity over compressed status recaps', () => {
		const {stable} = buildSystemParts();
		expect(stable).toContain('Clarity takes precedence over caveman');
		expect(stable).toContain('Lead with the useful answer or next action');
		expect(stable).toContain('short numbered steps when order matters');
		expect(stable).toContain('Do not repeat status recaps');
		expect(stable).toContain('Preserve necessary technical detail');
	});

	test('blockers require concrete cause, impact, ownership, and honest recovery state', () => {
		const {stable} = buildSystemParts();
		expect(stable).toContain('concrete cause, what it prevents');
		expect(stable).toContain('next action you will take');
		expect(stable).toContain('one necessary choice or missing input');
		expect(stable).toContain('Do safe, authorized recovery yourself');
		expect(stable).toContain('Separate verified facts from unknowns');
		expect(stable).toContain('Never describe planned recovery as completed');
	});
	test('port conflicts require safe alternatives before escalation across all styles', () => {
		writeFileSync(join(configDir, 'SYSTEM.md'), 'Custom voice: terse.');
		for (const style of SYSTEM_PROMPT_STYLES) {
			writeFileSync(
				join(configDir, 'settings.json'),
				JSON.stringify({systemPrompt: style}),
			);
			const {stable} = buildSystemParts();
			expect(stable).toContain('Before declaring work blocked');
			expect(stable).toContain('unused port');
			expect(stable).toContain('health checks and browser/test URLs');
			expect(stable).toContain('Do not stop or restart its owner');
			expect(stable).toContain('explicit denials or project constraints');
			expect(stable).toContain('recommend a concrete remedy');
			expect(stable).toContain('Do not merely say approval is needed');
			expect(stable).toContain('verify the original blocked check');
		}
	});

	test('internal output contracts win without coupling clarity to caveman', () => {
		const {stable} = buildSystemParts(undefined, {disableCaveman: true});
		expect(stable).toContain(HEADING);
		expect(stable).not.toContain('## CAVEMAN MODE');
		expect(stable).toContain(
			'not internal JSON, tool arguments, or summarization requests',
		);
		expect(stable).toContain(
			'Required output formats and task-specific instructions win',
		);
	});

	test('guidance avoids forced user tasks, invented timing, and personal diagnoses', () => {
		const {stable} = buildSystemParts();
		expect(stable).toContain('Do not manufacture user tasks');
		expect(stable).toContain('Do not invent duration estimates');
		expect(stable).toContain('Do not infer diagnoses or medical needs');
	});
});
