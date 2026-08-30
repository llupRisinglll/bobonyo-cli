/**
 * Steering (InnerDaemon), parity flavor of nanocoder's B5/B15 integration.
 *
 * Rules come from `steering.json` and markdown `.steer.md` files in config
 * dirs. Preflight runs at turn start; tool constraints run before dispatch.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadSkills, parseCommandFile} from './custom';
import {configSearchDirs} from './project-paths';

export interface SteeringRule {
	id: string;
	match: {keyword?: string; intent?: string; tool?: string; path?: string};
	action: 'noop' | 'block' | 'stop' | 'inject';
	message?: string;
	inject?: string;
}

export interface SteeringConfig {
	enabled: boolean;
	rules: SteeringRule[];
}

export interface SteeringFacts {
	intent: string;
	model: string;
	budgetTurns: number;
	totalBudget: number;
	backgroundTasksRunning: boolean;
	toolInput?: Record<string, unknown>;
}

export function loadSteeringConfig(): SteeringConfig {
	const rules: SteeringRule[] = [];
	let enabled = false;
	for (const base of configSearchDirs()) {
		try {
			const file = join(base, 'steering.json');
			if (existsSync(file)) {
				const parsed = JSON.parse(readFileSync(file, 'utf8')) as SteeringConfig;
				enabled = parsed.enabled !== false;
				if (Array.isArray(parsed.rules)) rules.push(...parsed.rules);
			}
		} catch {
			// Corrupt settings never break the harness.
		}
		rules.push(...loadMarkdownSteeringRules(base));
	}
	return rules.length > 0
		? {enabled: enabled || rules.length > 0, rules}
		: {enabled: false, rules: []};
}

function loadMarkdownSteeringRules(base: string): SteeringRule[] {
	const dir = join(base, 'steering');
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, {withFileTypes: true})) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith('.steer.md')) files.push(path);
		}
	};
	try {
		walk(dir);
	} catch {
		return [];
	}
	return files.sort().flatMap(file => markdownRule(file));
}

function markdownRule(file: string): SteeringRule[] {
	try {
		const source = readFileSync(file, 'utf8');
		const {frontmatter, body} = parseCommandFile(source);
		const id = typeof frontmatter.id === 'string' ? frontmatter.id : '';
		if (!id) return [];
		const conditionText = steeringConditionBlock(source);
		const match: SteeringRule['match'] = {};
		const intent = scalarField(conditionText, 'intentClass');
		const path = scalarField(conditionText, 'pathMatches');
		if (intent) match.intent = intent;
		if (path) match.path = path;
		const mode =
			typeof frontmatter.mode === 'string' ? frontmatter.mode : 'announce';
		const injectSkill =
			typeof frontmatter.injectSkill === 'string'
				? frontmatter.injectSkill
				: '';
		const skill = injectSkill
			? loadSkills().find(
					candidate =>
						candidate.name.toLowerCase() === injectSkill.toLowerCase(),
				)
			: null;
		const inject = skill?.body.trim() || body.trim();
		return [
			{
				id,
				match,
				action: mode === 'innerdaemon' ? 'noop' : 'inject',
				inject,
			},
		];
	} catch {
		return [];
	}
}

function steeringConditionBlock(source: string): string {
	const match = /\ncondition:\s*\n([\s\S]*?)(?:\n(?:watch:|---)|$)/.exec(
		source,
	);
	return match?.[1] ?? '';
}

function scalarField(source: string, key: string): string | undefined {
	const match = new RegExp(`^\\s*${key}:\\s*['\"]?([^'\"\\n]+)`, 'm').exec(
		source,
	);
	return match?.[1]?.trim();
}

/** Keyword-based intent classification. */
export function classifyIntent(prompt: string): string {
	const text = prompt.toLowerCase();
	if (
		/\.tsx|\.css|solidjs|solid js|ui|frontend|modal|component|theme/.test(text)
	)
		return 'frontend-edit';
	if (/migration|schema|rls|create table|alter table/.test(text))
		return 'migration-sql';
	if (/deploy|release|changeset|staging|main/.test(text))
		return 'branch-release';
	if (/ci|workflow|runner|gh pr checks|plugin_token/.test(text)) return 'ci';
	if (/prod|production|pm2|ssh|\/opt\/kserp/.test(text)) return 'prod-ops';
	if (/worktree/.test(text)) return 'worktree-creation';
	if (/test|verify|typecheck|vitest|lint/.test(text)) return 'verify';
	if (/pr|pull request|gh pr create/.test(text)) return 'pr-create';
	if (/web|playwright|screenshot|browser/.test(text)) return 'playwright-ui';
	return 'unknown';
}

export function evaluateSteering(
	prompt: string,
	config: SteeringConfig,
	facts: SteeringFacts,
): {rule: SteeringRule; intent: string} | null {
	if (!config.enabled) return null;
	const intent = classifyIntent(prompt);
	for (const rule of config.rules) {
		if (
			rule.match?.keyword &&
			prompt.toLowerCase().includes(rule.match.keyword)
		) {
			return {rule, intent};
		}
		if (rule.match?.intent && rule.match.intent === intent) {
			return {rule, intent};
		}
	}
	return null;
}

/** Tool-call constraint evaluation (B15 preflight block before dispatch). */
export function evaluateToolConstraint(
	toolName: string,
	config: SteeringConfig,
	facts: SteeringFacts,
): {rule: SteeringRule; intent: string} | null {
	if (!config.enabled) return null;
	for (const rule of config.rules) {
		if (
			rule.match?.tool &&
			(rule.match.tool === toolName ||
				rule.match.tool.toLowerCase() === toolName.toLowerCase())
		) {
			return {rule, intent: facts.intent};
		}
		const path =
			typeof facts.toolInput?.path === 'string' ? facts.toolInput.path : '';
		if (rule.match?.path && path && globMatches(rule.match.path, path)) {
			return {rule, intent: facts.intent};
		}
	}
	return null;
}

function globMatches(pattern: string, value: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '.*')
		.replace(/\*/g, '[^/]*');
	return new RegExp(`^${escaped}$`).test(value);
}

export function formatInnerDaemonRow(
	ruleId: string,
	action: string,
	facts: SteeringFacts,
): string {
	return (
		`InnerDaemon · intent=${facts.intent} · rule=${ruleId} · ` +
		`budget ${facts.budgetTurns}/${facts.totalBudget} · model=${facts.model} · ${action}`
	);
}
