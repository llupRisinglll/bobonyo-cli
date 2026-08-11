/**
 * Steering (InnerDaemon), parity flavor of nanocoder's B5/B15 integration.
 *
 * Rules come from `steering.json` in the config dir:
 *   { "enabled": true, "rules": [
 *     { "id": "block-secrets", "match": {"keyword": "forbidden"}, "action": "block",
 *       "message": "This task is blocked by policy." },
 *     { "id": "add-tests", "match": {"keyword": "add context"}, "action": "inject",
 *       "inject": "Remember to mention unit tests in your answer." }
 *   ] }
 *
 * Preflight runs at turn start (block/inject/stop/noop); a within-turn
 * watchdog (B5) aborts turns that outlive `watchdogMs` with an auditable row.
 */

import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export interface SteeringRule {
	id: string;
	match: {keyword?: string; intent?: string; tool?: string};
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
}

export function loadSteeringConfig(): SteeringConfig {
	const base =
		process.env.NANOCODER_CONFIG_DIR ??
		join(homedir(), '.local', 'share', 'bobonyo');
	try {
		const file = join(base, 'steering.json');
		if (existsSync(file)) {
			const parsed = JSON.parse(readFileSync(file, 'utf8')) as SteeringConfig;
			return {
				enabled: parsed.enabled !== false,
				rules: Array.isArray(parsed.rules) ? parsed.rules : [],
			};
		}
	} catch {
		// fall through to disabled
	}
	return {enabled: false, rules: []};
}

/** Keyword-based intent classification (the mock-friendly subset). */
export function classifyIntent(prompt: string): string {
	const text = prompt.toLowerCase();
	if (text.includes('worktree')) return 'worktree';
	if (text.includes('test')) return 'testing';
	if (text.includes('pr') || text.includes('pull request')) return 'pr';
	if (text.includes('web')) return 'web';
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
		if (rule.match?.keyword && prompt.toLowerCase().includes(rule.match.keyword)) {
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
	}
	return null;
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
