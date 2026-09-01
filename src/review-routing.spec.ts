import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	changedReviewFiles,
	loadReviewRoutingConfig,
	planReviewers,
} from './review-routing';

const reviewers = [
	'review-api',
	'review-db',
	'review-docs',
	'review-ops',
	'review-plugin',
	'review-security',
	'review-ui',
];

const config = {
	always: ['review-ops'],
	fallback: ['review-api', 'review-security'],
	rules: {
		'review-api': ['kserp/server/**'],
		'review-db': ['**/*.sql', '**/migrations/**'],
		'review-plugin': ['**/plugin.manifest.json'],
		'review-security': ['**/*auth*/**'],
		'review-ui': ['**/*.tsx', 'ksui/**'],
	},
};

test('review routing selects only matching reviewers plus always reviewers', () => {
	const plan = planReviewers(
		reviewers,
		['hilinga-marketing/src/Pricing.tsx'],
		config,
	);
	expect(plan.mode).toBe('routed');
	expect(plan.reviewers).toEqual(['review-ops', 'review-ui']);
});

test('review routing combines every relevant surface', () => {
	const plan = planReviewers(
		reviewers,
		['kserp/server/auth/session.ts', 'kplugin_counter/migrations/001.sql'],
		config,
	);
	expect(plan.reviewers).toEqual([
		'review-ops',
		'review-api',
		'review-db',
		'review-security',
	]);
});

test('review routing falls back conservatively for unmatched files', () => {
	const plan = planReviewers(reviewers, ['scripts/opaque-tool.mjs'], config);
	expect(plan.mode).toBe('fallback');
	expect(plan.reviewers).toEqual([
		'review-ops',
		'review-api',
		'review-security',
	]);
});

test('review routing falls back when matching rules name unavailable reviewers', () => {
	const plan = planReviewers(reviewers, ['src/View.tsx'], {
		...config,
		always: [],
		rules: {'review-removed': ['**/*.tsx']},
	});
	expect(plan.mode).toBe('fallback');
	expect(plan.reviewers).toEqual(['review-api', 'review-security']);
});

test('full review and missing config preserve all reviewers', () => {
	expect(planReviewers(reviewers, ['x.ts'], config, true).reviewers).toEqual(
		reviewers,
	);
	expect(planReviewers(reviewers, ['x.ts'], undefined).reviewers).toEqual(
		reviewers,
	);
});

test('routing config loads only valid project JSON', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobonyo-review-routing-'));
	mkdirSync(join(root, '.bobonyo'));
	writeFileSync(
		join(root, '.bobonyo', 'review-routing.json'),
		JSON.stringify(config),
	);
	expect(loadReviewRoutingConfig(root)).toEqual(config);
	writeFileSync(join(root, '.bobonyo', 'review-routing.json'), '{bad json');
	expect(loadReviewRoutingConfig(root)).toBeUndefined();
});

test('changed review files include branch and dirty paths', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobonyo-review-files-'));
	Bun.spawnSync(['git', 'init', '-q'], {cwd: root});
	Bun.spawnSync(['git', 'config', 'user.email', 'spec@example.com'], {
		cwd: root,
	});
	Bun.spawnSync(['git', 'config', 'user.name', 'Spec'], {cwd: root});
	writeFileSync(join(root, 'base.txt'), 'base\n');
	Bun.spawnSync(['git', 'add', '.'], {cwd: root});
	Bun.spawnSync(['git', 'commit', '-qm', 'base'], {cwd: root});
	writeFileSync(join(root, 'branch.ts'), 'branch\n');
	Bun.spawnSync(['git', 'add', '.'], {cwd: root});
	Bun.spawnSync(['git', 'commit', '-qm', 'branch'], {cwd: root});
	writeFileSync(join(root, 'dirty.tsx'), 'dirty\n');
	expect(changedReviewFiles(root, 'HEAD~1')).toEqual([
		'branch.ts',
		'dirty.tsx',
	]);
});
