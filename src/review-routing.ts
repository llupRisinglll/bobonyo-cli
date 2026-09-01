import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';

export interface ReviewRoutingConfig {
	always?: string[];
	fallback?: string[];
	rules?: Record<string, string[]>;
}

export interface ReviewRoutingPlan {
	reviewers: string[];
	changedFiles: string[];
	mode: 'all' | 'routed' | 'fallback';
}

export interface ReviewRoutingSource {
	config: ReviewRoutingConfig;
	configDir: string;
}

function names(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.map(String)
				.map(name => name.trim())
				.filter(Boolean)
		: [];
}

function parseConfig(value: unknown): ReviewRoutingConfig | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return undefined;
	const source = value as Record<string, unknown>;
	const rules =
		source.rules &&
		typeof source.rules === 'object' &&
		!Array.isArray(source.rules)
			? Object.fromEntries(
					Object.entries(source.rules as Record<string, unknown>).map(
						([reviewer, patterns]) => [reviewer, names(patterns)],
					),
				)
			: undefined;
	return {
		always: names(source.always),
		fallback: names(source.fallback),
		rules,
	};
}

/** Project-level routing is opt-in. Invalid config deliberately disables it. */
export function findReviewRoutingConfig(
	startDir: string,
): ReviewRoutingSource | undefined {
	let dir = resolve(startDir);
	for (;;) {
		const configDir = join(dir, '.bobonyo');
		const path = join(configDir, 'review-routing.json');
		if (existsSync(path)) {
			try {
				const config = parseConfig(JSON.parse(readFileSync(path, 'utf8')));
				if (config) return {config, configDir};
			} catch {
				// Invalid nearest config must not prevent a valid parent policy.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export function loadReviewRoutingConfig(
	startDir: string,
): ReviewRoutingConfig | undefined {
	return findReviewRoutingConfig(startDir)?.config;
}

/** Convert nested Git-root paths to the project config's path namespace. */
export function scopeReviewPaths(
	changedFiles: string[],
	repositoryRoot: string,
	configDir: string,
): string[] {
	const prefix = relative(dirname(configDir), repositoryRoot);
	return changedFiles.map(file => (prefix ? join(prefix, file) : file));
}

function globPattern(pattern: string): RegExp {
	let source = '^';
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === '*') {
			if (pattern[index + 1] === '*') {
				index++;
				if (pattern[index + 1] === '/') {
					index++;
					source += '(?:.*/)?';
				} else source += '.*';
			} else source += '[^/]*';
		} else if (char === '?') source += '[^/]';
		else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
	}
	return new RegExp(`${source}$`);
}

function configuredNames(names: string[], configured: string[]): string[] {
	const byLowercase = new Map(
		configured.map(name => [name.toLowerCase(), name]),
	);
	return [
		...new Set(
			names.map(name => byLowercase.get(name.toLowerCase())).filter(Boolean),
		),
	] as string[];
}

/**
 * Select reviewers only when project config names matching path scopes.
 * No config, malformed config, or an explicit full review retains all agents.
 */
export function planReviewers(
	configured: string[],
	changedFiles: string[],
	config: ReviewRoutingConfig | undefined,
	all = false,
): ReviewRoutingPlan {
	if (all || !config) return {reviewers: configured, changedFiles, mode: 'all'};
	const matched = Object.entries(config.rules ?? {})
		.filter(([, patterns]) =>
			patterns.some(pattern => {
				const matcher = globPattern(pattern);
				return changedFiles.some(file => matcher.test(file));
			}),
		)
		.map(([reviewer]) => reviewer);
	if (matched.length) {
		const reviewers = configuredNames(
			[...names(config.always), ...matched],
			configured,
		);
		if (reviewers.length) return {reviewers, changedFiles, mode: 'routed'};
	}
	return {
		reviewers: configuredNames(
			[...names(config.always), ...names(config.fallback)],
			configured,
		),
		changedFiles,
		mode: 'fallback',
	};
}

function gitOutput(root: string, args: string[]): string[] | undefined {
	try {
		const result = Bun.spawnSync(['git', ...args], {cwd: root});
		if (result.exitCode !== 0) return undefined;
		return result.stdout
			.toString()
			.split('\n')
			.map(file => file.trim())
			.filter(Boolean);
	} catch {
		return undefined;
	}
}

/** Include branch diff plus staged and unstaged work relevant to review. */
export function changedReviewFiles(
	root: string,
	base: string,
): string[] | undefined {
	const branch = gitOutput(root, ['diff', '--name-only', `${base}...HEAD`]);
	if (!branch) return undefined;
	const staged = gitOutput(root, ['diff', '--name-only', '--cached']) ?? [];
	const unstaged = gitOutput(root, ['diff', '--name-only']) ?? [];
	const untracked =
		gitOutput(root, ['ls-files', '--others', '--exclude-standard']) ?? [];
	return [...new Set([...branch, ...staged, ...unstaged, ...untracked])].sort();
}
